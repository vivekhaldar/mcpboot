// ABOUTME: Unit tests for the file-backed generation cache.
// ABOUTME: Tests cache hit/miss, round-trip serialization, corruption handling, and disabled mode.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCache,
  hash,
  serializeCompiled,
  deserializeCompiled,
} from "../../src/cache.js";
import type {
  CacheConfig,
  CacheEntry,
  CompiledTools,
  GenerationPlan,
} from "../../src/types.js";

const TEST_CACHE_DIR = join(import.meta.dirname, ".test-cache");

function makeCacheConfig(overrides?: Partial<CacheConfig>): CacheConfig {
  return {
    enabled: true,
    dir: TEST_CACHE_DIR,
    ...overrides,
  };
}

function makePlan(): GenerationPlan {
  return {
    tools: [
      {
        name: "get_items",
        description: "Get items from API",
        input_schema: { type: "object", properties: { limit: { type: "number" } } },
        endpoints_used: ["GET https://api.example.com/items"],
        implementation_notes: "Fetch items with optional limit",
        needs_network: true,
      },
    ],
  };
}

function makeCompiled(): CompiledTools {
  const tools = new Map();
  tools.set("get_items", {
    name: "get_items",
    description: "Get items from API",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
    handler_code: 'const res = await fetch("https://api.example.com/items"); const data = await res.json(); return { content: [{ type: "text", text: JSON.stringify(data) }] };',
    needs_network: true,
  });
  return {
    tools,
    whitelist_domains: ["api.example.com"],
  };
}

function makeCacheEntry(): CacheEntry {
  const compiled = makeCompiled();
  const { compiledTools } = serializeCompiled(compiled);
  return {
    promptHash: "abc123",
    contentHash: "def456",
    plan: makePlan(),
    compiledTools,
    whitelist_domains: ["api.example.com"],
    createdAt: new Date().toISOString(),
  };
}

describe("cache", () => {
  beforeEach(() => {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  describe("hash", () => {
    it("returns a 16-character hex string", () => {
      const result = hash("hello world");
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it("returns the same hash for the same input", () => {
      expect(hash("test input")).toBe(hash("test input"));
    });

    it("returns different hashes for different inputs", () => {
      expect(hash("input a")).not.toBe(hash("input b"));
    });
  });

  describe("serializeCompiled / deserializeCompiled", () => {
    it("round-trips CompiledTools through serialization", () => {
      const compiled = makeCompiled();
      const serialized = serializeCompiled(compiled);
      const entry: CacheEntry = {
        promptHash: "p",
        contentHash: "c",
        plan: makePlan(),
        compiledTools: serialized.compiledTools,
        whitelist_domains: compiled.whitelist_domains,
        createdAt: new Date().toISOString(),
      };

      const deserialized = deserializeCompiled(entry);

      expect(deserialized.tools.size).toBe(1);
      const tool = deserialized.tools.get("get_items")!;
      expect(tool.name).toBe("get_items");
      expect(tool.description).toBe("Get items from API");
      expect(tool.handler_code).toContain("fetch");
      expect(tool.needs_network).toBe(true);
      expect(deserialized.whitelist_domains).toEqual(["api.example.com"]);
    });

    it("handles multiple tools", () => {
      const compiled = makeCompiled();
      compiled.tools.set("search", {
        name: "search",
        description: "Search for stuff",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
        handler_code: 'return { content: [{ type: "text", text: "results" }] };',
        needs_network: false,
      });

      const serialized = serializeCompiled(compiled);
      const entry: CacheEntry = {
        promptHash: "p",
        contentHash: "c",
        plan: makePlan(),
        compiledTools: serialized.compiledTools,
        whitelist_domains: compiled.whitelist_domains,
        createdAt: new Date().toISOString(),
      };

      const deserialized = deserializeCompiled(entry);
      expect(deserialized.tools.size).toBe(2);
      expect(deserialized.tools.has("get_items")).toBe(true);
      expect(deserialized.tools.has("search")).toBe(true);
    });
  });

  describe("createCache", () => {
    it("returns null on cache miss", () => {
      const cache = createCache(makeCacheConfig());
      const result = cache.get("nonexistent", "hash");
      expect(result).toBeNull();
    });

    it("stores and retrieves a cache entry", () => {
      const cache = createCache(makeCacheConfig());
      const entry = makeCacheEntry();

      cache.set(entry);
      const retrieved = cache.get(entry.promptHash, entry.contentHash);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.promptHash).toBe(entry.promptHash);
      expect(retrieved!.contentHash).toBe(entry.contentHash);
      expect(retrieved!.plan.tools).toHaveLength(1);
      expect(retrieved!.compiledTools).toHaveLength(1);
      expect(retrieved!.whitelist_domains).toEqual(["api.example.com"]);
    });

    it("creates cache directory if it does not exist", () => {
      const nestedDir = join(TEST_CACHE_DIR, "nested", "deep");
      const cache = createCache(makeCacheConfig({ dir: nestedDir }));
      const entry = makeCacheEntry();

      cache.set(entry);
      const retrieved = cache.get(entry.promptHash, entry.contentHash);
      expect(retrieved).not.toBeNull();
    });

    it("returns null and removes corrupt cache file", () => {
      const cache = createCache(makeCacheConfig());
      const filename = `abc123-def456.json`;
      writeFileSync(join(TEST_CACHE_DIR, filename), "not valid json{{{");

      const result = cache.get("abc123", "def456");
      expect(result).toBeNull();
    });

    it("returns null and removes cache file with missing fields", () => {
      const cache = createCache(makeCacheConfig());
      const filename = `abc123-def456.json`;
      writeFileSync(
        join(TEST_CACHE_DIR, filename),
        JSON.stringify({ promptHash: "abc123" })
      );

      const result = cache.get("abc123", "def456");
      expect(result).toBeNull();
    });

    it("always returns null when cache is disabled", () => {
      const cache = createCache(makeCacheConfig({ enabled: false }));
      const entry = makeCacheEntry();

      cache.set(entry);
      const result = cache.get(entry.promptHash, entry.contentHash);
      expect(result).toBeNull();
    });

    it("content hash determinism: same content produces same hash", () => {
      const contents = [
        { url: "https://b.com", content: "beta" },
        { url: "https://a.com", content: "alpha" },
      ];

      // Sort by URL for determinism, join, hash
      const makeContentHash = (c: typeof contents) =>
        hash(
          [...c]
            .sort((a, b) => a.url.localeCompare(b.url))
            .map((x) => x.content)
            .join("\n---\n")
        );

      const hash1 = makeContentHash(contents);
      const hash2 = makeContentHash([...contents].reverse());
      expect(hash1).toBe(hash2);
    });
  });
});
