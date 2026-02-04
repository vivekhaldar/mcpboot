// ABOUTME: Type definitions for mcpboot.
// ABOUTME: Defines interfaces for config, content fetching, tool generation, and execution.

// ─── Config ────────────────────────────────────────────────

export interface LLMConfig {
  provider: "anthropic" | "openai";
  model?: string;
  apiKey: string;
}

export interface ServerConfig {
  port: number;
}

export interface CacheConfig {
  enabled: boolean;
  dir: string;
}

export interface Config {
  prompt: string;
  llm: LLMConfig;
  server: ServerConfig;
  cache: CacheConfig;
  dryRun: boolean;
  verbose: boolean;
}

// ─── Fetched Content ───────────────────────────────────────

export interface FetchedContent {
  url: string;
  content: string;
  contentType: string;
  discoveredUrls: string[];
}

// ─── Whitelist ─────────────────────────────────────────────

export interface Whitelist {
  domains: Set<string>;
  allows(url: string): boolean;
}

// ─── Generation Plan ───────────────────────────────────────

export interface GenerationPlan {
  tools: PlannedTool[];
}

export interface PlannedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  endpoints_used: string[];
  implementation_notes: string;
  needs_network: boolean;
}

// ─── Compiled Tools ────────────────────────────────────────

export interface CompiledTools {
  tools: Map<string, CompiledTool>;
  whitelist_domains: string[];
}

export interface CompiledTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler_code: string;
  needs_network: boolean;
}

// ─── Executor ──────────────────────────────────────────────

export interface ToolCallResult {
  content: Array<{ type: string; text: string; [key: string]: unknown }>;
  isError?: boolean;
}

// ─── Cache ─────────────────────────────────────────────────

export interface CacheEntry {
  promptHash: string;
  contentHash: string;
  plan: GenerationPlan;
  compiledTools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    handler_code: string;
    needs_network: boolean;
  }>;
  whitelist_domains: string[];
  createdAt: string;
}

// ─── LLM ───────────────────────────────────────────────────

export interface LLMClient {
  generate(system: string, user: string): Promise<string>;
}
