import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { completeLogin, startLogin } from "@/lib/auth/flow";
import { closeDb, getDb } from "@/lib/db/client";
import { THESIS_PRESETS } from "@/lib/presets";
import { hashAccountId, snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import { ACCOUNT_BUDGET_PER_MINUTE } from "@/lib/snaptrade/rate-budget";
import { GUEST_GENERATIONS_PER_CLIENT_PER_DAY, USER_GENERATIONS_PER_DAY } from "@/lib/thesis/rate-limit";
import type { ThesisRequest } from "@/lib/thesis/schema";
import { ThesisError, createDemoThesis, createThesis } from "@/lib/thesis/service";
import { thesisOwnedBy } from "@/lib/thesis/store";
import { SAMPLE_OUTPUTS, mockCreateMessage } from "@/lib/thesis/testing";
import { startOAuthStub } from "@/scripts/oauth-stub.mjs";
import { startSnapTradeApiStub } from "@/scripts/snaptrade-api-stub.mjs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT_URI = "http://127.0.0.1:3000/api/auth/callback";
// A Saturday, so prices come from the last trade.
const now = () => new Date("2026-10-24T16:00:00Z");
const POWER = SAMPLE_OUTPUTS["ai-power-nuclear:USD"];
const PRESET = THESIS_PRESETS.find((preset) => preset.key === "ai-power-nuclear")!;

const request = (overrides: Partial<ThesisRequest> = {}): ThesisRequest => ({
  prompt: PRESET.prompt,
  presetKey: PRESET.key,
  accountId: "demo-acct-alpaca-paper",
  currency: "USD",
  budget: 2500,
  overlapMode: "auto",
  ...overrides,
});

async function thesisError(promise: Promise<unknown>): Promise<ThesisError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ThesisError);
  return error as ThesisError;
}

