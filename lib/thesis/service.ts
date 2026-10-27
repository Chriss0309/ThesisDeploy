import { randomUUID } from "node:crypto";

import { ReauthRequiredError } from "@/lib/auth/vault";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { marketForCurrency, marketStatus } from "@/lib/market-hours";
import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { getSnapshot, loadOverview } from "@/lib/portfolio/service";
import type { PortfolioAccount } from "@/lib/portfolio/types";
import { THESIS_PRESETS, type ThesisPreset } from "@/lib/presets";
import { SnapTradeError, hashAccountId, type SnapTradeContext } from "@/lib/snaptrade/client";
import { decideBudget, readBudgetWindow } from "@/lib/snaptrade/rate-budget";
import { DEFAULT_SLIPPAGE_BUFFER } from "@/lib/solver";
import { recordEvent, type EventOwner } from "@/lib/telemetry/events";
import { composeBasket, type Composition } from "@/lib/thesis/compose";
import {
  ThesisGenerationError,
  anthropicCreateMessage,
  generateThesis,
  type CreateMessage,
  type Generation,
} from "@/lib/thesis/generate";
import { groundCandidates, type GroundedCandidate, type QuoteSource } from "@/lib/thesis/grounding";
import { normalizeOutput, type NormalizedThesis } from "@/lib/thesis/normalize";
import { collectPortfolio, type AccountWithSnapshot, type PortfolioView } from "@/lib/thesis/portfolio";
import type { ContextInput } from "@/lib/thesis/prompt";
import { DEMO_QUOTES, demoQuoteSource, demoUniverse, snapTradeQuoteSource } from "@/lib/thesis/quote-sources";
import {
  GUEST_GENERATIONS_PER_CLIENT_PER_DAY,
  USER_GENERATIONS_PER_DAY,
  reserveGeneration,
} from "@/lib/thesis/rate-limit";
import samples from "@/lib/thesis/sample-outputs.json";
import { ThesisOutputSchema, type ThesisOutput, type ThesisRequest } from "@/lib/thesis/schema";
import { findCachedGuestThesis, saveThesis } from "@/lib/thesis/store";
import type { ComposerPayload, ThesisSource } from "@/lib/thesis/types";

const PRESET_CACHE_MS = 7 * 24 * 3600 * 1000;
const GUEST_PROMPT_CACHE_MS = 24 * 3600 * 1000;

