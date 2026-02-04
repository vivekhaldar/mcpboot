// ABOUTME: Tests for CLI argument parsing and config validation.
// ABOUTME: Covers valid configs, missing flags, env var fallback, and port validation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildConfig } from "../../src/config.js";

function cli(...args: string[]): string[] {
  return ["node", "mcpboot", ...args];
}

describe("buildConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    }
    if (savedEnv.OPENAI_API_KEY !== undefined) {
      process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
    }
  });

  it("parses valid config with all flags", () => {
    const config = buildConfig(
      cli(
        "--prompt", "Create tools for HN API",
        "--provider", "anthropic",
        "--model", "claude-sonnet-4-20250514",
        "--api-key", "sk-test-123",
        "--port", "9000",
        "--cache-dir", "/tmp/cache",
        "--verbose",
        "--dry-run",
      ),
    );
    expect(config).not.toBeNull();
    expect(config!.prompt).toBe("Create tools for HN API");
    expect(config!.llm.provider).toBe("anthropic");
    expect(config!.llm.model).toBe("claude-sonnet-4-20250514");
    expect(config!.llm.apiKey).toBe("sk-test-123");
    expect(config!.server.port).toBe(9000);
    expect(config!.cache.dir).toBe("/tmp/cache");
    expect(config!.cache.enabled).toBe(true);
    expect(config!.verbose).toBe(true);
    expect(config!.dryRun).toBe(true);
  });

  it("parses minimal config with defaults", () => {
    const config = buildConfig(
      cli("--prompt", "Make tools", "--api-key", "sk-test"),
    );
    expect(config).not.toBeNull();
    expect(config!.llm.provider).toBe("anthropic");
    expect(config!.llm.model).toBeUndefined();
    expect(config!.server.port).toBe(8000);
    expect(config!.cache.dir).toBe(".mcpboot-cache");
    expect(config!.cache.enabled).toBe(true);
    expect(config!.verbose).toBe(false);
    expect(config!.dryRun).toBe(false);
  });

  it("reads prompt from --prompt-file", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpFile = path.join(os.tmpdir(), `mcpboot-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "Prompt from file");
    try {
      const config = buildConfig(
        cli("--prompt-file", tmpFile, "--api-key", "sk-test"),
      );
      expect(config).not.toBeNull();
      expect(config!.prompt).toBe("Prompt from file");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws when neither --prompt nor --prompt-file is provided", () => {
    expect(() => buildConfig(cli("--api-key", "sk-test"))).toThrow(
      /--prompt.*--prompt-file/,
    );
  });

  it("throws when --prompt-file references a missing file", () => {
    expect(() =>
      buildConfig(cli("--prompt-file", "/nonexistent/file.txt", "--api-key", "sk-test")),
    ).toThrow(/not found/i);
  });

  it("throws when provider is invalid", () => {
    expect(() =>
      buildConfig(
        cli("--prompt", "test", "--provider", "gemini", "--api-key", "sk-test"),
      ),
    ).toThrow(/provider/i);
  });

  it("resolves API key from ANTHROPIC_API_KEY env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-anthropic";
    const config = buildConfig(cli("--prompt", "test"));
    expect(config).not.toBeNull();
    expect(config!.llm.apiKey).toBe("sk-env-anthropic");
  });

  it("resolves API key from OPENAI_API_KEY env var for openai provider", () => {
    process.env.OPENAI_API_KEY = "sk-env-openai";
    const config = buildConfig(
      cli("--prompt", "test", "--provider", "openai"),
    );
    expect(config).not.toBeNull();
    expect(config!.llm.apiKey).toBe("sk-env-openai");
  });

  it("prefers --api-key flag over env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    const config = buildConfig(
      cli("--prompt", "test", "--api-key", "sk-flag"),
    );
    expect(config).not.toBeNull();
    expect(config!.llm.apiKey).toBe("sk-flag");
  });

  it("throws when no API key is available", () => {
    expect(() => buildConfig(cli("--prompt", "test"))).toThrow(/api key/i);
  });

  it("throws when port is not a valid number", () => {
    expect(() =>
      buildConfig(
        cli("--prompt", "test", "--api-key", "sk-test", "--port", "abc"),
      ),
    ).toThrow(/port/i);
  });

  it("throws when port is out of range", () => {
    expect(() =>
      buildConfig(
        cli("--prompt", "test", "--api-key", "sk-test", "--port", "99999"),
      ),
    ).toThrow(/port/i);
  });

  it("disables cache with --no-cache", () => {
    const config = buildConfig(
      cli("--prompt", "test", "--api-key", "sk-test", "--no-cache"),
    );
    expect(config).not.toBeNull();
    expect(config!.cache.enabled).toBe(false);
  });

  it("returns null when --help is requested", () => {
    const config = buildConfig(cli("--help"));
    expect(config).toBeNull();
  });

  it("throws when --prompt is empty string", () => {
    // Commander treats empty string as missing option, so the error is about missing prompt
    expect(() =>
      buildConfig(cli("--prompt", "", "--api-key", "sk-test")),
    ).toThrow(/prompt/i);
  });

  it("throws when --prompt is whitespace only", () => {
    expect(() =>
      buildConfig(cli("--prompt", "   ", "--api-key", "sk-test")),
    ).toThrow(/empty/i);
  });

  it("throws when --prompt-file contains only whitespace", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpFile = path.join(os.tmpdir(), `mcpboot-test-empty-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "   \n  \n  ");
    try {
      expect(() =>
        buildConfig(cli("--prompt-file", tmpFile, "--api-key", "sk-test")),
      ).toThrow(/empty/i);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws when both --prompt and --prompt-file are provided", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpFile = path.join(os.tmpdir(), `mcpboot-test-both-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "Some prompt");
    try {
      expect(() =>
        buildConfig(
          cli("--prompt", "inline", "--prompt-file", tmpFile, "--api-key", "sk-test"),
        ),
      ).toThrow(/exactly one/i);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
