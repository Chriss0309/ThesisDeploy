// Local stand-in for the SnapTrade account-data endpoints used by Portfolio
// X-Ray, serving lib/portfolio/demo-fixtures.json. It requires a Bearer token
// and enforces the documented per-account limit (rolling 60s) with
// X-RateLimit-Account-* headers and SnapTrade's 429 body. Never used by a
// deployed app: point SNAPTRADE_API_BASE_URL at it locally.
//
//   node scripts/snaptrade-api-stub.mjs   # http://127.0.0.1:4020
//   POST /__stub/fail-next?status=401     # next API request answers 401
//   GET  /__stub/stats                    # request counters

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const FIXTURES = JSON.parse(
  readFileSync(new URL("../lib/portfolio/demo-fixtures.json", import.meta.url), "utf8"),
);

export async function startSnapTradeApiStub({ port = 0, data = FIXTURES, accountLimit = 10 } = {}) {
  const stats = { requests: 0, rateLimited: 0, byPath: {} };
  const failures = [];
  const windows = new Map();

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-request-id": randomUUID().replaceAll("-", ""),
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  // Rolling 60-second window per account, like SnapTrade's account-level limit.
  function takeAccountSlot(accountId) {
    const now = Date.now();
    const recent = (windows.get(accountId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= accountLimit) {
      windows.set(accountId, recent);
      const reset = Math.ceil((recent[0] + 60_000 - now) / 1000);
      return { allowed: false, headers: limitHeaders(0, reset), reset };
    }
    recent.push(now);
    windows.set(accountId, recent);
    return { allowed: true, headers: limitHeaders(accountLimit - recent.length, Math.ceil((recent[0] + 60_000 - now) / 1000)) };
  }

  const limitHeaders = (remaining, reset) => ({
    "x-ratelimit-account-limit": String(accountLimit),
    "x-ratelimit-account-remaining": String(remaining),
    "x-ratelimit-account-reset": String(reset),
  });

  function route(path) {
    if (path === "/authorizations") return { body: data.connections };
    if (path === "/accounts/all") return { body: data.accounts };
    const match = /^\/accounts\/([^/]+)\/(balances|positions\/all)$/.exec(path);
    if (!match) return null;
    const accountId = decodeURIComponent(match[1]);
    const body = match[2] === "balances" ? data.balances[accountId] : data.positions[accountId];
    return { accountId, body };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://stub");
    if (req.method === "POST" && url.pathname === "/__stub/fail-next") {
      failures.push(Number(url.searchParams.get("status") ?? 500));
      return json(res, 200, { queued: failures.length });
    }
    if (req.method === "GET" && url.pathname === "/__stub/stats") return json(res, 200, stats);

    const found = req.method === "GET" ? route(url.pathname) : null;
    if (!found) return json(res, 404, { detail: "Not found" });
    stats.requests++;
    stats.byPath[url.pathname] = (stats.byPath[url.pathname] ?? 0) + 1;

    if (!/^Bearer \S+$/.test(req.headers.authorization ?? "")) {
      return json(res, 401, { detail: "Authentication credentials were not provided." });
    }

    let headers = {};
    if (found.accountId) {
      const slot = takeAccountSlot(found.accountId);
      headers = slot.headers;
      if (!slot.allowed) {
        stats.rateLimited++;
        return json(
          res,
          429,
          { detail: `Request was throttled. Expected available in ${slot.reset} seconds.`, status_code: 429, code: "0000" },
          headers,
        );
      }
    }

    const failure = failures.shift();
    if (failure) return json(res, failure, { detail: `Injected HTTP ${failure}` }, headers);
    if (found.body === undefined) return json(res, 404, { detail: "Account not found" }, headers);
    return json(res, 200, found.body, headers);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { detail: "Stub error" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    failNext: (...statuses) => failures.push(...statuses),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startSnapTradeApiStub({ port: Number(process.env.STUB_API_PORT ?? 4020) });
  console.log(`Stub SnapTrade API listening at ${stub.url}`);
}
