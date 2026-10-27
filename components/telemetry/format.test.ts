import { describe, expect, it } from "vitest";

import { dropReason, formatMs, formatRate, kindBreakdown, rate } from "@/components/telemetry/format";

describe("telemetry formatting", () => {
  it("returns no rate without a denominator, and clamps to [0, 1]", () => {
    expect(rate(3, 0)).toBeNull();
    expect(rate(3, null)).toBeNull();
    expect(rate(3, 4)).toBe(0.75);
    expect(rate(5, 4)).toBe(1);
  });

  it("formats rates, latencies, and drop reasons for people", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(2 / 3)).toBe("66.7%");
    expect(formatMs(1234)).toBe("1,234 ms");
    expect(dropReason("currency_mismatch")).toBe("wrong currency");
    expect(dropReason("some_new_reason")).toBe("some new reason");
  });

  it("lists order kinds that have orders", () => {
    expect(kindBreakdown({ deploy: 6, rebalance: 4, close: 0 })).toBe("6 deploy · 4 rebalance");
    expect(kindBreakdown({ deploy: 0, rebalance: 0, close: 3 })).toBe("3 close");
  });
});
