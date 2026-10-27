import type { AccountOrderRecord } from "snaptrade-typescript-sdk";
import { describe, expect, it } from "vitest";

import { orderOutcome } from "@/lib/execution/live-orders";
import { matchUnknown } from "@/lib/execution/reconcile";

const leg = { units: 5, estPrice: 100 };
const ctx = (final: boolean) => ({ institution: "Alpaca Paper", final, latencyMs: 40, requestId: "req" });
const record = (overrides: Partial<AccountOrderRecord>): AccountOrderRecord => ({
  brokerage_order_id: "ord-1",
  status: "ACCEPTED",
  action: "BUY",
  total_quantity: "5",
  filled_quantity: "0",
  execution_price: null,
  time_placed: "2026-10-27T14:00:01Z",
  universal_symbol: { symbol: "TLN", raw_symbol: "TLN" } as AccountOrderRecord["universal_symbol"],
  ...overrides,
});

describe("orderOutcome", () => {
  it("records a fill with the broker's quantity and price", () => {
    expect(orderOutcome(record({ status: "EXECUTED", filled_quantity: "5", execution_price: "101.25" }), leg, ctx(false))).toMatchObject({
      kind: "filled",
      brokerageOrderId: "ord-1",
      filledUnits: 5,
      fillPrice: 101.25,
      note: null,
    });
  });

  it("waits for a price on the first response, then falls back to the pre-flight price", () => {
    const executed = record({ status: "EXECUTED", filled_quantity: "5" });
    expect(orderOutcome(executed, leg, ctx(false))).toMatchObject({ kind: "working" });
    expect(orderOutcome(executed, leg, ctx(true))).toMatchObject({ kind: "filled", fillPrice: 100, note: expect.stringContaining("didn't report") });
  });

  it("keeps accepted and partly filled orders open", () => {
    expect(orderOutcome(record({}), leg, ctx(false))).toMatchObject({ kind: "working", filledUnits: 0, snaptradeStatus: "ACCEPTED" });
    expect(orderOutcome(record({ status: "PARTIAL", filled_quantity: "2.7", execution_price: "99" }), leg, ctx(true))).toMatchObject({
      kind: "working",
      filledUnits: 2,
      fillPrice: 99,
    });
  });

  it("treats refusals and unfilled cancellations as rejections, and partial cancellations as final fills", () => {
    expect(orderOutcome(record({ status: "REJECTED" }), leg, ctx(false))).toMatchObject({
      kind: "rejected",
      message: "Alpaca Paper rejected the order (REJECTED).",
    });
    expect(orderOutcome(record({ status: "EXPIRED" }), leg, ctx(true))).toMatchObject({ kind: "rejected", code: "broker_expired" });
    expect(orderOutcome(record({ status: "PARTIAL_CANCELED", filled_quantity: "3", execution_price: "98" }), leg, ctx(true))).toMatchObject({
      kind: "filled",
      filledUnits: 3,
      note: expect.stringContaining("Partly filled: 3 of 5"),
    });
  });
});

describe("matchUnknown", () => {
  const unknown = { symbol: "TLN", action: "BUY", units: 5, claimedAt: new Date("2026-10-27T14:00:00Z") };

  it("finds the broker's order by symbol, side, quantity, and time", () => {
    const records = [
      record({ brokerage_order_id: "older", time_placed: "2026-10-27T13:50:00Z" }),
      record({ brokerage_order_id: "sell", action: "SELL" }),
      record({ brokerage_order_id: "wrong-size", total_quantity: "4" }),
      record({ brokerage_order_id: "match" }),
    ];
    expect(matchUnknown(unknown, records, new Set())?.brokerage_order_id).toBe("match");
    expect(matchUnknown(unknown, records, new Set(["match"]))).toBeNull();
  });
});
