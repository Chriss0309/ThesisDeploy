import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/trpc/[trpc]/route";
import { getCurrentUser } from "@/lib/auth/current-user";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { procedureFailure } from "@/lib/errors";
import { drainExecution } from "@/lib/execution/drain";
import { preflightForGuest, requireExecution } from "@/lib/execution/service";
import { ExecutionError } from "@/lib/execution/store";
import { createDemoThesis, createThesis, ThesisError } from "@/lib/thesis/service";
import { appRouter, type AppRouter } from "@/server";
import { createCallerFactory } from "@/server/trpc";
import type { DrainEvent, ExecutionView } from "@/types/execution";

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/execution/drain", () => ({ drainExecution: vi.fn() }));
vi.mock("@/lib/execution/service", async (original) => ({
  ...(await original<typeof import("@/lib/execution/service")>()),
  preflightForGuest: vi.fn(),
  requireExecution: vi.fn(),
}));
vi.mock("@/lib/snaptrade/client", async (original) => ({
  ...(await original<typeof import("@/lib/snaptrade/client")>()),
  snapTradeContext: vi.fn(),
}));
vi.mock("@/lib/thesis/service", async (original) => ({
  ...(await original<typeof import("@/lib/thesis/service")>()),
  createDemoThesis: vi.fn(),
  createThesis: vi.fn(),
}));

const ORIGIN = "http://127.0.0.1:3000";
const UUID = "00000000-0000-4000-8000-000000000001";
const GUEST = "guest-token-guest-token-guest-token";
const USER = { id: "user-1", name: "Ada", email: "ada@example.com", emailVerified: true };

const THESIS_INPUT = {
  prompt: "AI power",
  presetKey: null,
  accountId: "acct",
  currency: "USD",
  budget: 1000,
  overlapMode: "auto",
};
const PREFLIGHT_INPUT = {
  basketId: null,
  thesisId: null,
  accountId: "acct",
  currency: "USD",
  budget: 1000,
  thesis: { title: "T", summary: "S", riskProfile: "moderate" },
  lines: [{ symbol: "AAA", companyName: "A", universalSymbolId: null, targetWeight: 1, units: 1 }],
};

type Options = { headers?: Record<string, string>; body?: string };

