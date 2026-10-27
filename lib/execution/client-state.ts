import type { DrainEvent, ExecutionView, LegView } from "@/lib/execution/types";

// Browser-side helpers for the drain stream. No server imports.

/** Parses newline-delimited JSON from a streamed response body. */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as T;
  } finally {
    reader.releaseLock();
  }
}

const byOrder = (a: LegView, b: LegView) => a.seq - b.seq || a.attempt - b.attempt;

export function upsertLeg(execution: ExecutionView, leg: LegView): ExecutionView {
  const legs = execution.legs.some((existing) => existing.id === leg.id)
    ? execution.legs.map((existing) => (existing.id === leg.id ? leg : existing))
    : [...execution.legs, leg].sort(byOrder);
  return { ...execution, status: execution.status === "queued" ? "running" : execution.status, legs };
}

export function applyDrainEvent(execution: ExecutionView, event: DrainEvent): ExecutionView {
  switch (event.type) {
    case "leg":
      return upsertLeg(execution, event.leg);
    case "done":
      return event.execution;
    default:
      return execution;
  }
}

/** "[00:02s]" offsets from the start of the execution. */
export function elapsedLabel(startedAt: string | null, at: string | null): string {
  if (!startedAt || !at) return "--:--s";
  const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(startedAt)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}s`;
}
