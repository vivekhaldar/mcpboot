// ABOUTME: Tests for the logging module.
// ABOUTME: Verifies prefix, verbose toggle, and warn formatting.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, warn, verbose, setVerbose, isVerbose } from "../../src/log.js";

describe("log", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(false);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs with [mcpboot] prefix", () => {
    log("hello");
    expect(errorSpy).toHaveBeenCalledWith("[mcpboot] hello");
  });

  it("warns with [mcpboot] WARN: prefix", () => {
    warn("something bad");
    expect(errorSpy).toHaveBeenCalledWith("[mcpboot] WARN: something bad");
  });

  it("suppresses verbose messages when verbose is disabled", () => {
    verbose("detail");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("shows verbose messages when verbose is enabled", () => {
    setVerbose(true);
    verbose("detail");
    expect(errorSpy).toHaveBeenCalledWith("[mcpboot] detail");
  });

  it("reports verbose state correctly", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });
});
