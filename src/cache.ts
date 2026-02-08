// ABOUTME: File-backed cache for generation plans and compiled handler code.
// ABOUTME: Keyed by hash of prompt text and fetched content.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CacheConfig,
  CacheEntry,
  CompiledTools,
  CompiledTool,
} from "./types.js";
import { warn, logEvent } from "./log.js";

export interface Cache {
  get(promptHash: string, contentHash: string): CacheEntry | null;
  set(entry: CacheEntry): void;
}

export function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function cacheFilename(promptHash: string, contentHash: string): string {
  return `${promptHash}-${contentHash}.json`;
}

export function serializeCompiled(
  compiled: CompiledTools,
): { compiledTools: CacheEntry["compiledTools"] } {
  const compiledTools: CacheEntry["compiledTools"] = [];
  for (const tool of compiled.tools.values()) {
    compiledTools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      handler_code: tool.handler_code,
      needs_network: tool.needs_network,
    });
  }
  return { compiledTools };
}

export function deserializeCompiled(entry: CacheEntry): CompiledTools {
  const tools = new Map<string, CompiledTool>();
  for (const item of entry.compiledTools) {
    tools.set(item.name, {
      name: item.name,
      description: item.description,
      input_schema: item.input_schema,
      handler_code: item.handler_code,
      needs_network: item.needs_network,
    });
  }
  return {
    tools,
    whitelist_domains: entry.whitelist_domains,
  };
}

export function createCache(config: CacheConfig): Cache {
  return {
    get(promptHash: string, contentHash: string): CacheEntry | null {
      if (!config.enabled) return null;

      const filepath = join(config.dir, cacheFilename(promptHash, contentHash));
      if (!existsSync(filepath)) return null;

      logEvent("cache_lookup", { filepath });
      try {
        const raw = readFileSync(filepath, "utf-8");
        const parsed = JSON.parse(raw) as CacheEntry;
        if (
          !parsed.promptHash ||
          !parsed.contentHash ||
          !parsed.plan ||
          !Array.isArray(parsed.compiledTools)
        ) {
          warn(`Corrupt cache file ${filepath}, removing`);
          unlinkSync(filepath);
          return null;
        }
        logEvent("cache_hit", { filepath, created_at: parsed.createdAt });
        return parsed;
      } catch {
        warn(`Failed to read cache file ${filepath}, removing`);
        try {
          unlinkSync(filepath);
        } catch {
          // File may already be gone
        }
        return null;
      }
    },

    set(entry: CacheEntry): void {
      if (!config.enabled) return;

      mkdirSync(config.dir, { recursive: true });
      const filepath = join(
        config.dir,
        cacheFilename(entry.promptHash, entry.contentHash),
      );
      writeFileSync(filepath, JSON.stringify(entry, null, 2));
      logEvent("cache_written", { filepath });
    },
  };
}
