import { describe, expect, it } from "vitest";

import { adjustForOverlap, sameCompany, type Holding, type OverlapInput } from "@/lib/overlap";

const holding = (overrides: Partial<Holding> & Pick<Holding, "symbol" | "marketValue">): Holding => ({
  accountId: "acct-tfsa",
  accountName: "Wealthsimple TFSA",
  currency: "USD",
  ...overrides,
});

const basket = (overrides: Partial<OverlapInput> = {}): OverlapInput => ({
  budget: 10_000,
  currency: "USD",
  mode: "auto",
  candidates: [
    { symbol: "CEG", weight: 0.25 },
    { symbol: "VST", weight: 0.25 },
    { symbol: "ETN", weight: 0.25 },
    { symbol: "CCJ", weight: 0.25 },
  ],
  holdings: [],
  ...overrides,
});

describe("sameCompany", () => {
  it("matches US and TSX listings by raw ticker when FIGI is missing", () => {
    expect(sameCompany({ symbol: "CCJ" }, { symbol: "CCJ.TO" })).toBe(true);
    expect(sameCompany({ symbol: "ccj" }, { symbol: "XYZ", rawSymbol: "CCJ" })).toBe(true);
    expect(sameCompany({ symbol: "BRK.B" }, { symbol: "BRK" })).toBe(false);
  });

  it("lets share-class FIGI decide when both sides have one", () => {
    const att = { symbol: "T", shareClassFigi: "FIGI-ATT" };
    const telus = { symbol: "T.TO", shareClassFigi: "FIGI-TELUS" };
    expect(sameCompany(att, telus)).toBe(false);
    expect(sameCompany(att, { symbol: "ATT-ALIAS", shareClassFigi: "FIGI-ATT" })).toBe(true);
  });
});

describe("adjustForOverlap", () => {
  it("leaves weights alone when nothing overlaps", () => {
    const lines = adjustForOverlap(basket({ holdings: [holding({ symbol: "NVDA", marketValue: 5000 })] }));
    expect(lines.map((l) => l.adjustedWeight)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(lines.every((l) => l.status === "new")).toBe(true);
  });

  it("buys only the gap to target dollars, then renormalizes", () => {
    // CEG target $2,500, held $1,500: top up $1,000 (10% of budget), then rescale to sum to 1.
    const lines = adjustForOverlap(basket({ holdings: [holding({ symbol: "CEG", marketValue: 1500 })] }));
    const [ceg, vst] = lines;
    expect(ceg.status).toBe("adjusted");
    expect(ceg.heldValue).toBe(1500);
    expect(ceg.originalWeight).toBe(0.25);
    expect(ceg.adjustedWeight).toBeCloseTo(0.1 / 0.85);
    expect(vst.adjustedWeight).toBeCloseTo(0.25 / 0.85);
    expect(lines.reduce((sum, l) => sum + l.adjustedWeight, 0)).toBeCloseTo(1);
  });

  it("drops a name already held at or above target", () => {
    const lines = adjustForOverlap(basket({ holdings: [holding({ symbol: "VST", marketValue: 4000 })] }));
    expect(lines[1]).toMatchObject({ status: "fully_held", adjustedWeight: 0 });
    expect(lines[0].adjustedWeight).toBeCloseTo(1 / 3);
  });

  it("sums the same company across accounts and listings", () => {
    const lines = adjustForOverlap(
      basket({
        holdings: [
          holding({ symbol: "CCJ", marketValue: 1000 }),
          holding({ symbol: "CCJ.TO", marketValue: 500, accountId: "acct-rrsp", currency: "USD" }),
        ],
      }),
    );
    expect(lines[3].heldValue).toBe(1500);
    expect(lines[3].holdings.map((h) => h.accountId)).toEqual(["acct-tfsa", "acct-rrsp"]);
  });

  it("converts other currencies with the given FX rate", () => {
    const lines = adjustForOverlap(
      basket({
        currency: "CAD",
        candidates: [
          { symbol: "CCJ.TO", weight: 0.5 },
          { symbol: "SU.TO", weight: 0.5 },
        ],
        holdings: [holding({ symbol: "CCJ", marketValue: 1000, currency: "USD" })],
        fxRates: { USD: 1.4 },
      }),
    );
    expect(lines[0].heldValue).toBeCloseTo(1400);
    expect(lines[0].holdings[0].valueInBudgetCurrency).toBeCloseTo(1400);
    // Gaps: 5,000 − 1,400 = 3,600 and 5,000.
    expect(lines[0].adjustedWeight).toBeCloseTo(3600 / 8600);
  });

  it("lists but does not count a holding with no FX rate", () => {
    const lines = adjustForOverlap(
      basket({
        currency: "CAD",
        candidates: [
          { symbol: "CCJ.TO", weight: 0.5 },
          { symbol: "SU.TO", weight: 0.5 },
        ],
        holdings: [holding({ symbol: "CCJ", marketValue: 1000, currency: "USD" })],
      }),
    );
    expect(lines[0]).toMatchObject({ status: "unconverted", heldValue: 0, adjustedWeight: 0.5 });
    expect(lines[0].holdings[0].valueInBudgetCurrency).toBeNull();
  });

  it("reports overlap without reweighting in ignore mode", () => {
    const lines = adjustForOverlap(
      basket({ mode: "ignore", holdings: [holding({ symbol: "CEG", marketValue: 9000 })] }),
    );
    expect(lines[0]).toMatchObject({ status: "ignored", heldValue: 9000, adjustedWeight: 0.25 });
  });

  it("zeroes every weight when everything is already held at target", () => {
    // VST's float-noise gap must not renormalize into a full-budget buy.
    const lines = adjustForOverlap(
      basket({
        candidates: [
          { symbol: "CEG", weight: 0.5 },
          { symbol: "VST", weight: 0.5 },
        ],
        holdings: [
          holding({ symbol: "CEG", marketValue: 5000 }),
          holding({ symbol: "VST", marketValue: 4999.9999999 }),
        ],
      }),
    );
    expect(lines.map((l) => l.adjustedWeight)).toEqual([0, 0]);
    expect(lines.every((l) => l.status === "fully_held")).toBe(true);
  });

  it("zeroes weights for a zero budget in auto mode", () => {
    const lines = adjustForOverlap(basket({ budget: 0 }));
    expect(lines.every((l) => l.adjustedWeight === 0 && l.originalWeight === 0.25)).toBe(true);
  });

  it("nets a short against longs and never targets more than w × B", () => {
    const lines = adjustForOverlap(basket({ holdings: [holding({ symbol: "CEG", marketValue: -3000 })] }));
    expect(lines[0].heldValue).toBe(0);
    expect(lines[0].adjustedWeight).toBe(0.25);
  });

  it("rejects negative weights and non-positive FX rates", () => {
    expect(() => adjustForOverlap(basket({ candidates: [{ symbol: "A", weight: -1 }] }))).toThrow(RangeError);
    expect(() =>
      adjustForOverlap(
        basket({
          currency: "CAD",
          holdings: [holding({ symbol: "CEG", marketValue: 100 })],
          fxRates: { USD: 0 },
        }),
      ),
    ).toThrow(RangeError);
  });
});