export class ThesisError extends Error {
  name = "ThesisError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export type ThesisDeps = { createMessage?: CreateMessage; model?: string; now?: () => Date };

function generationDeps(deps: ThesisDeps) {
  const env = serverEnv();
  const createMessage =
    deps.createMessage ?? (env.ANTHROPIC_API_KEY ? anthropicCreateMessage(env.ANTHROPIC_API_KEY) : null);
  return { createMessage, model: deps.model ?? env.ANTHROPIC_MODEL };
}

const waitText = (seconds: number | null) =>
  seconds && seconds > 90 ? `about ${Math.ceil(seconds / 3600)} hours` : `${Math.max(1, Math.ceil(seconds ?? 60))} seconds`;

function generationFailure(error: ThesisGenerationError): ThesisError {
  switch (error.code) {
    case "refusal":
      return new ThesisError("refused", 422, "ThesisDeploy's AI declined this request. Try rephrasing it as an investment theme.");
    case "overloaded":
      return new ThesisError("model_busy", 503, "ThesisDeploy's AI is busy right now. Try again in a minute.", 60);
    default:
      return new ThesisError("generation_failed", 502, "ThesisDeploy's AI didn't return a usable basket. Try again.");
  }
}

type Pipeline = {
  normalized: NormalizedThesis;
  grounded: GroundedCandidate[];
  composition: Composition;
  marketOpen: boolean;
};

/** Normalize, ground, and size one structured output. */
async function runPipeline(
  output: ThesisOutput,
  request: ThesisRequest,
  portfolio: PortfolioView,
  source: QuoteSource,
  now: Date,
): Promise<Pipeline> {
  const normalized = normalizeOutput(output);
  if (!normalized.onTopic) {
    throw new ThesisError(
      "off_topic",
      422,
      "That doesn't read like an investment theme. Describe a trend or conviction, e.g. one of the presets.",
    );
  }
  const market = marketForCurrency(request.currency) ?? "NYSE";
  const marketOpen = marketStatus(market, now).open;
  const { candidates: grounded } = await groundCandidates(normalized.candidates, request.currency, source);
  const composition = composeBasket({
    candidates: grounded,
    portfolio,
    budget: request.budget,
    currency: request.currency,
    overlapMode: request.overlapMode,
    marketOpen,
  });
  return { normalized, grounded, composition, marketOpen };
}

function toPayload(args: {
  id: string | null;
  ref: string;
  request: ThesisRequest;
  account: PortfolioAccount;
  pipeline: Pipeline;
  portfolio: PortfolioView;
  model: string;
  latencyMs: number | null;
  source: ThesisSource;
  generatedAt: Date;
  pricing: ComposerPayload["pricing"]["source"];
  pricedAt: string;
}): ComposerPayload {
  const { request, pipeline } = args;
  return {
    thesis: {
      id: args.id,
      ref: args.ref,
      title: pipeline.normalized.title,
      summary: pipeline.normalized.summary,
      riskProfile: pipeline.normalized.riskProfile,
      prompt: request.prompt,
      presetKey: request.presetKey ?? null,
      model: args.model,
      latencyMs: args.latencyMs,
      source: args.source,
      generatedAt: args.generatedAt.toISOString(),
    },
    account: {
      id: args.account.id,
      name: args.account.name,
      institution: args.account.institution,
      isPaper: args.account.isPaper,
    },
    currency: request.currency,
    budget: request.budget,
    overlapMode: request.overlapMode,
    slippageBuffer: DEFAULT_SLIPPAGE_BUFFER,
    pricing: {
      source: args.pricing,
      market: marketForCurrency(request.currency) ?? "NYSE",
      marketOpen: pipeline.marketOpen,
      asOf: args.pricedAt,
    },
    lines: pipeline.composition.lines,
    dropped: [...pipeline.composition.dropped, ...pipeline.normalized.rejected],
    excluded: pipeline.normalized.excluded,
    notices: args.portfolio.unavailable.map(
      (name) => `Couldn't load holdings for ${name}, so overlap with that account isn't checked.`,
    ),
  };
}

/**
 * One `thesis_generated` and one `symbols_resolved` per basket shown to
 * someone, the funnel's "generated" step and the hit rate's input. `source`
 * says whether Claude ran for it; model latency and tokens are set only then.
 * Guests are keyed by their demo cookie, and `ref` ties their edits to this basket.
 */
async function recordServed(
  owner: EventOwner,
  pipeline: Pipeline,
  served: {
    guest: boolean;
    presetKey: string | null;
    source: ThesisSource;
    ref: string;
    model: string;
    generation: Generation | null;
  },
) {
  const { generation, ...extra } = served;
  const dropped: Record<string, number> = {};
  const all = [...pipeline.grounded, ...pipeline.normalized.rejected];
  for (const candidate of all) {
    if (candidate.status !== "resolved") dropped[candidate.status] = (dropped[candidate.status] ?? 0) + 1;
  }
  await recordEvent(
    "thesis_generated",
    {
      ...extra,
      latencyMs: generation?.latencyMs ?? null,
      inputTokens: generation?.inputTokens ?? null,
      outputTokens: generation?.outputTokens ?? null,
    },
    owner,
  );
  await recordEvent(
    "symbols_resolved",
    {
      guest: extra.guest,
      presetKey: extra.presetKey,
      source: extra.source,
      ref: extra.ref,
      proposed: all.length,
      resolved: all.length - Object.values(dropped).reduce((a, b) => a + b, 0),
      dropped,
    },
    owner,
  );
}

async function loadSnapshots(ctx: SnapTradeContext, accounts: PortfolioAccount[]): Promise<AccountWithSnapshot[]> {
  const results = await Promise.allSettled(accounts.map((account) => getSnapshot(ctx, account)));
  return accounts.map((account, i) => {
    const result = results[i];
    if (result.status === "fulfilled") return { account, snapshot: result.value.snapshot };
    if (result.reason instanceof ReauthRequiredError) throw result.reason;
    console.error("[thesis] snapshot unavailable", describeError(result.reason));
    return { account, snapshot: null };
  });
}

function contextFor(
  request: ThesisRequest,
  account: PortfolioAccount,
  entries: AccountWithSnapshot[],
  portfolio: PortfolioView,
  universe?: string[],
): ContextInput {
  const snapshot = entries.find((entry) => entry.account.id === account.id)?.snapshot;
  const cash = (snapshot?.balances ?? []).flatMap((balance) =>
    balance.cash == null ? [] : [{ currency: balance.currency, amount: balance.cash }],
  );
  return {
    prompt: request.prompt,
    budget: request.budget,
    currency: request.currency,
    overlapMode: request.overlapMode,
    account: { name: account.name, institution: account.institution, isPaper: account.isPaper, cash },
    portfolio,
    universe,
  };
}

async function loadLiveAccounts(ctx: SnapTradeContext, accountId: string) {
  try {
    const overview = await loadOverview(ctx);
    const account = overview.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new ThesisError("account_not_found", 404, "That account isn't connected to SnapTrade.");
    return { account, entries: await loadSnapshots(ctx, overview.accounts) };
  } catch (error) {
    throw snapTradeFailure(error) ?? error;
  }
}

function snapTradeFailure(error: unknown): ThesisError | null {
  if (!(error instanceof SnapTradeError)) return null;
  if (error.code === "rate_limited" || error.code === "budget_exhausted") {
    return new ThesisError(
      "rate_limited",
      429,
      `This account's SnapTrade request limit (10 per minute) is used up. Try again in ${waitText(error.retryAfterSeconds)}.`,
      error.retryAfterSeconds,
    );
  }
  return new ThesisError("snaptrade_unavailable", 502, "SnapTrade couldn't price the basket. Try again shortly.");
}

/**
 * Signed-in Thesis Studio: portfolio context from every connected account,
 * one Claude call, then grounding and quotes on the selected account.
 */
export async function createThesis(
  ctx: SnapTradeContext,
  request: ThesisRequest,
  deps: ThesisDeps = {},
): Promise<ComposerPayload> {
  const { createMessage, model } = generationDeps(deps);
  if (!createMessage) {
    throw new ThesisError("not_configured", 503, "Thesis generation isn't configured on this deployment yet.");
  }
  const now = deps.now?.() ?? new Date();
  const { account, entries } = await loadLiveAccounts(ctx, request.accountId);

  // Quotes are the one account-limited call after generation; check the
  // budget before spending tokens on a basket that can't be priced.
  const budget = decideBudget(await readBudgetWindow(hashAccountId(ctx.config, account.id)));
  if (!budget.allowed) {
    throw snapTradeFailure(new SnapTradeError("budget_exhausted", "getUserAccountQuotes", null, budget.retryAfterSeconds))!;
  }

  const reservation = await reserveGeneration({ kind: "user", userId: ctx.userId });
  if (!reservation.ok) {
    throw new ThesisError(
      "generation_limit",
      429,
      `You've generated ${USER_GENERATIONS_PER_DAY} theses in the last 24 hours. Try again in ${waitText(reservation.retryAfterSeconds)}.`,
      reservation.retryAfterSeconds,
    );
  }

  const portfolio = collectPortfolio(entries);
  let generation: Generation;
  try {
    generation = await generateThesis(contextFor(request, account, entries, portfolio), { createMessage, model });
  } catch (error) {
    if (error instanceof ThesisGenerationError) throw generationFailure(error);
    throw error;
  }

  let pipeline: Pipeline;
  try {
    pipeline = await runPipeline(generation.output, request, portfolio, snapTradeQuoteSource(ctx, account), now);
  } catch (error) {
    throw snapTradeFailure(error) ?? error;
  }
  const id = await saveThesis({
    userId: ctx.userId,
    guestClient: null,
    request,
    generation,
    normalized: pipeline.normalized,
    grounded: pipeline.grounded,
    composition: pipeline.composition,
    priceSource: "snaptrade",
  });
  await recordServed({ userId: ctx.userId }, pipeline, {
    guest: false,
    presetKey: request.presetKey ?? null,
    source: "generated",
    ref: id,
    model: generation.model,
    generation,
  });
  return toPayload({
    id,
    ref: id,
    request,
    account,
    pipeline,
    portfolio,
    model: generation.model,
    latencyMs: generation.latencyMs,
    source: "generated",
    generatedAt: now,
    pricing: "snaptrade",
    pricedAt: now.toISOString(),
  });
}

const SAMPLES = samples as unknown as Record<string, ThesisOutput>;
const inFlight = new Map<string, Promise<Generation>>();

function presetFor(request: ThesisRequest): ThesisPreset | null {
  return THESIS_PRESETS.find((preset) => preset.key === request.presetKey && preset.prompt === request.prompt) ?? null;
}

/**
 * Guest demo: fixture portfolio, fixture prices, and no SnapTrade calls.
 * Claude is only called on a cache miss, within the guest limits: presets
 * are cached for a week per demo context (at most 3 × 4 × 2 × 2 = 48
 * contexts) and count toward the global daily cap only; custom prompts also
 * count per visitor. Without an Anthropic key or a database, presets fall
 * back to committed sample output.
 */
export async function createDemoThesis(
  request: ThesisRequest,
  /** `key` is the keyed hash of the visitor's demo cookie, for telemetry. */
  guest: { client: string; key?: string | null },
  deps: ThesisDeps = {},
): Promise<ComposerPayload> {
  const env = serverEnv();
  const { createMessage, model } = generationDeps(deps);
  const now = deps.now?.() ?? new Date();
  const overview = demoOverview();
  const account = overview.accounts.find((candidate) => candidate.id === request.accountId);
  if (!account) throw new ThesisError("account_not_found", 404, "That isn't one of the demo accounts.");

  const entries = overview.accounts.map((candidate) => ({ account: candidate, snapshot: demoSnapshot(candidate.id) }));
  const portfolio = collectPortfolio(entries);
  const source = demoQuoteSource();
  const preset = presetFor(request);
  const dbReady = Boolean(env.DATABASE_URL);
  const ref = randomUUID();
  const base = { request, account, portfolio, ref, pricing: "demo" as const, pricedAt: DEMO_QUOTES.as_of };
  const served = (pipeline: Pipeline, from: ThesisSource, servedModel: string, generation: Generation | null = null) =>
    recordServed({ guestKey: guest.key ?? null }, pipeline, {
      guest: true,
      presetKey: preset?.key ?? null,
      source: from,
      ref,
      model: servedModel,
      generation,
    });

  if (dbReady) {
    const cached = await findCachedGuestThesis({
      prompt: request.prompt,
      accountId: account.id,
      currency: request.currency,
      overlapMode: request.overlapMode,
      model,
      maxAgeMs: preset ? PRESET_CACHE_MS : GUEST_PROMPT_CACHE_MS,
    }).catch((error: unknown) => {
      console.error("[thesis] guest cache lookup failed", describeError(error));
      return null;
    });
    const output = cached ? ThesisOutputSchema.safeParse(cached.llmOutput) : null;
    if (cached && output?.success) {
      const pipeline = await runPipeline(output.data, request, portfolio, source, now);
      await served(pipeline, "cached", cached.model);
      return toPayload({
        ...base,
        id: null,
        pipeline,
        model: cached.model,
        latencyMs: cached.latencyMs,
        source: "cached",
        generatedAt: cached.createdAt,
      });
    }
  }

  const sample = preset ? SAMPLES[`${preset.key}:${request.currency}`] : undefined;
  const fromSample = async () => {
    const pipeline = await runPipeline(sample!, request, portfolio, source, now);
    await served(pipeline, "sample", "sample");
    return toPayload({ ...base, id: null, pipeline, model: "sample", latencyMs: null, source: "sample", generatedAt: now });
  };

  if (!createMessage || !dbReady) {
    if (sample) return fromSample();
    throw new ThesisError(
      "guest_generation_unavailable",
      503,
      "Live generation isn't available in this demo deployment. Try one of the presets.",
    );
  }

  // Identical concurrent guest requests share one generation; each caller
  // still sizes the basket for its own budget.
  const key = [preset?.key ?? guest.client, request.prompt, account.id, request.currency, request.overlapMode].join("|");
  let job = inFlight.get(key);
  const shared = job != null;
  if (!job) {
    job = (async () => {
      const reservation = await reserveGeneration({
        kind: "guest",
        client: preset ? null : guest.client,
        globalPerDay: env.GUEST_GENERATIONS_PER_DAY,
      });
      if (!reservation.ok) {
        throw new ThesisError(
          "generation_limit",
          429,
          reservation.scope === "client"
            ? `The demo allows ${GUEST_GENERATIONS_PER_CLIENT_PER_DAY} custom theses per visitor per day. Try a preset, or try again in ${waitText(reservation.retryAfterSeconds)}.`
            : "The demo's daily generation allowance is used up. Presets still work; custom prompts reopen within 24 hours.",
          reservation.retryAfterSeconds,
        );
      }
      let generation: Generation;
      try {
        generation = await generateThesis(
          contextFor(request, account, entries, portfolio, demoUniverse(request.currency)),
          { createMessage, model },
        );
      } catch (error) {
        if (error instanceof ThesisGenerationError) throw generationFailure(error);
        throw error;
      }
      const pipeline = await runPipeline(generation.output, request, portfolio, source, now);
      await saveThesis({
        userId: null,
        guestClient: preset ? null : guest.client,
        request,
        generation,
        normalized: pipeline.normalized,
        grounded: pipeline.grounded,
        composition: pipeline.composition,
        priceSource: "demo",
      });
      return generation;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }

  try {
    const generation = await job;
    const pipeline = await runPipeline(generation.output, request, portfolio, source, now);
    // A caller that joined another's request got the basket without a Claude call of its own.
    await (shared ? served(pipeline, "cached", generation.model) : served(pipeline, "generated", generation.model, generation));
    return toPayload({
      ...base,
      id: null,
      pipeline,
      model: generation.model,
      latencyMs: generation.latencyMs,
      source: "generated",
      generatedAt: now,
    });
  } catch (error) {
    if (sample && error instanceof ThesisError && (error.code === "generation_limit" || error.code === "model_busy")) {
      return fromSample();
    }
    throw error;
  }
}
