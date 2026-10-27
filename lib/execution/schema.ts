import { z } from "zod";

import { BASKET_CURRENCIES, MAX_CANDIDATES, RISK_PROFILES } from "@/lib/thesis/schema";

export const PreflightRequestSchema = z.object({
  basketId: z.uuid().nullish(),
  thesisId: z.uuid().nullable(),
  accountId: z.string().min(1).max(128),
  currency: z.enum(BASKET_CURRENCIES),
  budget: z.number().positive().max(1_000_000),
  thesis: z.object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(400),
    riskProfile: z.enum(RISK_PROFILES),
  }),
  lines: z
    .array(
      z.object({
        symbol: z.string().trim().toUpperCase().min(1).max(24),
        companyName: z.string().trim().max(120),
        universalSymbolId: z.string().max(64).nullable(),
        targetWeight: z.number().min(0).max(1),
        units: z.number().int().min(0).max(100_000),
      }),
    )
    .min(1)
    .max(MAX_CANDIDATES),
});

export const CreateExecutionSchema = z.object({
  basketId: z.uuid(),
  mode: z.enum(["paper", "live"]),
  /** Rebalance and close confirm the pre-flight they were shown by id. */
  kind: z.enum(["deploy", "rebalance", "close"]).default("deploy"),
  preflightId: z.uuid().nullish(),
  /** Paper only: reject the first attempt of this leg, to demo partial failure and retry. */
  simulateRejectSeq: z.number().int().min(1).max(MAX_CANDIDATES).nullable().default(null),
});

export const IdempotencyKeySchema = z.uuid();

export const ActionPreflightSchema = z.object({ kind: z.enum(["rebalance", "close"]) });

export const SimulateMoveSchema = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({ symbol: z.string().trim().toUpperCase().min(1).max(24), change: z.number().min(-0.9).max(2) }),
]);
