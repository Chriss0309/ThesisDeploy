// Local stand-in for the SnapTrade account-data endpoints used by Portfolio
// X-Ray and Thesis Studio, serving lib/portfolio/demo-fixtures.json and
// lib/thesis/demo-quotes.json. It requires a Bearer token and enforces the
// documented per-account limit (rolling 60s) on balances, positions, and
// quotes with X-RateLimit-Account-* headers and SnapTrade's 429 body. Never
// used by a deployed app: point SNAPTRADE_API_BASE_URL at it locally.
//
//   node scripts/snaptrade-api-stub.mjs   # http://127.0.0.1:4020
//   POST /__stub/fail-next?status=401     # next API request answers 401
//   POST /__stub/unknown-quotes?mode=reject  # unknown tickers fail the quotes batch (default: omitted)
//   GET  /__stub/stats                    # request counters

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const FIXTURES = JSON.parse(
  readFileSync(new URL("../lib/portfolio/demo-fixtures.json", import.meta.url), "utf8"),
);
const QUOTES = JSON.parse(readFileSync(new URL("../lib/thesis/demo-quotes.json", import.meta.url), "utf8")).quotes;

// Ticker or name match, exact tickers first, at most 20 results.
function searchSymbols(quotes, query) {
  const needle = String(query ?? "").trim().toUpperCase();
  if (!needle) return [];
  const rank = (symbol) =>
    symbol.symbol.toUpperCase() === needle || symbol.raw_symbol?.toUpperCase() === needle
      ? 0
      : symbol.symbol.toUpperCase().startsWith(needle)
        ? 1
        : 2;
  return quotes
    .map((quote) => quote.symbol)
    .filter((symbol) => rank(symbol) < 2 || symbol.description?.toUpperCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 20);
}

export async function startSnapTradeApiStub({
  port = 0,
  data = FIXTURES,
  quotes = QUOTES,
  accountLimit = 10,
} = {}) {
  const stats = { requests: 0, rateLimited: 0, byPath: {}, quoteRequests: [] };
  const failures = [];
  const windows = new Map();
  let unknownQuotes = "omit";

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

  function quotesFor(url) {
    const requested = (url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    stats.quoteRequests.push(requested);
    if (requested.length === 0 || requested.length > 10) {
      return { status: 400, body: { detail: "Provide between 1 and 10 symbols." } };
    }
    const byTicker = url.searchParams.get("use_ticker") === "true";
    const found = requested.map((value) =>
      quotes.find((quote) =>
        byTicker ? quote.symbol.symbol.toUpperCase() === value.toUpperCase() : quote.symbol.id === value,
      ),
    );
    if (unknownQuotes === "reject" && found.some((quote) => !quote)) {
      return { status: 400, body: { detail: "Invalid symbol provided." } };
    }
    return { body: found.filter(Boolean) };
  }

  function route(method, url, body) {
    const path = url.pathname;
    if (method === "GET" && path === "/authorizations") return { body: data.connections };
    if (method === "GET" && path === "/accounts/all") return { body: data.accounts };
    const account = /^\/accounts\/([^/]+)\/(balances|positions\/all|quotes|symbols)$/.exec(path);
    if (!account) return null;
    const accountId = decodeURIComponent(account[1]);
    if (!data.accounts.results.some((entry) => entry.id === accountId)) {
      return { accountId, limited: true, body: undefined };
    }
    switch (`${method} ${account[2]}`) {
      case "GET balances":
        return { accountId, limited: true, body: data.balances[accountId] };
      case "GET positions/all":
        return { accountId, limited: true, body: data.positions[accountId] };
      case "GET quotes":
        return { accountId, limited: true, ...quotesFor(url) };
      case "POST symbols":
        // Symbol search is not on SnapTrade's list of account-limited endpoints.
        return { accountId, limited: false, body: searchSymbols(quotes, body?.substring) };
      default:
        return null;
    }
  }

  async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://stub");
    if (req.method === "POST" && url.pathname === "/__stub/fail-next") {
      failures.push(Number(url.searchParams.get("status") ?? 500));
      return json(res, 200, { queued: failures.length });
    }
    if (req.method === "POST" && url.pathname === "/__stub/unknown-quotes") {
      unknownQuotes = url.searchParams.get("mode") === "reject" ? "reject" : "omit";
      return json(res, 200, { unknownQuotes });
    }
    if (req.method === "GET" && url.pathname === "/__stub/stats") return json(res, 200, stats);

    const found = route(req.method, url, req.method === "POST" ? await readJson(req) : null);
    if (!found) return json(res, 404, { detail: "Not found" });
    stats.requests++;
    stats.byPath[url.pathname] = (stats.byPath[url.pathname] ?? 0) + 1;

    if (!/^Bearer \S+$/.test(req.headers.authorization ?? "")) {
      return json(res, 401, { detail: "Authentication credentials were not provided." });
    }

    let headers = {};
    if (found.limited) {
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
    return json(res, found.status ?? 200, found.body, headers);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { detail: "Stub error" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    failNext: (...statuses) => failures.push(...statuses),
    setUnknownQuotes: (mode) => {
      unknownQuotes = mode;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startSnapTradeApiStub({ port: Number(process.env.STUB_API_PORT ?? 4020) });
  console.log(`Stub SnapTrade API listening at ${stub.url}`);
}
