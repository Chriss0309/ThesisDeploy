import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";

import { renderUserMessage, SYSTEM_PROMPT, type ContextInput } from "@/lib/thesis/prompt";
import { ThesisOutputSchema, type ThesisOutput } from "@/lib/thesis/schema";

export const MAX_OUTPUT_TOKENS = 3000;
const REQUEST_TIMEOUT_MS = 50_000;

// Only the JSON schema is sent; the response is parsed below so stop
// reasons can be checked before parsing (messages.parse throws first).
const OUTPUT_FORMAT = { type: "json_schema" as const, schema: zodOutputFormat(ThesisOutputSchema).schema };

export type CreateMessage = (
  params: MessageCreateParamsNonStreaming,
  options: { timeout: number; maxRetries: number },
) => Promise<Message>;

export type GenerationErrorCode = "refusal" | "truncated" | "invalid_output" | "overloaded" | "upstream";

export class ThesisGenerationError extends Error {
  name = "ThesisGenerationError";
  constructor(
    readonly code: GenerationErrorCode,
    readonly status: number | null = null,
    options?: { cause: unknown },
  ) {
    super(`Thesis generation failed: ${code}${status ? ` (HTTP ${status})` : ""}`, options);
  }
}

export type Generation = {
  output: ThesisOutput;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

const clients = new Map<string, Anthropic>();

export function anthropicCreateMessage(apiKey: string): CreateMessage {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    clients.set(apiKey, client);
  }
  const anthropic = client;
  return (params, options) => anthropic.messages.create(params, options);
}

/**
 * One structured-output call. Refusals, truncation, and output that fails
 * the schema become ThesisGenerationError; nothing is retried here except
 * by the SDK (once, for connection errors, 429s, and 5xx).
 */
export async function generateThesis(
  input: ContextInput,
  { createMessage, model }: { createMessage: CreateMessage; model: string },
): Promise<Generation> {
  const startedAt = performance.now();
  let message: Message;
  try {
    message = await createMessage(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderUserMessage(input) }],
        output_config: { format: OUTPUT_FORMAT },
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 },
    );
  } catch (error) {
    if (error instanceof APIError) {
      const busy = error.status === 429 || error.status === 529;
      throw new ThesisGenerationError(busy ? "overloaded" : "upstream", error.status ?? null, { cause: error });
    }
    throw error;
  }
  const latencyMs = Math.round(performance.now() - startedAt);

  if (message.stop_reason === "refusal") throw new ThesisGenerationError("refusal");
  if (message.stop_reason === "max_tokens") throw new ThesisGenerationError("truncated");
  const text = message.content.find((block) => block.type === "text")?.text;
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch (error) {
    throw new ThesisGenerationError("invalid_output", null, { cause: error });
  }
  const output = ThesisOutputSchema.safeParse(parsed);
  if (!output.success) throw new ThesisGenerationError("invalid_output", null, { cause: output.error });

  return {
    output: output.data,
    model: message.model,
    latencyMs,
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
  };
}
