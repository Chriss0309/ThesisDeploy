import axios, { type AxiosResponse } from "axios";
import {
  AccountInformationApi,
  ConnectionsApi,
  SnaptradeError,
  type PersonalApiKeyAuth,
} from "snaptrade-typescript-sdk";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { hmacHex } from "@/lib/auth/crypto";
import { ReauthRequiredError, deleteGrant, getAccessToken } from "@/lib/auth/vault";
import { getDb } from "@/lib/db/client";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { decideBudget, readBudgetWindow } from "@/lib/snaptrade/rate-budget";

export type SnapTradeApis = {
  accounts: AccountInformationApi<PersonalApiKeyAuth>;
  connections: ConnectionsApi<PersonalApiKeyAuth>;
};

export type SnapTradeContext = { config: AuthConfig; userId: string; apiBaseUrl: string };

export function snapTradeContext(userId: string): SnapTradeContext {
  return { config: getAuthConfig(), userId, apiBaseUrl: serverEnv().SNAPTRADE_API_BASE_URL };
}

/**
 * OAuth requests carry only the Bearer token. The SDK has no OAuth mode, but
 * its API classes built without a Configuration add no Commercial auth.
 * `validateStatus` accepts every status so non-2xx responses never reach the
 * SDK's hidden 429 retry loop (5s, 10s, 20s); this module handles them.
 */
export function createApis(accessToken: string, apiBaseUrl: string): SnapTradeApis {
  const http = axios.create({
    headers: { Authorization: `Bearer ${accessToken}` },
    validateStatus: () => true,
    timeout: 15_000,
  });
  return {
    accounts: new AccountInformationApi<PersonalApiKeyAuth>(undefined, apiBaseUrl, http),
    connections: new ConnectionsApi<PersonalApiKeyAuth>(undefined, apiBaseUrl, http),
  };
}

type ErrorCode = "rate_limited" | "budget_exhausted" | "upstream" | "network";

export class SnapTradeError extends Error {
  name = "SnapTradeError";
  constructor(
    readonly code: ErrorCode,
    readonly operation: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly requestId: string | null = null,
    options?: { cause: unknown },
  ) {
    super(`SnapTrade ${operation} failed: ${code}${status ? ` (HTTP ${status})` : ""}`, options);
  }
}

type HeaderSource = Pick<AxiosResponse, "headers"> | undefined;

function header(response: HeaderSource, name: string): string | null {
  const value = response?.headers?.[name];
  return value == null ? null : String(value);
}

function numberHeader(response: HeaderSource, name: string): number | null {
  const value = header(response, name);
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * SnapTrade documents X-RateLimit-Account-Reset / X-RateLimit-Reset and a body
 * like "Expected available in 7 seconds."; Retry-After is honored if present.
 */
export function retryAfterSeconds(response: HeaderSource & { data?: unknown }): number | null {
  const retryAfter = numberHeader(response, "retry-after");
  if (retryAfter != null) return retryAfter;
  const accountReset = numberHeader(response, "x-ratelimit-account-reset");
  const customerReset = numberHeader(response, "x-ratelimit-reset");
  if (numberHeader(response, "x-ratelimit-account-remaining") === 0 && accountReset != null) {
    return accountReset;
  }
  if (numberHeader(response, "x-ratelimit-remaining") === 0 && customerReset != null) {
    return customerReset;
  }
  const detail = (response?.data as { detail?: unknown } | undefined)?.detail;
  const match = typeof detail === "string" ? /available in (\d+) seconds?/i.exec(detail) : null;
  if (match) return Number(match[1]);
  return accountReset ?? customerReset;
}

// Raw account IDs never reach telemetry.
export function hashAccountId(config: Pick<AuthConfig, "sessionKey">, accountId: string): string {
  return hmacHex(config.sessionKey, `snaptrade-account:${accountId}`).slice(0, 32);
}

type CallRecord = {
  userId: string;
  operation: string;
  brokerageSlug: string | null;
  accountHash: string | null;
  httpStatus: number | null;
  latencyMs: number;
  requestId: string | null;
  accountRemaining: number | null;
};

async function recordApiCall(data: CallRecord): Promise<void> {
  try {
    await getDb().apiCall.create({ data });
  } catch (error) {
    console.error("[telemetry] api_call dropped", { operation: data.operation, ...describeError(error) });
  }
}

type CallOptions = { accountId?: string; brokerageSlug?: string | null };

/**
 * Calls one SnapTrade endpoint for a user and records it in `api_calls`.
 * Account-scoped calls (pass `accountId`) are checked against the per-account
 * budget first. A 401 refreshes the token once and retries once; a second 401
 * deletes the grant and raises ReauthRequiredError. 429s are never retried
 * here: callers get the wait time and decide.
 */
export async function callSnapTrade<T>(
  ctx: SnapTradeContext,
  operation: string,
  request: (apis: SnapTradeApis) => Promise<AxiosResponse<T>>,
  options: CallOptions = {},
): Promise<T> {
  const accountHash = options.accountId ? hashAccountId(ctx.config, options.accountId) : null;
  if (accountHash) {
    const decision = decideBudget(await readBudgetWindow(accountHash));
    if (!decision.allowed) {
      throw new SnapTradeError("budget_exhausted", operation, null, decision.retryAfterSeconds);
    }
  }

  let accessToken = await getAccessToken(ctx.config, ctx.userId);
  for (let attempt = 1; ; attempt++) {
    const startedAt = performance.now();
    let response: AxiosResponse<T>;
    try {
      response = await request(createApis(accessToken, ctx.apiBaseUrl));
    } catch (error) {
      if (!(error instanceof SnaptradeError) && !axios.isAxiosError(error)) throw error;
      await recordApiCall({
        userId: ctx.userId,
        operation,
        brokerageSlug: options.brokerageSlug ?? null,
        accountHash,
        httpStatus: null,
        latencyMs: Math.round(performance.now() - startedAt),
        requestId: null,
        accountRemaining: null,
      });
      throw new SnapTradeError("network", operation, null, null, null, { cause: error });
    }

    const requestId = header(response, "x-request-id");
    await recordApiCall({
      userId: ctx.userId,
      operation,
      brokerageSlug: options.brokerageSlug ?? null,
      accountHash,
      httpStatus: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      requestId,
      accountRemaining: numberHeader(response, "x-ratelimit-account-remaining"),
    });

    if (response.status >= 200 && response.status < 300) return response.data;
    if (response.status === 401) {
      if (attempt === 1) {
        accessToken = await getAccessToken(ctx.config, ctx.userId, { staleAccessToken: accessToken });
        continue;
      }
      await deleteGrant(ctx.config, ctx.userId);
      throw new ReauthRequiredError("SnapTrade rejected a freshly refreshed access token");
    }
    if (response.status === 429) {
      throw new SnapTradeError("rate_limited", operation, 429, retryAfterSeconds(response), requestId);
    }
    throw new SnapTradeError("upstream", operation, response.status, null, requestId);
  }
}
