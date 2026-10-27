import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { completeLogin, signOut, startLogin } from "@/lib/auth/flow";
import { ReauthRequiredError, getGrantSummary } from "@/lib/auth/vault";
import { closeDb, getDb } from "@/lib/db/client";
import { getSnapshot, loadOverview } from "@/lib/portfolio/service";
import type { PortfolioAccount } from "@/lib/portfolio/types";
import {
  SnapTradeError,
  callSnapTrade,
  hashAccountId,
  snapTradeContext,
  type SnapTradeContext,
} from "@/lib/snaptrade/client";
import { ACCOUNT_LIMIT_PER_MINUTE } from "@/lib/snaptrade/rate-budget";
import { startOAuthStub } from "@/scripts/oauth-stub.mjs";
import { startSnapTradeApiStub } from "@/scripts/snaptrade-api-stub.mjs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT_URI = "http://127.0.0.1:3000/api/auth/callback";

describe.skipIf(!TEST_DATABASE_URL)("SnapTrade client and Portfolio X-Ray against stubs and Postgres", () => {
  let oauth: Awaited<ReturnType<typeof startOAuthStub>>;
  let api: Awaited<ReturnType<typeof startSnapTradeApiStub>>;
  let config: AuthConfig;
  let ctx: SnapTradeContext;
  let sessionToken: string;

  beforeAll(async () => {
    oauth = await startOAuthStub({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    vi.stubEnv("SNAPTRADE_ISSUER", oauth.issuer);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("SNAPTRADE_OAUTH_REDIRECT_URI", REDIRECT_URI);
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("base64"));
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    config = getAuthConfig();
  });

  afterAll(async () => {
    await oauth?.close();
    await closeDb();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls, account_snapshots restart identity cascade`;
    // A fresh API stub per test, so its rolling rate windows start empty like the truncated api_calls.
    api = await startSnapTradeApiStub();
    vi.stubEnv("SNAPTRADE_API_BASE_URL", api.url);

    const { authorizationUrl, state } = await startLogin(config, "/portfolio");
    const location = new URL((await fetch(authorizationUrl, { redirect: "manual" })).headers.get("location") ?? "");
    const result = await completeLogin(
      config,
      {
        code: location.searchParams.get("code"),
        state: location.searchParams.get("state"),
        error: null,
        iss: location.searchParams.get("iss"),
      },
      state,
    );
    if (!result.ok) throw new Error(`sign-in failed: ${result.error}`);
    sessionToken = result.session.token;
    const user = await getDb().appUser.findFirstOrThrow();
    ctx = snapTradeContext(user.id);
  });

  afterEach(() => api.close());

  const apiCalls = () => getDb().apiCall.findMany({ orderBy: { id: "asc" } });
  const tfsa = async (): Promise<PortfolioAccount> =>
    (await loadOverview(ctx)).accounts.find((account) => account.id === "demo-acct-tfsa")!;

  it("loads accounts and records every call in api_calls without account IDs", async () => {
    const overview = await loadOverview(ctx);
    expect(overview.accounts).toHaveLength(4);
    expect(overview.accounts.find((account) => account.id === "demo-acct-tfsa")?.capability).toBe("trade");

    const rows = await apiCalls();
    expect(rows.map((row) => [row.operation, row.httpStatus, row.accountHash]).sort()).toEqual([
      ["listAllUserAccounts", 200, null],
      ["listBrokerageAuthorizations", 200, null],
    ]);
    expect(rows.every((row) => row.requestId && row.userId === ctx.userId && row.latencyMs >= 0)).toBe(true);
    const events = await getDb().event.findMany({ where: { name: "accounts_loaded" } });
    expect(events[0]?.props).toEqual({ accounts: 4, hiddenAccounts: 1 });
  });

  it("caches balances and positions for 10 minutes and refetches on refresh", async () => {
    const account = await tfsa();
    const before = api.stats.requests;

    const first = await getSnapshot(ctx, account);
    expect(first.source).toBe("live");
    expect(api.stats.requests - before).toBe(2);

    const second = await getSnapshot(ctx, account);
    expect(second.source).toBe("cache");
    expect(second.snapshot).toEqual(first.snapshot);
    expect(api.stats.requests - before).toBe(2);

    expect((await getSnapshot(ctx, account, { refresh: true })).source).toBe("live");
    expect(api.stats.requests - before).toBe(4);

    const scoped = (await apiCalls()).filter((row) => row.accountHash);
    expect(scoped).toHaveLength(4);
    expect(new Set(scoped.map((row) => row.accountHash))).toEqual(
      new Set([hashAccountId(config, account.id)]),
    );
    expect(scoped.every((row) => row.accountHash !== account.id && row.brokerageSlug === "QUESTRADE")).toBe(true);
    expect(scoped.map((row) => row.accountRemaining)).toEqual(expect.arrayContaining([9, 8, 7, 6]));
  });

  it("coalesces identical concurrent loads into one set of SnapTrade calls", async () => {
    const account = await tfsa();
    const before = api.stats.requests;
    const [first, second] = await Promise.all([
      Promise.all([loadOverview(ctx), getSnapshot(ctx, account)]),
      Promise.all([loadOverview(ctx), getSnapshot(ctx, account)]),
    ]);
    expect(second).toEqual(first);
    expect(api.stats.requests - before).toBe(4);
  });

  it("refreshes the access token once after a 401 and retries", async () => {
    const refreshes = oauth.stats.refresh;
    api.failNext(401);
    const accounts = await callSnapTrade(ctx, "listAllUserAccounts", (apis) => apis.accounts.listAllUserAccounts());
    expect(accounts.results.length).toBeGreaterThan(0);
    expect(oauth.stats.refresh - refreshes).toBe(1);
    expect((await apiCalls()).map((row) => row.httpStatus)).toEqual([401, 200]);
  });

  it("deletes the grant and requires re-authorization when the refreshed token is rejected too", async () => {
    api.failNext(401, 401);
    await expect(
      callSnapTrade(ctx, "listAllUserAccounts", (apis) => apis.accounts.listAllUserAccounts()),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(await getGrantSummary(ctx.userId)).toBeNull();
  });

  it("surfaces a 429 with its wait time and never retries it", async () => {
    api.failNext(429);
    const before = api.stats.requests;
    const call = callSnapTrade(
      ctx,
      "getUserAccountBalance",
      (apis) => apis.accounts.getUserAccountBalance({ accountId: "demo-acct-tfsa" }),
      { accountId: "demo-acct-tfsa" },
    );
    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SnapTradeError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429 });
    expect((error as SnapTradeError).retryAfterSeconds).toBeGreaterThan(0);
    expect(api.stats.requests - before).toBe(1);
  });

  it("keeps an account under SnapTrade's limit across repeated refreshes", async () => {
    const account = await tfsa();
    const results = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      results.push(await getSnapshot(ctx, account, { refresh: true }));
    }

    expect(api.stats.rateLimited).toBe(0);
    const scoped = (await apiCalls()).filter((row) => row.accountHash);
    expect(scoped.length).toBeLessThan(ACCOUNT_LIMIT_PER_MINUTE);
    expect(results.at(-1)).toMatchObject({ source: "cache", warning: { reason: "rate_limited" } });
    expect(results.at(-1)?.warning?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("serves the cached snapshot when SnapTrade is unreachable and records the failed call", async () => {
    const account = await tfsa();
    await getSnapshot(ctx, account);
    const offline = { ...ctx, apiBaseUrl: "http://127.0.0.1:1" };

    await expect(getSnapshot(offline, account, { refresh: true })).resolves.toMatchObject({
      source: "cache",
      warning: { reason: "unavailable" },
    });
    expect((await apiCalls()).some((row) => row.httpStatus === null && row.accountHash)).toBe(true);

    await getDb().accountSnapshot.deleteMany();
    await expect(getSnapshot(offline, account)).rejects.toMatchObject({ code: "network" });
  });

  it("deletes cached snapshots when the user disconnects SnapTrade", async () => {
    await getSnapshot(ctx, await tfsa());
    expect(await getDb().accountSnapshot.count()).toBe(1);
    await signOut(config, sessionToken, { disconnect: true });
    expect(await getDb().accountSnapshot.count()).toBe(0);
  });
});