describe.skipIf(!TEST_DATABASE_URL)("Thesis Studio against stubs and Postgres", () => {
  let oauth: Awaited<ReturnType<typeof startOAuthStub>>;
  let api: Awaited<ReturnType<typeof startSnapTradeApiStub>>;
  let config: AuthConfig;
  let ctx: SnapTradeContext;

  beforeAll(async () => {
    oauth = await startOAuthStub({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    vi.stubEnv("SNAPTRADE_ISSUER", oauth.issuer);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("SNAPTRADE_OAUTH_REDIRECT_URI", REDIRECT_URI);
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("base64"));
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    config = getAuthConfig();
  });

  afterAll(async () => {
    await oauth?.close();
    await closeDb();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls, account_snapshots, theses, thesis_candidates restart identity cascade`;
    vi.stubEnv("GUEST_GENERATIONS_PER_DAY", "40");
    api = await startSnapTradeApiStub();
    vi.stubEnv("SNAPTRADE_API_BASE_URL", api.url);

    const { authorizationUrl, state } = await startLogin(config, "/studio");
    const location = new URL((await fetch(authorizationUrl, { redirect: "manual" })).headers.get("location") ?? "");
    const result = await completeLogin(
      config,
      {
        code: location.searchParams.get("code"),
        state: location.searchParams.get("state"),
        error: null,
        iss: location.searchParams.get("iss"),
      },
      state,
    );
    if (!result.ok) throw new Error(`sign-in failed: ${result.error}`);
    ctx = snapTradeContext((await getDb().appUser.findFirstOrThrow()).id);
  });

  afterEach(() => api.close());

  const events = (name: string) => getDb().event.findMany({ where: { name }, orderBy: { id: "asc" } });

  describe("signed in", () => {
    it("builds a basket from the whole portfolio with one quotes call and records it", async () => {
      const claude = mockCreateMessage(POWER);
      const payload = await createThesis(ctx, request(), { createMessage: claude.createMessage, now });

      // Claude saw holdings from every account, including ones it can't trade.
      const context = claude.calls[0].messages[0].content as string;
      expect(context).toContain("CEG (Constellation Energy Corporation): 4,377.00 USD");
      expect(context).toContain("in TFSA (Questrade), Individual (Interactive Brokers)");

      expect(payload.lines.map((line) => line.symbol)).toEqual(["CEG", "TLN", "BWXT", "CCJ", "PWR", "VRT", "OKLO"]);
      expect(payload.dropped).toEqual([expect.objectContaining({ ticker: "SMR", status: "not_found" })]);
      expect(payload.lines[0]).toMatchObject({ overlap: { status: "fully_held" }, targetWeight: 0, units: 0 });
      expect(payload.lines.find((line) => line.symbol === "CCJ")?.overlap.status).toBe("unconverted");
      expect(payload.pricing).toMatchObject({ source: "snaptrade", market: "NYSE", marketOpen: false });
      expect(payload.thesis).toMatchObject({ source: "generated", model: "claude-sonnet-5-5" });

      // One batched quotes call; the SMR miss went to symbol search, which isn't account-limited.
      expect(api.stats.quoteRequests).toEqual([["CEG", "TLN", "BWXT", "CCJ", "PWR", "VRT", "OKLO", "SMR"]]);
      const calls = await getDb().apiCall.findMany({ orderBy: { id: "asc" } });
      const quotes = calls.filter((row) => row.operation === "getUserAccountQuotes");
      expect(quotes).toEqual([
        expect.objectContaining({ httpStatus: 200, accountHash: hashAccountId(config, "demo-acct-alpaca-paper") }),
      ]);
      expect(calls.filter((row) => row.operation === "symbolSearchUserAccount")).toEqual([
        expect.objectContaining({ httpStatus: 200, accountHash: null }),
      ]);
      expect(api.stats.rateLimited).toBe(0);

      const thesis = await getDb().thesis.findUniqueOrThrow({ where: { id: payload.thesis.id! }, include: { candidates: true } });
      expect(thesis).toMatchObject({ userId: ctx.userId, accountId: "demo-acct-alpaca-paper", model: "claude-sonnet-5-5" });
      expect(thesis.candidates.map((c) => c.resolutionStatus).sort()).toEqual([
        "not_found",
        ...Array(7).fill("resolved"),
      ]);
      expect(thesis.candidates.find((c) => c.symbol === "TLN")).toMatchObject({ priceSource: "snaptrade:last" });
      expect(await thesisOwnedBy(thesis.id, ctx.userId)).toBe(true);

      expect((await events("thesis_requested")).map((e) => e.userId)).toEqual([ctx.userId]);
      const [resolved] = await events("symbols_resolved");
      expect(resolved.props).toMatchObject({ proposed: 8, resolved: 7, dropped: { not_found: 1 } });
    });

    it("falls back to symbol search and one re-quote when SnapTrade rejects the batch", async () => {
      api.setUnknownQuotes("reject");
      const payload = await createThesis(ctx, request(), { createMessage: mockCreateMessage(POWER).createMessage, now });
      expect(api.stats.quoteRequests).toHaveLength(2);
      expect(api.stats.quoteRequests[1]).not.toContain("SMR");
      expect(payload.lines).toHaveLength(7);
    });

    it("refuses before calling Claude when the account's SnapTrade budget is used up", async () => {
      const accountHash = hashAccountId(config, "demo-acct-alpaca-paper");
      await getDb().apiCall.createMany({
        data: Array.from({ length: ACCOUNT_BUDGET_PER_MINUTE }, () => ({
          userId: ctx.userId,
          operation: "getUserAccountBalance",
          accountHash,
          httpStatus: 200,
          latencyMs: 10,
        })),
      });
      const claude = mockCreateMessage(POWER);
      const error = await thesisError(createThesis(ctx, request(), { createMessage: claude.createMessage, now }));
      expect(error).toMatchObject({ code: "rate_limited", status: 429 });
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
      expect(claude.calls).toHaveLength(0);
      expect(await events("thesis_requested")).toHaveLength(0);
    });

    it(`stops at ${USER_GENERATIONS_PER_DAY} generations per user per day`, async () => {
      await getDb().event.createMany({
        data: Array.from({ length: USER_GENERATIONS_PER_DAY }, () => ({
          name: "thesis_requested",
          userId: ctx.userId,
          props: { guest: false },
        })),
      });
      const claude = mockCreateMessage(POWER);
      const error = await thesisError(createThesis(ctx, request(), { createMessage: claude.createMessage, now }));
      expect(error).toMatchObject({ code: "generation_limit", status: 429 });
      expect(claude.calls).toHaveLength(0);
      expect(await events("thesis_requested")).toHaveLength(USER_GENERATIONS_PER_DAY);
    });

    it("rejects off-topic prompts without saving a thesis", async () => {
      const claude = mockCreateMessage({ ...POWER, on_topic: false, candidates: [], excluded: [] });
      const error = await thesisError(
        createThesis(ctx, request({ prompt: "Write me a poem", presetKey: null }), { createMessage: claude.createMessage, now }),
      );
      expect(error).toMatchObject({ code: "off_topic", status: 422 });
      expect(await getDb().thesis.count()).toBe(0);
    });

    it("requires the account to belong to the user", async () => {
      const error = await thesisError(
        createThesis(ctx, request({ accountId: "someone-else" }), { createMessage: mockCreateMessage(POWER).createMessage, now }),
      );
      expect(error).toMatchObject({ code: "account_not_found", status: 404 });
    });
  });

  describe("guest demo", () => {
    const guest = { client: "client-a" };

    it("generates a preset once per demo context, then serves it from cache for any budget", async () => {
      const claude = mockCreateMessage(POWER);
      const first = await createDemoThesis(request(), guest, { createMessage: claude.createMessage, now });
      const second = await createDemoThesis(request({ budget: 9000 }), { client: "client-b" }, { createMessage: claude.createMessage, now });

      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].messages[0].content).toContain("This is a demo with a fixed price feed.");
      expect(first.thesis).toMatchObject({ id: null, source: "generated" });
      expect(second.thesis).toMatchObject({ id: null, source: "cached" });
      expect(second.budget).toBe(9000);
      expect(second.lines.map((line) => line.symbol)).toEqual(first.lines.map((line) => line.symbol));
      expect(api.stats.requests).toBe(0);

      const rows = await getDb().thesis.findMany();
      expect(rows).toEqual([expect.objectContaining({ userId: null, guestClient: null, presetKey: PRESET.key })]);
      expect((await events("thesis_requested")).map((e) => e.props)).toEqual([{ guest: true, client: null }]);
    });

    it("shares one generation between identical concurrent requests", async () => {
      const claude = mockCreateMessage(POWER);
      const results = await Promise.all([
        createDemoThesis(request(), guest, { createMessage: claude.createMessage, now }),
        createDemoThesis(request({ budget: 5000 }), guest, { createMessage: claude.createMessage, now }),
      ]);
      expect(claude.calls).toHaveLength(1);
      expect(results.map((result) => result.budget)).toEqual([2500, 5000]);
    });

    it("shows the committed sample for presets when Claude isn't configured", async () => {
      const payload = await createDemoThesis(request({ currency: "CAD", accountId: "demo-acct-tfsa", budget: 990 }), guest, { now });
      expect(payload.thesis).toMatchObject({ source: "sample", model: "sample", title: "Canadian Power for AI" });
      expect(payload.lines.find((line) => line.symbol === "CCJ.TO")?.overlap.status).toBe("fully_held");
      expect(await getDb().thesis.count()).toBe(0);
    });

    it("turns custom prompts away when Claude isn't configured", async () => {
      const error = await thesisError(createDemoThesis(request({ prompt: "Shipping and ports", presetKey: null }), guest, { now }));
      expect(error).toMatchObject({ code: "guest_generation_unavailable", status: 503 });
    });

    it(`allows ${GUEST_GENERATIONS_PER_CLIENT_PER_DAY} custom prompts per visitor per day`, async () => {
      const claude = mockCreateMessage(POWER);
      const custom = (prompt: string, client = guest) =>
        createDemoThesis(request({ prompt, presetKey: null }), client, { createMessage: claude.createMessage, now });

      for (let i = 0; i < GUEST_GENERATIONS_PER_CLIENT_PER_DAY; i++) {
        expect((await custom(`Grid theme number ${i}`)).thesis.source).toBe("generated");
      }
      const error = await thesisError(custom("One more grid theme"));
      expect(error).toMatchObject({ code: "generation_limit", status: 429 });
      expect(error.retryAfterSeconds).toBeGreaterThan(3600);
      // A repeated prompt is served from cache and doesn't count.
      expect((await custom("Grid theme number 0")).thesis.source).toBe("cached");
      expect((await custom("One more grid theme", { client: "client-b" })).thesis.source).toBe("generated");
      expect(claude.calls).toHaveLength(GUEST_GENERATIONS_PER_CLIENT_PER_DAY + 1);
      const guests = await getDb().thesis.findMany({ where: { guestClient: "client-a" } });
      expect(guests).toHaveLength(GUEST_GENERATIONS_PER_CLIENT_PER_DAY);
    });

    it("caps guest generations across all visitors, falling back to samples for presets", async () => {
      vi.stubEnv("GUEST_GENERATIONS_PER_DAY", "1");
      const claude = mockCreateMessage(POWER);
      const deps = { createMessage: claude.createMessage, now };
      expect((await createDemoThesis(request(), guest, deps)).thesis.source).toBe("generated");

      const other = THESIS_PRESETS.find((preset) => preset.key === "ai-cybersecurity")!;
      const preset = await createDemoThesis(request({ prompt: other.prompt, presetKey: other.key }), guest, deps);
      expect(preset.thesis.source).toBe("sample");

      const error = await thesisError(createDemoThesis(request({ prompt: "Water utilities", presetKey: null }), guest, deps));
      expect(error).toMatchObject({ code: "generation_limit", status: 429 });
      expect(claude.calls).toHaveLength(1);
      // Rejected requests don't hold on to the allowance.
      expect(await events("thesis_requested")).toHaveLength(1);
    });

    it("rejects accounts outside the demo portfolio", async () => {
      const error = await thesisError(createDemoThesis(request({ accountId: "demo-acct-chequing" }), guest, { now }));
      expect(error).toMatchObject({ code: "account_not_found", status: 404 });
    });
  });
});