function post(path: string, input: unknown, { headers, body }: Options = {}) {
  return POST(
    new NextRequest(`${ORIGIN}/api/trpc/${path}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers },
      body: body ?? JSON.stringify(input),
    }),
  );
}

async function failure(response: Response) {
  const { error } = (await response.json()) as {
    error: { message: string; data: Record<string, unknown> };
  };
  return { status: response.status, message: error.message, data: error.data };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://example/test");
  vi.mocked(getCurrentUser).mockResolvedValue(null);
});

describe("the tRPC boundary", () => {
  it("rejects a cross-origin request before running anything", async () => {
    const response = await post("demo.createThesis", THESIS_INPUT, { headers: { origin: "https://evil.example" } });
    expect(await failure(response)).toMatchObject({
      status: 403,
      message: "Cross-origin requests are not allowed.",
      data: { appCode: "cross_origin" },
    });
    expect(createDemoThesis).not.toHaveBeenCalled();
  });

  it("accepts a same-origin request", async () => {
    vi.mocked(createDemoThesis).mockResolvedValue({ ok: true } as never);
    const response = await post("demo.createThesis", THESIS_INPUT, {
      headers: { origin: ORIGIN, "x-real-ip": "1.2.3.4" },
    });
    expect(response.status).toBe(200);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded"])("refuses a mutation sent as %s", async (type) => {
    const response = await post("demo.createThesis", THESIS_INPUT, {
      headers: { "content-type": type, "x-real-ip": "1.2.3.4" },
    });
    expect(response.status).toBe(415);
    expect(createDemoThesis).not.toHaveBeenCalled();
  });

  it("refuses a mutation over GET", async () => {
    const response = await GET(
      new NextRequest(`${ORIGIN}/api/trpc/demo.createThesis`, { headers: { host: "127.0.0.1:3000" } }),
    );
    expect(response.status).toBe(405);
    expect(createDemoThesis).not.toHaveBeenCalled();
  });

  it("refuses a batch of more than one call", async () => {
    const response = await post(
      "demo.preflight,demo.preflight?batch=1",
      { 0: PREFLIGHT_INPUT, 1: PREFLIGHT_INPUT },
    );
    expect(response.status).toBe(400);
    expect(preflightForGuest).not.toHaveBeenCalled();
  });

  it("sends each procedure's own wording for invalid input, never the schema's issues", async () => {
    const response = await post("demo.preflight", { budget: "lots" });
    const result = await failure(response);
    expect(result).toMatchObject({
      status: 400,
      message: "Check the basket, then try pre-flight again.",
      data: { appCode: "invalid_request" },
    });
    expect(JSON.stringify(result)).not.toContain("budget");
  });

  it("sends a signed-out caller the procedure's own wording", async () => {
    const response = await post("theses.create", THESIS_INPUT);
    expect(await failure(response)).toMatchObject({
      status: 401,
      message: "Sign in with SnapTrade to generate a thesis.",
      data: { appCode: "signed_out" },
    });
    expect(createThesis).not.toHaveBeenCalled();
  });

  it("carries a domain error's status, code, and extras", async () => {
    vi.mocked(preflightForGuest).mockRejectedValue(
      new ExecutionError("execution_active", 409, "Finish it first.", { executionId: UUID, retryAfterSeconds: 7 }),
    );
    expect(await failure(await post("demo.preflight", PREFLIGHT_INPUT))).toMatchObject({
      status: 409,
      message: "Finish it first.",
      data: { appCode: "execution_active", executionId: UUID, retryAfterSeconds: 7 },
    });
  });

  it("carries a thesis rate limit's wait", async () => {
    vi.mocked(createDemoThesis).mockRejectedValue(new ThesisError("generation_limit", 429, "Slow down.", 90));
    const response = await post("demo.createThesis", THESIS_INPUT, { headers: { "x-real-ip": "1.2.3.4" } });
    expect(await failure(response)).toMatchObject({
      status: 429,
      data: { appCode: "generation_limit", retryAfterSeconds: 90 },
    });
  });

  it("tells a caller with expired SnapTrade access to sign in again", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER as never);
    vi.mocked(createThesis).mockRejectedValue(new ReauthRequiredError());
    expect(await failure(await post("theses.create", THESIS_INPUT))).toMatchObject({
      status: 401,
      message: "Your SnapTrade access expired. Sign in again to continue.",
      data: { appCode: "reauth_required" },
    });
  });

  it("hides an unexpected error's message and uses the procedure's fallback", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getCurrentUser).mockResolvedValue(USER as never);
    vi.mocked(createThesis).mockRejectedValue(new Error("postgres://admin:hunter2@db/secret"));
    const result = await failure(await post("theses.create", THESIS_INPUT));
    expect(result).toMatchObject({
      status: 500,
      message: "Something went wrong building this basket. Try again.",
      data: { appCode: "internal" },
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("hunter2");
  });

  it("hides a failure that happens before any procedure runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getCurrentUser).mockRejectedValue(new Error("postgres://admin:hunter2@db/secret"));
    const result = await failure(await post("demo.preflight", PREFLIGHT_INPUT));
    expect(result).toMatchObject({ status: 500, message: "Something went wrong. Try again." });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("never sends a stack trace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(preflightForGuest).mockRejectedValue(new Error("boom"));
    const result = await failure(await post("demo.preflight", PREFLIGHT_INPUT));
    expect(result.data).not.toHaveProperty("stack");
  });

  it("reports a missing database before doing any work", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(await failure(await post("demo.preflight", PREFLIGHT_INPUT))).toMatchObject({
      status: 503,
      data: { appCode: "not_configured" },
    });
    expect(preflightForGuest).not.toHaveBeenCalled();
  });

  it("marks responses uncacheable", async () => {
    vi.mocked(preflightForGuest).mockResolvedValue({} as never);
    const response = await post("demo.preflight", PREFLIGHT_INPUT);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

describe("the guest cookie", () => {
  it("is issued with a visitor's first basket", async () => {
    vi.mocked(createDemoThesis).mockResolvedValue({} as never);
    const response = await post("demo.createThesis", THESIS_INPUT, { headers: { "x-real-ip": "1.2.3.4" } });
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toMatch(/^td_guest=[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
  });

  it("is Secure over https", async () => {
    vi.mocked(preflightForGuest).mockResolvedValue({} as never);
    const response = await post("demo.preflight", PREFLIGHT_INPUT, { headers: { "x-forwarded-proto": "https" } });
    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });

  it("is left alone for a returning visitor", async () => {
    vi.mocked(preflightForGuest).mockResolvedValue({} as never);
    const response = await post("demo.preflight", PREFLIGHT_INPUT, { headers: { cookie: `td_guest=${GUEST}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("is not issued when the call fails", async () => {
    vi.mocked(preflightForGuest).mockRejectedValue(new ExecutionError("guest_limit", 429, "Used up."));
    const response = await post("demo.preflight", PREFLIGHT_INPUT);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("the server caller", () => {
  it("keeps the original error, so a page can tell failures apart", async () => {
    const original = new ReauthRequiredError();
    vi.mocked(createThesis).mockRejectedValue(original);
    const caller = createCallerFactory(appRouter)({
      user: USER as never,
      sessionToken: null,
      guestToken: null,
      clientIp: null,
      secureCookies: false,
      resHeaders: new Headers(),
    });
    const failed = await caller.theses.create(THESIS_INPUT as never).catch((error: unknown) => error);
    expect(procedureFailure(failed)).toBe(original);
  });
});

describe("signing out", () => {
  it("clears the session cookie and says where to land", async () => {
    const response = await post("auth.logout", { disconnect: false });
    const body = (await response.json()) as { result: { data: { location: string } } };
    expect(body.result.data.location).toBe("/?auth=signed_out");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("streaming a drain", () => {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        url: `${ORIGIN}/api/trpc`,
        fetch: (input, init) => POST(new NextRequest(String(input), init as ConstructorParameters<typeof NextRequest>[1])),
      }),
    ],
  });

  const owned = (mode: string) => ({ view: { mode } as ExecutionView, userId: null }) as never;
  const input = { executionId: UUID };

  beforeEach(() => {
    vi.mocked(requireExecution).mockResolvedValue(owned("paper"));
  });

  it("delivers each event in order as the server yields it", async () => {
    const first = { type: "leg", seq: 1 } as unknown as DrainEvent;
    const last = { type: "done", reason: "complete" } as unknown as DrainEvent;
    vi.mocked(drainExecution).mockImplementation(async function* () {
      yield first;
      yield last;
    });
    const events: DrainEvent[] = [];
    for await (const event of await client.executions.drain.mutate(input)) events.push(event);
    expect(events).toEqual([first, last]);
  });

  it("turns a crash mid-run into an error event, so the client can offer to resume", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(drainExecution).mockImplementation(async function* () {
      yield { type: "leg", seq: 1 } as unknown as DrainEvent;
      throw new Error("postgres://admin:hunter2@db/secret");
    });
    const events: DrainEvent[] = [];
    for await (const event of await client.executions.drain.mutate(input)) events.push(event);
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "internal",
      message: "The queue stopped unexpectedly. Resume to continue.",
    });
  });

  it("rejects an execution the caller doesn't own without streaming anything", async () => {
    vi.mocked(requireExecution).mockRejectedValue(new ExecutionError("not_found", 404, "Execution not found."));
    await expect(client.executions.drain.mutate(input)).rejects.toMatchObject({
      message: "Execution not found.",
      data: { appCode: "not_found" },
    });
    expect(drainExecution).not.toHaveBeenCalled();
  });

  it("stops claiming legs once the client aborts", async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(drainExecution).mockImplementation(async function* (_owned, options) {
      seen = options?.signal;
      yield { type: "leg", seq: 1 } as unknown as DrainEvent;
      await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
    });
    const controller = new AbortController();
    const events = await client.executions.drain.mutate(input, { signal: controller.signal });
    const iterator = events[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await iterator.next().catch(() => undefined);
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });
});
