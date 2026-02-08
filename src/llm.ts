// ABOUTME: Multi-provider LLM client using Vercel AI SDK.
// ABOUTME: Provides a single generate() method for both Anthropic and OpenAI.

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMClient, LLMConfig } from "./types.js";
import { verbose, verboseBody, verboseTimer } from "./log.js";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
};

let callCount = 0;

export function createLLMClient(config: LLMConfig): LLMClient {
  const modelId = config.model ?? DEFAULT_MODELS[config.provider];

  let model;
  if (config.provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey: config.apiKey });
    model = anthropic(modelId);
  } else {
    const openai = createOpenAI({ apiKey: config.apiKey });
    model = openai(modelId);
  }

  verbose(`LLM client initialized: provider=${config.provider} model=${modelId}`);

  return {
    async generate(system: string, user: string): Promise<string> {
      const callId = ++callCount;
      const done = verboseTimer(`LLM call #${callId} [${config.provider}/${modelId}]`);

      verbose(`LLM call #${callId} — maxTokens=8192 temperature=0.2`);
      verboseBody(`LLM call #${callId} — system prompt`, system);
      verboseBody(`LLM call #${callId} — user prompt`, user);

      try {
        const result = await generateText({
          model,
          system,
          prompt: user,
          maxTokens: 8192,
          temperature: 0.2,
        });

        done();
        verboseBody(`LLM call #${callId} — response`, result.text);
        if (result.usage) {
          verbose(
            `LLM call #${callId} — usage: promptTokens=${result.usage.promptTokens} completionTokens=${result.usage.completionTokens} totalTokens=${(result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0)}`,
          );
        }
        verbose(`LLM call #${callId} — finishReason=${result.finishReason}`);

        return result.text;
      } catch (error: unknown) {
        done();
        const err = error as Record<string, unknown>;
        verbose(`LLM call #${callId} — ERROR: ${err.message ?? String(error)}`);
        if (err.statusCode === 404) {
          throw new Error(
            `Model "${modelId}" not found. Check the model ID — ` +
              `e.g. "claude-sonnet-4-20250514" or "claude-haiku-4-5" ` +
              `(note: dated variants like "claude-haiku-4-5-20241022" don't exist; ` +
              `use "claude-3-5-haiku-20241022" for the dated form)`,
          );
        }
        throw error;
      }
    },
  };
}
