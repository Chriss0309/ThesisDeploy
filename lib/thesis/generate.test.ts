import { APIError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import {
  MAX_OUTPUT_TOKENS,
  ThesisGenerationError,
  anthropicCreateMessage,
  generateThesis,
  type CreateMessage,
} from "@/lib/thesis/generate";
import { collectPortfolio } from "@/lib/thesis/portfolio";
import { SYSTEM_PROMPT, type ContextInput } from "@/lib/thesis/prompt";
import { SAMPLE_OUTPUTS, mockCreateMessage, mockMessage } from "@/lib/thesis/testing";
import { startAnthropicStub } from "@/scripts/anthropic-stub.mjs";

const context: ContextInput = {
  prompt: "Nuclear power for AI data centers",
  budget: 2500,
  currency: "USD",
  overlapMode: "auto",
  account: { name: "Paper Trading", institution: "Alpaca Paper", isPaper: true, cash: [] },
  portfolio: collectPortfolio(demoOverview().accounts.map((account) => ({ account, snapshot: demoSnapshot(account.id) }))),
};

const sample = SAMPLE_OUTPUTS["ai-power-nuclear:USD"];

async function failure(createMessage: CreateMessage) {
  const error = await generateThesis(context, { createMessage, model: "claude-sonnet-5-5" }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ThesisGenerationError);
  return error as ThesisGenerationError;
}

describe("generateThesis", () => {
  it("sends one structured-output request and parses the response", async () => {
    const { createMessage, calls } = mockCreateMessage(sample);
    const result = await generateThesis(context, { createMessage, model: "claude-sonnet-5-5" });

    expect(calls).toHaveLength(1);
    const [params] = calls;
    expect(params).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: MAX_OUTPUT_TOKENS, system: SYSTEM_PROMPT });
    expect(params.output_config?.format).toMatchObject({ type: "json_schema", schema: { type: "object" } });
    const schema = params.output_config?.format?.schema as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["on_topic", "title", "summary", "risk_profile", "candidates", "excluded"]);
    expect(schema.additionalProperties).toBe(false);
    expect(params.messages).toEqual([
      { role: "user", content: expect.stringContaining("<thesis>\nNuclear power for AI data centers\n</thesis>") },
    ]);

    expect(result.output).toEqual(sample);
    expect(result).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 2400, outputTokens: 950 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("treats refusals and truncation as failures before parsing", async () => {
    const refusal = await failure(async () => mockMessage("I can't help with that.", { stop_reason: "refusal" }));
    expect(refusal.code).toBe("refusal");
    const truncated = await failure(async () => mockMessage('{"on_topic": true, "title": "Cut', { stop_reason: "max_tokens" }));
    expect(truncated.code).toBe("truncated");
  });

  it("rejects output that isn't JSON or doesn't match the schema", async () => {
    expect((await failure(async () => mockMessage("not json"))).code).toBe("invalid_output");
    const wrongEnum = { ...sample, risk_profile: "yolo" };
    expect((await failure(async () => mockMessage(JSON.stringify(wrongEnum)))).code).toBe("invalid_output");
  });

  it("goes through the Anthropic SDK over HTTP", async () => {
    const stub = await startAnthropicStub({ latencyMs: 0 });
    vi.stubEnv("ANTHROPIC_BASE_URL", stub.url);
    try {
      const createMessage = anthropicCreateMessage("sdk-test-key");
      const result = await generateThesis(context, { createMessage, model: "claude-sonnet-5-5" });
      expect(result.output).toEqual(sample);
      expect(result.model).toBe("claude-sonnet-5-5");
      expect(stub.stats.requests).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      await stub.close();
    }
  });

  it("maps Anthropic overload and other API errors", async () => {
    const overloaded = await failure(async () => {
      throw new APIError(529, { type: "overloaded_error" }, "Overloaded", new Headers());
    });
    expect(overloaded).toMatchObject({ code: "overloaded", status: 529 });
    const unauthorized = await failure(async () => {
      throw new APIError(401, { type: "authentication_error" }, "invalid x-api-key", new Headers());
    });
    expect(unauthorized).toMatchObject({ code: "upstream", status: 401 });
  });
});
