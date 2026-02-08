// ABOUTME: Tests for the structured logging module.
// ABOUTME: Covers verbose mode, logEvent JSON output, log file writing, stats tracking, and request IDs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  log,
  warn,
  setVerbose,
  isVerbose,
  logEvent,
  setLogFile,
  setRequestId,
  getRequestId,
  trackLLM,
  trackFetch,
  trackSandbox,
  logSummary,
  resetStats,
} from "../../src/log.js";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("log", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(false);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    setRequestId(undefined);
  });

  it("logs with [mcpboot] prefix", () => {
    log("hello");
    expect(errorSpy).toHaveBeenCalledWith("[mcpboot] hello");
  });

  it("warns with [mcpboot] WARN: prefix", () => {
    warn("something bad");
    expect(errorSpy).toHaveBeenCalledWith("[mcpboot] WARN: something bad");
  });

  it("reports verbose state correctly", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });
});

describe("logEvent", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(false);
    setRequestId(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    setVerbose(false);
    setRequestId(undefined);
  });

  it("does nothing when verbose is off and no log file", () => {
    logEvent("test_event", { key: "value" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("writes JSON to stderr when verbose is on", () => {
    setVerbose(true);
    logEvent("test_event", { key: "value" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const output = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.event).toBe("test_event");
    expect(parsed.key).toBe("value");
    expect(parsed.ts).toBeDefined();
  });

  it("includes request ID when set", () => {
    setVerbose(true);
    setRequestId("req-123");
    logEvent("test_event");
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.req_id).toBe("req-123");
  });

  it("omits request ID when not set", () => {
    setVerbose(true);
    logEvent("test_event");
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.req_id).toBeUndefined();
  });

  it("truncates long strings in stderr output", () => {
    setVerbose(true);
    const longString = "x".repeat(1000);
    logEvent("test_event", { data: longString });
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.data.length).toBeLessThan(1000);
    expect(parsed.data).toContain("...(1000 total)");
  });
});

describe("setRequestId / getRequestId", () => {
  afterEach(() => setRequestId(undefined));

  it("starts undefined after reset", () => {
    setRequestId(undefined);
    expect(getRequestId()).toBeUndefined();
  });

  it("can be set and retrieved", () => {
    setRequestId("abc-123");
    expect(getRequestId()).toBe("abc-123");
  });

  it("can be cleared", () => {
    setRequestId("abc-123");
    setRequestId(undefined);
    expect(getRequestId()).toBeUndefined();
  });
});

describe("log file", () => {
  const logFilePath = join(tmpdir(), `mcpboot-log-test-${Date.now()}.jsonl`);

  afterEach(() => {
    setVerbose(false);
    try {
      unlinkSync(logFilePath);
    } catch {
      // ignore
    }
  });

  it("writes full untruncated JSON lines to log file", () => {
    setLogFile(logFilePath);
    // Verbose is off — only log file should get output
    const longString = "x".repeat(1000);
    logEvent("test_event", { data: longString });
    const content = readFileSync(logFilePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.event).toBe("test_event");
    expect(parsed.data).toBe(longString); // Full, not truncated
    expect(parsed.data.length).toBe(1000);
  });
});

describe("stats tracking", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(true);
    resetStats();
  });

  afterEach(() => {
    errorSpy.mockRestore();
    setVerbose(false);
    resetStats();
  });

  it("tracks LLM call stats", () => {
    trackLLM(1000, 500, 200);
    trackLLM(2000, 300, 100);
    logSummary();

    const output = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.event).toBe("session_summary");
    expect(parsed.llm_calls).toBe(2);
    expect(parsed.llm_total_ms).toBe(3000);
    expect(parsed.llm_prompt_tokens).toBe(800);
    expect(parsed.llm_completion_tokens).toBe(300);
    expect(parsed.llm_total_tokens).toBe(1100);
  });

  it("tracks fetch stats", () => {
    trackFetch(150);
    trackFetch(250);
    logSummary();

    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.fetch_calls).toBe(2);
    expect(parsed.fetch_total_ms).toBe(400);
  });

  it("tracks sandbox stats", () => {
    trackSandbox(50);
    trackSandbox(75);
    logSummary();

    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.sandbox_calls).toBe(2);
    expect(parsed.sandbox_total_ms).toBe(125);
  });

  it("resets stats correctly", () => {
    trackLLM(1000, 500, 200);
    trackFetch(100);
    trackSandbox(50);
    resetStats();
    logSummary();

    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.llm_calls).toBe(0);
    expect(parsed.fetch_calls).toBe(0);
    expect(parsed.sandbox_calls).toBe(0);
  });
});
