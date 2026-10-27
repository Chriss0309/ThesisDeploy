import { z } from "zod";

export const RISK_PROFILES = ["conservative", "moderate", "aggressive", "speculative"] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export const MIN_CANDIDATES = 6;
export const MAX_CANDIDATES = 8;
export const MAX_PROMPT_LENGTH = 500;
export const BASKET_CURRENCIES = ["USD", "CAD"] as const;
export type BasketCurrency = (typeof BASKET_CURRENCIES)[number];
export type OverlapMode = "auto" | "ignore";

/**
 * Claude's structured output. Structured outputs enforce types, enums, and
 * required fields, but not counts, lengths, or numeric bounds, so those are
 * stated in descriptions and re-checked by `normalizeOutput`. Every field is
 * required (nullable where optional) because strict schemas forbid omissions.
 */
export const ThesisOutputSchema = z.object({
  on_topic: z
    .boolean()
    .describe("false when the thesis is not an investment theme that listed stocks can express"),
  title: z.string().describe("2 to 6 words"),
  summary: z.string().describe("One sentence describing the basket"),
  risk_profile: z.enum(RISK_PROFILES),
  candidates: z
    .array(
      z.object({
        ticker: z
          .string()
          .describe("Symbol on its exchange without an exchange suffix; share classes with a dot, e.g. BRK.B"),
        listing: z.enum(["US", "TSX"]),
        company_name: z.string(),
        rationale: z.string().describe("One sentence, at most 200 characters"),
        weight_pct: z.number().describe("Target weight in percent; candidates sum to 100; each 5 to 30"),
        holding_note: z
          .string()
          .nullable()
          .describe("How much of this company the investor already holds and where, or null"),
      }),
    )
    .describe(`${MIN_CANDIDATES} to ${MAX_CANDIDATES} candidates; empty when on_topic is false`),
  excluded: z
    .array(z.object({ ticker: z.string(), reason: z.string() }))
    .describe("Up to 5 notable companies left out, each with a short reason"),
});

export type ThesisOutput = z.infer<typeof ThesisOutputSchema>;

export const ThesisRequestSchema = z.object({
  prompt: z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(3).max(MAX_PROMPT_LENGTH)),
  presetKey: z.string().max(64).nullish(),
  accountId: z.string().min(1).max(128),
  currency: z.enum(BASKET_CURRENCIES),
  budget: z.number().positive().max(1_000_000),
  overlapMode: z.enum(["auto", "ignore"]),
});

export type ThesisRequest = z.infer<typeof ThesisRequestSchema>;
