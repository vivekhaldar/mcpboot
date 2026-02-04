// ABOUTME: Multi-provider LLM client using Vercel AI SDK.
// ABOUTME: Provides a single generate() method for both Anthropic and OpenAI.

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMClient, LLMConfig } from "./types.js";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
};

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

  return {
    async generate(system: string, user: string): Promise<string> {
      const result = await generateText({
        model,
        system,
        prompt: user,
        maxTokens: 8192,
        temperature: 0.2,
      });
      return result.text;
    },
  };
}
