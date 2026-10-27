import { describe, expect, it } from "vitest";

import { pacingLegId, stackLegs } from "@/lib/execution/client-state";
import type { ExecutionView, LegView } from "@/lib/execution/types";

const leg = (seq: number, status: LegView["status"], attempt = 1): LegView => ({
  id: `${seq}-${attempt}`,
  seq,
  attempt,
  action: "BUY",
  symbol: `S${seq}`,
  units: seq * 2,
  estPrice: 10,
  status,
  brokerageOrderId: null,
  filledUnits: null,
  fillPrice: null,
  errorCode: null,
  errorMessage: null,
  claimedAt: null,
  submittedAt: null,
});

const execution = (legs: LegView[]) => ({ legs }) as ExecutionView;

describe("stacks loader legs", () => {
  it("map each order's latest attempt to a stack status", () => {
    const run = execution([
      leg(1, "executed"),
      leg(2, "rejected"),
      leg(3, "pending"),
      leg(4, "pending"),
      leg(5, "skipped"),
      leg(6, "unknown"),
    ]);
    expect(stackLegs(run, true)).toEqual([
      { symbol: "S1", shares: 2, status: "submitted" },
      { symbol: "S2", shares: 4, status: "failed" },
      { symbol: "S3", shares: 6, status: "pacing" },
      { symbol: "S4", shares: 8, status: "queued" },
      { symbol: "S5", shares: 10, status: "queued" },
      { symbol: "S6", shares: 12, status: "submitting" },
    ]);
    expect(stackLegs(run, false).map((stack) => stack.status)[2]).toBe("queued");
  });

  it("shows a leg in flight as submitting, with nothing pacing behind it", () => {
    const run = execution([leg(1, "claimed"), leg(2, "pending")]);
    expect(pacingLegId(run, true)).toBeNull();
    expect(stackLegs(run, true).map((stack) => stack.status)).toEqual(["submitting", "queued"]);
  });

  it("follows a retried leg's newest attempt", () => {
    const run = execution([leg(1, "rejected"), leg(1, "pending", 2), leg(2, "executed")]);
    expect(stackLegs(run, true).map((stack) => stack.status)).toEqual(["pacing", "submitted"]);
  });
});
