import { createHash } from "node:crypto";

import { getDb } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { Composition } from "@/lib/thesis/compose";
import type { Generation } from "@/lib/thesis/generate";
import type { GroundedCandidate } from "@/lib/thesis/grounding";
import type { NormalizedThesis } from "@/lib/thesis/normalize";
import type { ThesisRequest } from "@/lib/thesis/schema";

export const promptHash = (prompt: string) => createHash("sha256").update(prompt.toLowerCase()).digest("hex");

export type SaveThesisInput = {
  userId: string | null;
  guestClient: string | null;
  request: ThesisRequest;
  generation: Generation;
  normalized: NormalizedThesis;
  grounded: readonly GroundedCandidate[];
  composition: Composition | null;
  priceSource: "snaptrade" | "demo";
};

export async function saveThesis(input: SaveThesisInput): Promise<string> {
  const { request, generation, normalized, composition } = input;
  const lineFor = (symbol: string | undefined) =>
    symbol ? composition?.lines.find((line) => line.symbol === symbol) : undefined;

  const candidates: Prisma.ThesisCandidateCreateWithoutThesisInput[] = [
    ...input.grounded.map((candidate) => {
      const line = candidate.status === "resolved" ? lineFor(candidate.symbol?.symbol) : undefined;
      return {
        ticker: candidate.ticker,
        companyName: candidate.companyName,
        rationale: candidate.rationale,
        llmWeight: candidate.weight,
        resolutionStatus: candidate.status,
        detail: candidate.detail,
        symbol: candidate.symbol?.symbol ?? null,
        universalSymbolId: candidate.symbol?.id ?? null,
        price: line?.price ?? null,
        priceSource: line ? `${input.priceSource}:${line.priceBasis}` : null,
        overlapValue: line?.overlap.heldValue ?? null,
        adjustedWeight: line?.targetWeight ?? null,
        units: line?.units ?? null,
      };
    }),
    ...normalized.rejected.map((candidate) => ({
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      rationale: "",
      resolutionStatus: candidate.status,
      detail: candidate.detail,
    })),
  ].map((candidate, seq) => ({ ...candidate, seq }));

  const thesis = await getDb().thesis.create({
    data: {
      userId: input.userId,
      guestClient: input.guestClient,
      accountId: request.accountId,
      prompt: request.prompt,
      promptHash: promptHash(request.prompt),
      presetKey: request.presetKey ?? null,
      budget: request.budget,
      currency: request.currency,
      overlapMode: request.overlapMode,
      model: generation.model,
      llmOutput: generation.output as unknown as Prisma.InputJsonObject,
      title: normalized.title,
      summary: normalized.summary,
      riskProfile: normalized.riskProfile,
      latencyMs: generation.latencyMs,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      candidates: { create: candidates },
    },
    select: { id: true },
  });
  return thesis.id;
}

export type CachedThesis = { llmOutput: unknown; model: string; latencyMs: number; createdAt: Date };

/**
 * Guest theses are reused for the same prompt and demo context. The budget
 * isn't part of the key: Claude proposes percentage weights, and the solver
 * sizes them for whatever budget the guest picks.
 */
export async function findCachedGuestThesis(key: {
  prompt: string;
  accountId: string;
  currency: string;
  overlapMode: string;
  model: string;
  maxAgeMs: number;
}): Promise<CachedThesis | null> {
  return getDb().thesis.findFirst({
    where: {
      userId: null,
      promptHash: promptHash(key.prompt),
      accountId: key.accountId,
      currency: key.currency,
      overlapMode: key.overlapMode,
      model: key.model,
      createdAt: { gt: new Date(Date.now() - key.maxAgeMs) },
    },
    orderBy: { createdAt: "desc" },
    select: { llmOutput: true, model: true, latencyMs: true, createdAt: true },
  });
}

export async function thesisOwnedBy(thesisId: string, userId: string): Promise<boolean> {
  const row = await getDb().thesis.findFirst({ where: { id: thesisId, userId }, select: { id: true } });
  return row != null;
}
