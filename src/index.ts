// ABOUTME: CLI entry point for mcpboot.
// ABOUTME: Orchestrates the lifecycle: config → fetch → plan → compile → cache → serve.

import { buildConfig } from "./config.js";
import { extractUrls, fetchUrls } from "./fetcher.js";
import { buildWhitelist, createWhitelistedFetch } from "./whitelist.js";
import { createCache, hash, serializeCompiled, deserializeCompiled } from "./cache.js";
import { createLLMClient } from "./llm.js";
import { generatePlan } from "./engine/planner.js";
import { compilePlan } from "./engine/compiler.js";
import { createExecutor } from "./engine/executor.js";
import { createSandbox } from "./engine/sandbox.js";
import { createExposedServer } from "./server.js";
import { log, warn, setVerbose, verbose } from "./log.js";
import { writeOwnUrl } from "./pipe.js";
import type { CompiledTools, FetchedContent, Whitelist } from "./types.js";

function buildContentHash(contents: FetchedContent[]): string {
  const sorted = [...contents].sort((a, b) => a.url.localeCompare(b.url));
  const joined = sorted.map((c) => c.content).join("\n---\n");
  return hash(joined);
}

function reconstructWhitelist(domains: string[]): Whitelist {
  const domainSet = new Set(domains);
  return {
    domains: domainSet,
    allows(url: string): boolean {
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return false;
      }
      for (const d of domainSet) {
        if (hostname === d || hostname.endsWith("." + d)) return true;
      }
      return false;
    },
  };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const config = buildConfig(argv);
  if (!config) return; // --help was shown

  setVerbose(config.verbose);

  // 1. Extract and fetch URLs
  const urls = extractUrls(config.prompt);
  log(`Found ${urls.length} URL(s) in prompt`);

  const contents = await fetchUrls(urls);
  log(`Fetched ${contents.length} page(s)`);

  if (urls.length > 0 && contents.length === 0) {
    warn(
      "All URL fetches failed. Proceeding with prompt text only — generated tools may be less accurate",
    );
  }

  const whitelist = buildWhitelist(urls, contents);
  const whitelistDomains = [...whitelist.domains];
  verbose(`Whitelist: ${whitelistDomains.join(", ") || "(empty)"}`);

  // 2. Check cache
  const cache = createCache(config.cache);
  const promptHash = hash(config.prompt);
  const contentHash = buildContentHash(contents);

  let compiled: CompiledTools;
  let activeWhitelist: Whitelist;

  const cached = cache.get(promptHash, contentHash);

  if (cached) {
    log("Cache hit — loading generated tools");
    compiled = deserializeCompiled(cached);
    activeWhitelist = reconstructWhitelist(cached.whitelist_domains);
  } else {
    // 3. Generate plan
    log("Cache miss — generating tools via LLM");
    const llm = createLLMClient(config.llm);
    const plan = await generatePlan(llm, config.prompt, contents, whitelist);
    log(`Plan: ${plan.tools.length} tool(s)`);

    if (config.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    // 4. Compile handlers
    compiled = await compilePlan(llm, plan, contents);
    compiled.whitelist_domains = whitelistDomains;
    log(`Compiled ${compiled.tools.size} handler(s)`);

    // 5. Cache
    const { compiledTools } = serializeCompiled(compiled);
    cache.set({
      promptHash,
      contentHash,
      plan,
      compiledTools,
      whitelist_domains: whitelistDomains,
      createdAt: new Date().toISOString(),
    });

    activeWhitelist = whitelist;
  }

  if (config.dryRun) {
    // Dry-run with cache hit: show cached plan info
    log(`${compiled.tools.size} cached tool(s) available`);
    const toolNames = Array.from(compiled.tools.keys());
    console.log(JSON.stringify({ cached: true, tools: toolNames }, null, 2));
    return;
  }

  // 6. Start server
  const whitelistedFetch = createWhitelistedFetch(activeWhitelist);
  const sandbox = createSandbox(whitelistedFetch);
  const executor = createExecutor(compiled, sandbox);
  const server = createExposedServer(config.server, executor);

  const port = await server.start();
  log(`Listening on http://localhost:${port}/mcp`);
  log(`Serving ${executor.getExposedTools().length} tool(s)`);

  if (config.pipe.stdoutIsPipe) {
    writeOwnUrl(`http://localhost:${port}/mcp`);
  }

  // Shutdown handlers
  const shutdown = async () => {
    log("Shutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGPIPE", shutdown);
}

// Only auto-run when executed directly, not when imported by tests
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcpboot] Fatal: ${message}`);
    process.exit(1);
  });
}
