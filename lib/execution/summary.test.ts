import { describe, expect, it } from "vitest";

import { applyDrainEvent, elapsedLabel, readNdjson } from "@/lib/execution/client-state";
import { paperSubmitter } from "@/lib/execution/submitters";
import { deriveStatus, isRetryable, latestAttempts, summarizeLegs, summaryLine } from "@/lib/execution/summary";
import type { ExecutionView, LegView } from "@/lib/execution/types";

const leg = (seq: number, status: LegView["status"], attempt = 1): LegView => ({
  id: `${seq}-${attempt}`,
  seq,
  attempt,
  action: "BUY",
  symbol: `S${seq}`,
  units: 2,
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

describe("leg summaries", () => {
  it("count each order once, by its latest attempt", () => {
    const legs = [leg(1, "executed"), leg(2, "rejected"), leg(2, "executed", 2), leg(3, "pending")];
    expect(latestAttempts(legs).map((l) => l.id)).toEqual(["1-1", "2-2", "3-1"]);
    expect(summarizeLegs(legs)).toEqual({ orders: 3, filled: 2, failed: 0, pending: 1, skipped: 0, open: 0, working: 0, unknown: 0 });
    expect(summaryLine(summarizeLegs(legs))).toBe("2 of 3 legs filled · 1 to go");
  });

  it("derive the execution status", () => {
    expect(deriveStatus([leg(1, "executed"), leg(2, "claimed")])).toBe("running");
    expect(deriveStatus([leg(1, "executed"), leg(2, "executed")])).toBe("completed");
    expect(deriveStatus([leg(1, "executed"), leg(2, "rejected")])).toBe("partial");
    expect(deriveStatus([leg(1, "rejected"), leg(2, "failed")])).toBe("failed");
    expect(deriveStatus([leg(1, "skipped"), leg(2, "skipped")])).toBe("canceled");
    expect(summaryLine(summarizeLegs([leg(1, "executed"), leg(2, "rejected")]))).toBe("1 of 2 legs filled · 1 failed");
  });

  it("hold Live runs in `working` while the broker has open orders, and `partial` while one is unconfirmed", () => {
    expect(deriveStatus([leg(1, "executed"), leg(2, "accepted")])).toBe("working");
    expect(deriveStatus([leg(1, "partial"), leg(2, "executed")])).toBe("working");
    expect(deriveStatus([leg(1, "executed"), leg(2, "unknown")])).toBe("partial");
    expect(deriveStatus([leg(1, "accepted"), leg(2, "pending")])).toBe("running");
    expect(summaryLine(summarizeLegs([leg(1, "executed"), leg(2, "accepted"), leg(3, "unknown")]))).toBe(
      "1 of 3 legs filled · 1 open at the broker · 1 unconfirmed",
    );
    expect(isRetryable(leg(1, "unknown"), [leg(1, "unknown")])).toBe(false);
  });

  it("allow retrying only the latest rejected or failed attempt, up to three attempts", () => {
    const legs = [leg(1, "rejected"), leg(1, "rejected", 2), leg(2, "failed"), leg(3, "executed")];
    expect(isRetryable(legs[0], legs)).toBe(false);
    expect(isRetryable(legs[1], legs)).toBe(true);
    expect(isRetryable(legs[2], legs)).toBe(true);
    expect(isRetryable(legs[3], legs)).toBe(false);
    expect(isRetryable(leg(1, "rejected", 3), [leg(1, "rejected", 3)])).toBe(false);
  });
});

describe("paper submitter", () => {
  const order = { seq: 2, action: "BUY" as const, symbol: "ETN", units: 3, estPrice: 341.25, clientOrderId: "c" };

  it("fills the whole leg at the pre-flight price", async () => {
    const result = await paperSubmitter({ simulateRejectSeq: null })({ ...order, attempt: 1 });
    expect(result).toMatchObject({ kind: "filled", filledUnits: 3, fillPrice: 341.25, snaptradeStatus: "EXECUTED" });
    expect(result.kind === "filled" && result.brokerageOrderId).toMatch(/^paper_[0-9a-f]{32}$/);
  });

  it("rejects only the first attempt of the injected leg", async () => {
    const submit = paperSubmitter({ simulateRejectSeq: 2 });
    expect(await submit({ ...order, attempt: 1 })).toMatchObject({ kind: "rejected", code: "simulated_rejection" });
    expect(await submit({ ...order, attempt: 2 })).toMatchObject({ kind: "filled" });
    expect(await submit({ ...order, seq: 1, attempt: 1 })).toMatchObject({ kind: "filled" });
  });
});

describe("drain stream client", () => {
  it("parses NDJSON split across chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = ['{"type":"pacing","wa', 'itMs":900}\n{"type":"pac', 'ing","waitMs":5}\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readNdjson(body)) events.push(event);
    expect(events).toEqual([
      { type: "pacing", waitMs: 900 },
      { type: "pacing", waitMs: 5 },
    ]);
  });

  it("merges leg updates and takes the final snapshot", () => {
    const execution = {
      status: "queued",
      startedAt: "2026-10-27T15:00:00.000Z",
      legs: [leg(1, "pending"), leg(2, "pending")],
    } as ExecutionView;
    const claimed = applyDrainEvent(execution, { type: "leg", leg: leg(1, "claimed") });
    expect(claimed.status).toBe("running");
    const retry = applyDrainEvent(claimed, { type: "leg", leg: leg(1, "pending", 2) });
    expect(retry.legs.map((l) => l.id)).toEqual(["1-1", "1-2", "2-1"]);
    expect(elapsedLabel(execution.startedAt, "2026-10-27T15:01:02.400Z")).toBe("01:02s");
  });
});
