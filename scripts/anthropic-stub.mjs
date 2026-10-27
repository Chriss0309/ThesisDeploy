// Local stand-in for Anthropic's Messages API, for exercising Thesis Studio
// without spending credits. It answers structured-output requests with the
// committed sample basket that matches the thesis and the budget currency
// (lib/thesis/sample-outputs.json). Never used by a deployed app: set
// ANTHROPIC_BASE_URL to it locally, with any ANTHROPIC_API_KEY.
//
//   node scripts/anthropic-stub.mjs           # http://127.0.0.1:4030
//   POST /__stub/next?stop_reason=refusal     # next response is a refusal
//   POST /__stub/next?status=529              # next request is overloaded
//   GET  /__stub/stats                        # request counters

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const SAMPLES = JSON.parse(readFileSync(new URL("../lib/thesis/sample-outputs.json", import.meta.url), "utf8"));

const THEMES = [
  ["critical-minerals", /mineral|lithium|battery|copper|mining/i],
  ["ai-cybersecurity", /cyber|security|attack/i],
  ["ai-power-nuclear", /./],
];

function sampleFor(content) {
  const thesis = /<thesis>\n([\s\S]*)\n<\/thesis>/.exec(content)?.[1] ?? "";
  const currency = /all in (USD|CAD)\./.exec(content)?.[1] ?? "USD";
  const [key] = THEMES.find(([, pattern]) => pattern.test(thesis));
  return SAMPLES[`${key}:${currency}`];
}

export async function startAnthropicStub({ port = 0, latencyMs = 1500 } = {}) {
  const stats = { requests: 0 };
  const next = [];

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": `req_${randomUUID()}` });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://stub");
    if (req.method === "POST" && url.pathname === "/__stub/next") {
      next.push(Object.fromEntries(url.searchParams));
      return json(res, 200, { queued: next.length });
    }
    if (req.method === "GET" && url.pathname === "/__stub/stats") return json(res, 200, stats);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return json(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    }
    stats.requests++;
    if (!req.headers["x-api-key"] && !/^Bearer \S+$/.test(req.headers.authorization ?? "")) {
      return json(res, 401, { type: "error", error: { type: "authentication_error", message: "API key required" } });
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.output_config?.format?.type !== "json_schema") {
      return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "expected a json_schema output format" } });
    }

    const override = next.shift() ?? {};
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (override.status) {
      return json(res, Number(override.status), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    }
    const content = body.messages?.[0]?.content ?? "";
    const refusal = override.stop_reason === "refusal";
    return json(res, 200, {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: refusal ? "I can't help with that." : JSON.stringify(sampleFor(content)) }],
      stop_reason: refusal ? "refusal" : "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: Math.ceil(content.length / 4), output_tokens: 900 },
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { type: "error", error: { type: "api_error", message: "Stub error" } }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startAnthropicStub({ port: Number(process.env.STUB_ANTHROPIC_PORT ?? 4030) });
  console.log(`Stub Anthropic API listening at ${stub.url}`);
}
