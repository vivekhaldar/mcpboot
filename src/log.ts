// ABOUTME: Centralized structured logging for mcpboot with JSON event output.
// ABOUTME: Supports verbose stderr, full log file capture, request correlation IDs, and session stats.

import { appendFileSync, writeFileSync } from "node:fs";

let verboseEnabled = false;
let logFilePath: string | undefined;
let currentRequestId: string | undefined;

// ─── Session stats ────────────────────────────────────────
const stats = {
  llmCalls: 0,
  llmTotalMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  fetchCalls: 0,
  fetchTotalMs: 0,
  sandboxCalls: 0,
  sandboxTotalMs: 0,
};

// ─── Configuration ────────────────────────────────────────

export function setVerbose(enabled: boolean) {
  verboseEnabled = enabled;
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

export function setLogFile(path: string) {
  logFilePath = path;
  // Truncate the file at startup so each session starts fresh
  writeFileSync(path, "");
}

export function setRequestId(id: string | undefined) {
  currentRequestId = id;
}

export function getRequestId(): string | undefined {
  return currentRequestId;
}

// ─── Human-readable output (always shown) ─────────────────

export function log(msg: string) {
  console.error(`[mcpboot] ${msg}`);
}

export function warn(msg: string) {
  console.error(`[mcpboot] WARN: ${msg}`);
}

// ─── Structured event logging ─────────────────────────────

function truncateValue(val: unknown, limit: number): unknown {
  if (typeof val === "string" && val.length > limit) {
    return val.slice(0, limit) + `...(${val.length} total)`;
  }
  if (Array.isArray(val)) {
    return val.map((v) => truncateValue(v, limit));
  }
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = truncateValue(v, limit);
    }
    return out;
  }
  return val;
}

/**
 * Emit a structured JSON log event.
 *
 * - When `--verbose` is active, writes a truncated JSON line to stderr.
 * - When `--log-file` is set, writes the full untruncated JSON line to the file.
 * - Automatically attaches a timestamp and the current request ID (if set).
 */
export function logEvent(event: string, data: Record<string, unknown> = {}) {
  if (!verboseEnabled && !logFilePath) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    ...(currentRequestId ? { req_id: currentRequestId } : {}),
    ...data,
  };

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, JSON.stringify(entry) + "\n");
    } catch {
      // Silently ignore write failures to avoid crashing the main process
    }
  }

  if (verboseEnabled) {
    const truncated = truncateValue(entry, 500) as Record<string, unknown>;
    console.error(JSON.stringify(truncated));
  }
}

// ─── Stats tracking ───────────────────────────────────────

export function trackLLM(elapsed_ms: number, prompt_tokens?: number, completion_tokens?: number) {
  stats.llmCalls++;
  stats.llmTotalMs += elapsed_ms;
  if (prompt_tokens != null) stats.promptTokens += prompt_tokens;
  if (completion_tokens != null) stats.completionTokens += completion_tokens;
}

export function trackFetch(elapsed_ms: number) {
  stats.fetchCalls++;
  stats.fetchTotalMs += elapsed_ms;
}

export function trackSandbox(elapsed_ms: number) {
  stats.sandboxCalls++;
  stats.sandboxTotalMs += elapsed_ms;
}

/**
 * Emit a session_summary event with accumulated stats.
 * Called at shutdown.
 */
export function logSummary() {
  logEvent("session_summary", {
    llm_calls: stats.llmCalls,
    llm_total_ms: Math.round(stats.llmTotalMs),
    llm_prompt_tokens: stats.promptTokens,
    llm_completion_tokens: stats.completionTokens,
    llm_total_tokens: stats.promptTokens + stats.completionTokens,
    fetch_calls: stats.fetchCalls,
    fetch_total_ms: Math.round(stats.fetchTotalMs),
    sandbox_calls: stats.sandboxCalls,
    sandbox_total_ms: Math.round(stats.sandboxTotalMs),
  });
}

export function resetStats() {
  stats.llmCalls = 0;
  stats.llmTotalMs = 0;
  stats.promptTokens = 0;
  stats.completionTokens = 0;
  stats.fetchCalls = 0;
  stats.fetchTotalMs = 0;
  stats.sandboxCalls = 0;
  stats.sandboxTotalMs = 0;
}
