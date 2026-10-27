import { describe, expect, it } from "vitest";

import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { THESIS_PRESETS } from "@/lib/presets";
import { composeBasket } from "@/lib/thesis/compose";
import { groundCandidates } from "@/lib/thesis/grounding";
import { normalizeOutput } from "@/lib/thesis/normalize";
import { collectPortfolio } from "@/lib/thesis/portfolio";
import { demoQuoteSource } from "@/lib/thesis/quote-sources";
import { BASKET_CURRENCIES, MAX_CANDIDATES, MIN_CANDIDATES, ThesisOutputSchema } from "@/lib/thesis/schema";
import { SAMPLE_OUTPUTS } from "@/lib/thesis/testing";

const portfolio = collectPortfolio(
  demoOverview().accounts.map((account) => ({ account, snapshot: demoSnapshot(account.id) })),
);

// The guest demo falls back to these when no Anthropic key is configured.
describe.each(THESIS_PRESETS.flatMap((preset) => BASKET_CURRENCIES.map((currency) => [preset.key, currency] as const)))(
  "sample output %s in %s",
  (presetKey, currency) => {
    const sample = SAMPLE_OUTPUTS[`${presetKey}:${currency}`];

    it("exists and matches the structured-output schema", () => {
      expect(ThesisOutputSchema.parse(sample)).toEqual(sample);
      expect(sample.candidates.length).toBeGreaterThanOrEqual(MIN_CANDIDATES);
      expect(sample.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      expect(sample.candidates.reduce((sum, c) => sum + c.weight_pct, 0)).toBe(100);
      expect(sample.candidates.every((c) => c.rationale.length <= 200)).toBe(true);
    });

    it("grounds against the demo feed and sizes a basket", async () => {
      const normalized = normalizeOutput(sample);
      expect(normalized.rejected).toEqual([]);
      const { candidates } = await groundCandidates(normalized.candidates, currency, demoQuoteSource());
      expect(candidates.filter((c) => c.status === "resolved").length).toBeGreaterThanOrEqual(2);
      const result = composeBasket({ candidates, portfolio, budget: 2500, currency, overlapMode: "auto", marketOpen: false });
      expect(result.allocation.invested).toBeGreaterThan(0);
      expect(result.allocation.invested).toBeLessThanOrEqual(2500);
    });
  },
);
