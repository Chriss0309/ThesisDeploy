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
//
// Trading, for Live execution tests. Nothing here reaches a broker: orders
// live in memory and fill on a timer, and fills show up in positions.
//   POST /trade/impact, POST /trade/place, GET /accounts/{id}/recentOrders,
//   POST /accounts/{id}/orders/details
//   POST /__stub/orders?mode=accept|fill|partial|never|reject&fillDelayMs=1000
//   POST /__stub/place-then-fail?status=502   # next order is placed, but the response is an error
//   POST /__stub/impact?mode=ok|unsupported|reject&symbol=VRT
//   POST /__stub/recent-orders?mode=ok|unsupported

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
  const stats = { requests: 0, rateLimited: 0, byPath: {}, quoteRequests: [], orderRequests: [], impactRequests: [] };
  const failures = [];
  const windows = new Map();
  let unknownQuotes = "omit";
  const trading = { mode: "accept", fillDelayMs: 1000, impact: "ok", impactSymbol: null, recentOrders: "ok", placeThenFail: [] };
  const orders = new Map();
  const byClientOrderId = new Map();
  /** Filled units per `${accountId}:${SYMBOL}`, layered over the fixture positions. */
  const fills = new Map();

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

  const quoteFor = (symbol) => quotes.find((quote) => quote.symbol.symbol.toUpperCase() === String(symbol).toUpperCase());
  const fillPrice = (quote) => (quote.ask_price > 0 ? quote.ask_price : quote.last_trade_price);
  const knownAccount = (accountId) => data.accounts.results.some((entry) => entry.id === accountId);

  function fill(order, units) {
    const record = order.record;
    const before = Number(record.filled_quantity);
    const total = Number(record.total_quantity);
    const filled = Math.min(total, before + units);
    record.filled_quantity = String(filled);
    record.open_quantity = String(total - filled);
    record.execution_price = String(order.price);
    record.status = filled === total ? "EXECUTED" : "PARTIAL";
    record.time_updated = new Date().toISOString();
    if (filled === total) record.time_executed = record.time_updated;
    const key = `${order.accountId}:${record.universal_symbol.symbol.toUpperCase()}`;
    const sign = record.action === "SELL" ? -1 : 1;
    fills.set(key, (fills.get(key) ?? 0) + sign * (filled - before));
  }

  /** Accepted orders fill once their delay has passed. */
  function advance(order) {
    if (order.record.status === "ACCEPTED" && order.fillAt != null && Date.now() >= order.fillAt) {
      fill(order, Number(order.record.total_quantity));
    }
    return order.record;
  }

  function validTrade(body) {
    if (!body || !knownAccount(body.account_id)) return "Unknown account.";
    if (body.action !== "BUY" && body.action !== "SELL") return "action must be BUY or SELL.";
    if (body.order_type !== "Market" || body.time_in_force !== "Day") return "Only Market/Day orders are accepted here.";
    if (!Number.isInteger(body.units) || body.units <= 0) return "units must be a whole number above zero.";
    return null;
  }

  function impact(body) {
    stats.impactRequests.push(body);
    const invalid = validTrade(body);
    if (invalid) return { status: 400, body: { detail: invalid } };
    const quote = quotes.find((entry) => entry.symbol.id === body.universal_symbol_id);
    if (!quote) return { status: 400, body: { detail: "Unknown universal_symbol_id." } };
    if (trading.impact === "unsupported") {
      return { status: 400, body: { detail: "Order impact is not supported for this brokerage." } };
    }
    if (trading.impact === "reject" && (!trading.impactSymbol || trading.impactSymbol === quote.symbol.symbol)) {
      return { status: 400, body: { detail: "Insufficient buying power for this order." } };
    }
    const cash = data.balances[body.account_id]?.[0]?.cash ?? 0;
    const value = body.units * fillPrice(quote);
    return {
      body: {
        trade: {
          id: randomUUID(),
          account: { id: body.account_id },
          order_type: "Market",
          time_in_force: "Day",
          symbol: { universal_symbol_id: body.universal_symbol_id, symbol: quote.symbol },
          action: body.action,
          units: body.units,
          price: fillPrice(quote),
        },
        trade_impacts: [
          {
            account: body.account_id,
            currency: quote.symbol.currency?.id ?? null,
            remaining_cash: Math.round((cash + (body.action === "SELL" ? value : -value)) * 100) / 100,
            estimated_commission: 0,
            forex_fees: 0,
          },
        ],
      },
    };
  }

  function place(body) {
    stats.orderRequests.push(body);
    const invalid = validTrade(body);
    if (invalid) return { status: 400, body: { detail: invalid } };
    if (body.universal_symbol_id || !body.symbol) return { status: 400, body: { detail: "Send symbol (not universal_symbol_id)." } };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.client_order_id ?? "")) {
      return { status: 400, body: { detail: "client_order_id must be a canonical UUID." } };
    }
    // Brokers that honor client_order_id return the original order for a repeat.
    const repeat = byClientOrderId.get(body.client_order_id);
    if (repeat) return { body: advance(orders.get(repeat)) };
    const quote = quoteFor(body.symbol);
    if (!quote) return { status: 400, body: { detail: `Symbol ${body.symbol} is not tradable at this brokerage.` } };

    const id = `stub_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const record = {
      brokerage_order_id: id,
      status: trading.mode === "reject" ? "REJECTED" : "ACCEPTED",
      universal_symbol: quote.symbol,
      action: body.action,
      total_quantity: String(body.units),
      open_quantity: String(body.units),
      canceled_quantity: "0",
      filled_quantity: "0",
      execution_price: null,
      limit_price: null,
      stop_price: null,
      order_type: "Market",
      time_in_force: "Day",
      time_placed: now,
      time_updated: now,
      time_executed: null,
    };
    const order = { accountId: body.account_id, record, price: fillPrice(quote), fillAt: null };
    orders.set(id, order);
    byClientOrderId.set(body.client_order_id, id);
    if (trading.mode === "fill") fill(order, body.units);
    else if (trading.mode === "partial") fill(order, Math.max(1, Math.floor(body.units / 2)));
    else if (trading.mode === "accept") order.fillAt = Date.now() + trading.fillDelayMs;
    const failure = trading.placeThenFail.shift();
    if (failure) return { status: failure, body: { detail: `Injected HTTP ${failure} after placing the order` } };
    return { body: record };
  }

  function accountOrders(accountId, onlyExecuted) {
    const records = [...orders.values()].filter((order) => order.accountId === accountId).map(advance);
    return onlyExecuted ? records.filter((record) => record.status === "EXECUTED") : records;
  }

  function positionsWithFills(accountId) {
    const base = data.positions[accountId];
    const results = base.results.map((position) => ({ ...position }));
    for (const [key, delta] of fills) {
      const [owner, symbol] = key.split(":");
      if (owner !== accountId || delta === 0) continue;
      const existing = results.find((position) => position.instrument.symbol.toUpperCase() === symbol);
      if (existing) existing.units = String(Number(existing.units) + delta);
      else {
        const quote = quoteFor(symbol);
        results.push({
          instrument: {
            kind: "stock",
            id: `stub-inst-${symbol.toLowerCase()}`,
            symbol: quote.symbol.symbol,
            raw_symbol: quote.symbol.raw_symbol ?? quote.symbol.symbol,
            description: quote.symbol.description,
            currency: quote.symbol.currency?.code ?? null,
            exchange: quote.symbol.exchange?.code ?? null,
            figi_instrument: { figi_code: null, figi_share_class: quote.symbol.figi_instrument?.figi_share_class ?? null },
          },
          units: String(delta),
          price: String(quote.last_trade_price),
          cost_basis: String(quote.last_trade_price),
          currency: quote.symbol.currency?.code ?? null,
          cash_equivalent: false,
        });
      }
    }
    return { ...base, results: results.filter((position) => Number(position.units) !== 0) };
  }

  function route(method, url, body) {
    const path = url.pathname;
    if (method === "GET" && path === "/authorizations") return { body: data.connections };
    if (method === "GET" && path === "/accounts/all") return { body: data.accounts };
    // Trading endpoints are not account-limited; SnapTrade asks for one trade per second per account.
    if (method === "POST" && path === "/trade/impact") return { limited: false, run: () => impact(body) };
    if (method === "POST" && path === "/trade/place") return { limited: false, run: () => place(body) };
    const account = /^\/accounts\/([^/]+)\/(balances|positions\/all|quotes|symbols|recentOrders|orders\/details)$/.exec(path);
    if (!account) return null;
    const accountId = decodeURIComponent(account[1]);
    if (!data.accounts.results.some((entry) => entry.id === accountId)) {
      return { accountId, limited: true, body: undefined };
    }
    switch (`${method} ${account[2]}`) {
      case "GET balances":
        return { accountId, limited: true, body: data.balances[accountId] };
      case "GET positions/all":
        return { accountId, limited: true, run: () => ({ body: positionsWithFills(accountId) }) };
      case "GET recentOrders":
        return {
          accountId,
          limited: true,
          run: () =>
            trading.recentOrders === "unsupported"
              ? { status: 501, body: { detail: "Recent orders are not supported for this brokerage." } }
              : { body: { orders: accountOrders(accountId, url.searchParams.get("only_executed") !== "false") } },
        };
      case "POST orders/details":
        return {
          accountId,
          limited: true,
          run: () => {
            const order = orders.get(body?.brokerage_order_id);
            return order && order.accountId === accountId
              ? { body: advance(order) }
              : { status: 404, body: { detail: "Order not found." } };
          },
        };
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
    if (req.method === "POST" && url.pathname === "/__stub/orders") {
      trading.mode = url.searchParams.get("mode") ?? trading.mode;
      if (url.searchParams.has("fillDelayMs")) trading.fillDelayMs = Number(url.searchParams.get("fillDelayMs"));
      return json(res, 200, { mode: trading.mode, fillDelayMs: trading.fillDelayMs });
    }
    if (req.method === "POST" && url.pathname === "/__stub/place-then-fail") {
      trading.placeThenFail.push(Number(url.searchParams.get("status") ?? 502));
      return json(res, 200, { queued: trading.placeThenFail.length });
    }
    if (req.method === "POST" && url.pathname === "/__stub/impact") {
      trading.impact = url.searchParams.get("mode") ?? "ok";
      trading.impactSymbol = url.searchParams.get("symbol");
      return json(res, 200, { impact: trading.impact, symbol: trading.impactSymbol });
    }
    if (req.method === "POST" && url.pathname === "/__stub/recent-orders") {
      trading.recentOrders = url.searchParams.get("mode") === "unsupported" ? "unsupported" : "ok";
      return json(res, 200, { recentOrders: trading.recentOrders });
    }

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
    const result = found.run ? found.run() : found;
    if (result.body === undefined) return json(res, 404, { detail: "Account not found" }, headers);
    return json(res, result.status ?? 200, result.body, headers);
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
    /** accept (fills after fillDelayMs), fill (at once), partial (half, then stays open), never, or reject. */
    setOrders: (mode, fillDelayMs) => {
      trading.mode = mode;
      if (fillDelayMs != null) trading.fillDelayMs = fillDelayMs;
    },
    placeThenFail: (status = 502) => trading.placeThenFail.push(status),
    /** @param {"ok" | "unsupported" | "reject"} mode @param {string | null} [symbol] only this symbol is rejected */
    setImpact: (mode, symbol = null) => {
      trading.impact = mode;
      trading.impactSymbol = symbol;
    },
    setRecentOrders: (mode) => {
      trading.recentOrders = mode;
    },
    orders: () => [...orders.values()].map((order) => advance(order)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startSnapTradeApiStub({ port: Number(process.env.STUB_API_PORT ?? 4020) });
  console.log(`Stub SnapTrade API listening at ${stub.url}`);
}
