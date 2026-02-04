// ABOUTME: Parses CLI arguments and environment variables into a validated Config.
// ABOUTME: Fails fast with clear error messages for invalid configuration.

import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import type { Config, PipeConfig } from "./types.js";

export function buildConfig(argv: string[], pipeOverride?: PipeConfig): Config | null {
  const program = new Command()
    .name("mcpboot")
    .description(
      "Generate and serve an MCP server from a natural language prompt",
    )
    .option("--prompt <text>", "Generation prompt (inline)")
    .option("--prompt-file <path>", "Generation prompt from file")
    .option(
      "--provider <name>",
      "LLM provider: anthropic | openai",
      "anthropic",
    )
    .option("--model <id>", "LLM model ID")
    .option("--api-key <key>", "LLM API key")
    .option("--port <number>", "HTTP server port", "8000")
    .option("--cache-dir <path>", "Cache directory", ".mcpboot-cache")
    .option("--no-cache", "Disable caching")
    .option("--verbose", "Verbose logging", false)
    .option(
      "--dry-run",
      "Show generation plan without starting server",
      false,
    )
    .exitOverride()
    .configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => process.stdout.write(str),
    });

  try {
    program.parse(argv);
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "commander.helpDisplayed"
    ) {
      return null;
    }
    throw err;
  }
  const opts = program.opts();

  // Validate provider
  if (opts.provider !== "anthropic" && opts.provider !== "openai") {
    throw new Error("Error: --provider must be 'anthropic' or 'openai'");
  }

  // Validate prompt: exactly one of --prompt or --prompt-file
  let prompt: string;
  if (opts.promptFile) {
    if (opts.prompt) {
      throw new Error(
        "Error: Provide exactly one of --prompt or --prompt-file, not both",
      );
    }
    if (!existsSync(opts.promptFile)) {
      throw new Error(`Error: File not found: ${opts.promptFile}`);
    }
    prompt = readFileSync(opts.promptFile, "utf-8");
  } else if (opts.prompt) {
    prompt = opts.prompt;
  } else {
    throw new Error(
      "Error: Provide --prompt or --prompt-file to specify the generation prompt",
    );
  }

  if (!prompt.trim()) {
    throw new Error("Error: Prompt is empty. Provide a non-empty generation prompt");
  }

  // Validate API key: flag > env var
  let apiKey = opts.apiKey;
  if (!apiKey) {
    if (opts.provider === "anthropic") {
      apiKey = process.env.ANTHROPIC_API_KEY;
    } else {
      apiKey = process.env.OPENAI_API_KEY;
    }
  }
  if (!apiKey) {
    throw new Error(
      "Error: No API key found. Provide --api-key or set ANTHROPIC_API_KEY / OPENAI_API_KEY",
    );
  }

  // Pipe detection
  const pipe: PipeConfig = pipeOverride ?? { stdoutIsPipe: !process.stdout.isTTY };

  // Validate port
  const portExplicit = program.getOptionValueSource("port") === "cli";
  const port = (!portExplicit && pipe.stdoutIsPipe) ? 0 : parseInt(opts.port, 10);
  if (isNaN(port) || port < 0 || port > 65535) {
    throw new Error(
      "Error: --port must be a valid integer between 0 and 65535",
    );
  }

  return {
    prompt,
    llm: {
      provider: opts.provider as "anthropic" | "openai",
      model: opts.model,
      apiKey,
    },
    server: {
      port,
    },
    cache: {
      enabled: opts.cache !== false,
      dir: opts.cacheDir ?? ".mcpboot-cache",
    },
    pipe,
    dryRun: opts.dryRun ?? false,
    verbose: opts.verbose ?? false,
  };
}
