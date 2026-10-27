import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";

import type { CreateMessage } from "@/lib/thesis/generate";
import samples from "@/lib/thesis/sample-outputs.json";
import type { ThesisOutput } from "@/lib/thesis/schema";

export const SAMPLE_OUTPUTS = samples as unknown as Record<string, ThesisOutput>;

/** A Messages API response in the shape the SDK returns, for tests. */
export function mockMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 2400, output_tokens: 950 },
    ...overrides,
  } as unknown as Message;
}

/** A CreateMessage stand-in that records each request and answers with `output`. */
export function mockCreateMessage(output: ThesisOutput | ((params: MessageCreateParamsNonStreaming) => Message)) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const createMessage: CreateMessage = async (params) => {
    calls.push(params);
    return typeof output === "function" ? output(params) : mockMessage(JSON.stringify(output));
  };
  return { createMessage, calls };
}
