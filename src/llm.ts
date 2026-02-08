// ABOUTME: Multi-provider LLM client using Vercel AI SDK.
// ABOUTME: Provides a single generate() method for both Anthropic and OpenAI.

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMClient, LLMConfig } from "./types.js";
import { logEvent, trackLLM } from "./log.js";

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

  logEvent("llm_init", { provider: config.provider, model: modelId });

  return {
    async generate(system: string, user: string): Promise<string> {
      const callId = ++callCount;

      logEvent("llm_call_start", {
        call_id: callId,
        provider: config.provider,
        model: modelId,
        max_tokens: 8192,
        temperature: 0.2,
        system_prompt: system,
        user_prompt: user,
      });

      const start = performance.now();

      try {
        const result = await generateText({
          model,
          system,
          prompt: user,
          maxTokens: 8192,
          temperature: 0.2,
        });

        const elapsed_ms = Math.round(performance.now() - start);
        const prompt_tokens = result.usage?.promptTokens;
        const completion_tokens = result.usage?.completionTokens;

        trackLLM(elapsed_ms, prompt_tokens, completion_tokens);

        logEvent("llm_call_end", {
          call_id: callId,
          elapsed_ms,
          prompt_tokens,
          completion_tokens,
          total_tokens: (prompt_tokens ?? 0) + (completion_tokens ?? 0),
          finish_reason: result.finishReason,
          response: result.text,
        });

        return result.text;
      } catch (error: unknown) {
        const elapsed_ms = Math.round(performance.now() - start);
        const err = error as Record<string, unknown>;

        logEvent("llm_call_error", {
          call_id: callId,
          elapsed_ms,
          error: err.message ?? String(error),
          status_code: err.statusCode,
        });

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
