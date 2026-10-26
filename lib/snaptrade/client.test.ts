import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApis, retryAfterSeconds } from "@/lib/snaptrade/client";
import { ACCOUNT_BUDGET_PER_MINUTE, decideBudget } from "@/lib/snaptrade/rate-budget";
import { startSnapTradeApiStub } from "@/scripts/snaptrade-api-stub.mjs";

describe("retryAfterSeconds", () => {
  const response = (headers: Record<string, string>, data?: unknown) => ({ headers, data });

  it("prefers Retry-After, then the exhausted layer's reset header", () => {
    expect(retryAfterSeconds(response({ "retry-after": "3", "x-ratelimit-account-reset": "9" }))).toBe(3);
    expect(
      retryAfterSeconds(
        response({ "x-ratelimit-account-remaining": "0", "x-ratelimit-account-reset": "12", "x-ratelimit-reset": "40" }),
      ),
    ).toBe(12);
    expect(
      retryAfterSeconds(
        response({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "40", "x-ratelimit-account-reset": "12" }),
      ),
    ).toBe(40);
  });

  it("falls back to SnapTrade's documented 429 body", () => {
    expect(
      retryAfterSeconds(response({}, { detail: "Request was throttled. Expected available in 7 seconds." })),
    ).toBe(7);
    expect(retryAfterSeconds(response({}))).toBeNull();
  });
});

describe("decideBudget", () => {
  it("allows calls below the budget and blocks at it or after a zero remaining", () => {
    expect(decideBudget({ used: ACCOUNT_BUDGET_PER_MINUTE - 1, secondsUntilSlot: 30, lastRemaining: 3 })).toEqual({
      allowed: true,
    });
    expect(decideBudget({ used: ACCOUNT_BUDGET_PER_MINUTE, secondsUntilSlot: 12.2, lastRemaining: 2 })).toEqual({
      allowed: false,
      retryAfterSeconds: 13,
    });
    expect(decideBudget({ used: 1, secondsUntilSlot: 0.1, lastRemaining: 0 })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });
});

describe("createApis", () => {
  let stub: Awaited<ReturnType<typeof startSnapTradeApiStub>>;
  beforeAll(async () => {
    stub = await startSnapTradeApiStub({ accountLimit: 1 });
  });
  afterAll(() => stub.close());

  it("sends Bearer-only requests to the canonical paths", async () => {
    const apis = createApis("access-token", stub.url);
    const accounts = await apis.accounts.listAllUserAccounts();
    expect(accounts.status).toBe(200);
    expect(accounts.data.results.length).toBeGreaterThan(0);
    expect(accounts.config.url).toBe(`${stub.url}/accounts/all`);
    expect(accounts.config.headers.Authorization).toBe("Bearer access-token");
    expect(accounts.config.params ?? {}).toEqual({});
  });

  it("returns a 429 immediately instead of entering the SDK's retry loop", async () => {
    const apis = createApis("access-token", stub.url);
    await apis.accounts.getUserAccountBalance({ accountId: "demo-acct-tfsa" });
    const startedAt = Date.now();
    const limited = await apis.accounts.getUserAccountBalance({ accountId: "demo-acct-tfsa" });
    expect(limited.status).toBe(429);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(retryAfterSeconds(limited)).toBeGreaterThan(0);
    expect(stub.stats.rateLimited).toBe(1);
  });
});
