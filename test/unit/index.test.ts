// ABOUTME: Tests for the CLI entry point orchestration.
// ABOUTME: Verifies the startup flow: config → fetch → cache → plan → compile → serve.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock modules before importing main
vi.mock("../../src/llm.js", () => ({
  createLLMClient: vi.fn(),
}));

vi.mock("../../src/engine/planner.js", () => ({
  generatePlan: vi.fn(),
}));

vi.mock("../../src/engine/compiler.js", () => ({
  compilePlan: vi.fn(),
}));

import { main } from "../../src/index.js";
import { createLLMClient } from "../../src/llm.js";
import { generatePlan } from "../../src/engine/planner.js";
import { compilePlan } from "../../src/engine/compiler.js";
import type { GenerationPlan, CompiledTools } from "../../src/types.js";

const TEST_CACHE_DIR = join(import.meta.dirname, ".test-index-cache");

function cli(...args: string[]): string[] {
  return ["node", "mcpboot", ...args];
}

function makePlan(): GenerationPlan {
  return {
    tools: [
      {
        name: "add_numbers",
        description: "Adds two numbers",
        input_schema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
        endpoints_used: [],
        implementation_notes: "Return sum of a and b",
        needs_network: false,
      },
    ],
  };
}

function makeCompiled(): CompiledTools {
  return {
    tools: new Map([
      [
        "add_numbers",
        {
          name: "add_numbers",
          description: "Adds two numbers",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
          handler_code:
            'return { content: [{ type: "text", text: String(args.a + args.b) }] };',
          needs_network: false,
        },
      ],
    ]),
    whitelist_domains: [],
  };
}

function setupMocks() {
  const mockLLM = { generate: vi.fn() };
  vi.mocked(createLLMClient).mockReturnValue(mockLLM);
  vi.mocked(generatePlan).mockResolvedValue(makePlan());
  vi.mocked(compilePlan).mockResolvedValue(makeCompiled());
  return mockLLM;
}

describe("main", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-12345";
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Clean up test cache dir
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("returns without error when --help is passed", async () => {
    await main(cli("--help"));
    // Should not throw; buildConfig returns null for --help
  });

  it("throws on missing prompt", async () => {
    await expect(main(cli("--api-key", "k"))).rejects.toThrow("--prompt");
  });

  it("dry-run outputs plan JSON and returns", async () => {
    setupMocks();

    await main(
      cli(
        "--prompt",
        "Add two numbers together",
        "--dry-run",
        "--cache-dir",
        TEST_CACHE_DIR,
      ),
    );

    expect(generatePlan).toHaveBeenCalled();
    // Dry-run should output the plan via console.log
    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("add_numbers");
  });

  it("dry-run does not call compilePlan", async () => {
    setupMocks();

    await main(
      cli(
        "--prompt",
        "Add two numbers together",
        "--dry-run",
        "--cache-dir",
        TEST_CACHE_DIR,
      ),
    );

    expect(compilePlan).not.toHaveBeenCalled();
  });

  it("proceeds with empty URL list when prompt has no URLs", async () => {
    setupMocks();

    await main(
      cli(
        "--prompt",
        "Add two numbers together",
        "--dry-run",
        "--cache-dir",
        TEST_CACHE_DIR,
      ),
    );

    // Should succeed without fetching any URLs
    expect(generatePlan).toHaveBeenCalled();
  });

  it("passes prompt content to generatePlan", async () => {
    setupMocks();

    const prompt = "Create a calculator tool for addition";
    await main(
      cli("--prompt", prompt, "--dry-run", "--cache-dir", TEST_CACHE_DIR),
    );

    expect(generatePlan).toHaveBeenCalledWith(
      expect.anything(), // llm
      prompt,
      expect.any(Array), // contents
      expect.objectContaining({ domains: expect.any(Set) }), // whitelist
    );
  });

  it("throws on empty prompt from file", async () => {
    const tmpFile = join(TEST_CACHE_DIR, "empty-prompt.txt");
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    writeFileSync(tmpFile, "   \n  ");
    await expect(
      main(cli("--prompt-file", tmpFile)),
    ).rejects.toThrow(/empty/i);
  });

  it("uses --no-cache to skip caching", async () => {
    setupMocks();

    await main(
      cli(
        "--prompt",
        "Add two numbers",
        "--dry-run",
        "--no-cache",
      ),
    );

    // Should still work fine
    expect(generatePlan).toHaveBeenCalled();
  });
});
