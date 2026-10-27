// The telemetry drawer payload. Client components import these types, so this
// module must stay free of server-only imports.

/** Distinct people per funnel step; guests skip sign-in, so their `connected` is null. */
export type FunnelCohort = {
  connected: number | null;
  generated: number;
  deployed: number;
  /** Baskets served and deployed (events, not people). */
  baskets: { generated: number; deployed: number };
};

export type ResolutionSource = {
  /** `snaptrade` for signed-in baskets, `demo` for the guest demo's fixture price feed. */
  source: "snaptrade" | "demo";
  proposed: number;
  resolved: number;
  /** Why the rest were dropped, most common first. */
  dropped: { reason: string; count: number }[];
};

export type BrokerageOrders = {
  brokerage: string;
  mode: "paper" | "live";
  /** Leg attempts with a result; a retry is a second order. */
  orders: number;
  succeeded: number;
};

export type OperationLatency = {
  operation: string;
  calls: number;
  errors: number;
  rateLimited: number;
  p50Ms: number;
  p95Ms: number;
};

export type TelemetrySnapshot = {
  funnel: { signedIn: FunnelCohort; guest: FunnelCohort };
  edits: { suggested: number; edited: number; removed: number; resized: number };
  resolution: ResolutionSource[];
  orders: BrokerageOrders[];
  latency: OperationLatency[];
  rateLimits: { count: number; calls: number; lastAt: string | null };
};

export type Viewer = "user" | "guest" | "anonymous";

export type TelemetryPayload = {
  windowDays: number;
  generatedAt: string;
  global: TelemetrySnapshot;
  /** The current signed-in user and/or demo cookie; null before either has any identity. */
  you: TelemetrySnapshot | null;
  viewer: Viewer;
};
