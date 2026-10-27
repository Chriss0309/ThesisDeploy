import { describe, expect, it } from "vitest";

import { dropReason, formatMs, formatRate, rate } from "@/components/telemetry/format";

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
});
