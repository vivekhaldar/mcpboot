// ABOUTME: End-to-end integration tests for the full mcpboot pipeline.
// ABOUTME: Tests plan→compile→execute→serve with mocked LLM but real sandbox, server, and cache.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { generatePlan } from "../../src/engine/planner.js";
import { compilePlan } from "../../src/engine/compiler.js";
import { createExecutor } from "../../src/engine/executor.js";
import { createSandbox } from "../../src/engine/sandbox.js";
import { createExposedServer } from "../../src/server.js";
import { buildWhitelist, createWhitelistedFetch } from "../../src/whitelist.js";
import { createCache, hash, serializeCompiled } from "../../src/cache.js";
import type {
  LLMClient,
  GenerationPlan,
  CompiledTools,
  FetchedContent,
  Whitelist,
} from "../../src/types.js";

const TEST_CACHE_DIR = join(import.meta.dirname, ".test-e2e-cache");

// Realistic HN API plan that a real LLM would produce, with rich descriptions
// for downstream LLM consumption (UI generation, tool-call planning, etc.)
const HN_PLAN: GenerationPlan = {
  tools: [
    {
      name: "get_top_stories",
      description:
        "Retrieves the IDs of the current top-ranked stories on Hacker News, sorted by ranking.\n\n" +
        "Use this tool to discover which stories are currently trending on Hacker News. " +
        "Pass the returned IDs to get_item to fetch full story details (title, URL, score, etc.).\n\n" +
        "Response format:\n" +
        "Returns a JSON array of numeric item IDs, ordered by current ranking. " +
        "Example response:\n[37052586, 37## 051270, 37050466]\n\n" +
        "Example usage:\n" +
        '- Input: { "limit": 3 }\n' +
        "- Returns the top 3 story IDs as a JSON array\n\n" +
        "Errors:\n" +
        "- Returns an error if the Hacker News API is unreachable.",
      input_schema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description:
              "Maximum number of story IDs to return. The API provides up to 500 top stories; this parameter caps the result to the specified count.",
            default: 10,
            minimum: 1,
            maximum: 500,
            examples: [5, 10, 50],
          },
        },
        required: [],
      },
      endpoints_used: [
        "GET https://hacker-news.firebaseio.com/v0/topstories.json",
      ],
      implementation_notes:
        "Fetch top story IDs from HN API, slice to limit, return as JSON",
      needs_network: true,
    },
    {
      name: "get_item",
      description:
        "Retrieves the full details of a specific Hacker News item (story, comment, job, poll, or pollopt) by its unique numeric ID.\n\n" +
        "Use this tool when you have an item ID (e.g. from get_top_stories) and need its title, author, score, URL, or child comments. " +
        "Each item type returns slightly different fields.\n\n" +
        "Response format:\n" +
        "Returns a JSON object with the item details. Stories include: id, type, by, title, url, score, time, descendants, kids. " +
        "Comments include: id, type, by, text, parent, time, kids.\n" +
        "Example response:\n" +
        '{ "id": 8863, "type": "story", "by": "dhouston", "title": "My YC app: Dropbox", ' +
        '"url": "http://www.getdropbox.com/u/2/screencast.html", "score": 111, "time": 1175714200, "descendants": 71 }\n\n' +
        "Example usage:\n" +
        '- Input: { "id": 8863 }\n' +
        "- Returns the full item object for story 8863 including title, author, score, and URL\n\n" +
        "Errors:\n" +
        "- Returns null if the item ID does not exist.\n" +
        "- Returns an error if the API is unreachable.",
      input_schema: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description:
              "The unique numeric Hacker News item ID. Item IDs are positive integers assigned sequentially. " +
              "Obtain item IDs from tools like get_top_stories.",
            minimum: 1,
            examples: [8863, 37052586],
          },
        },
        required: ["id"],
      },
      endpoints_used: [
        "GET https://hacker-news.firebaseio.com/v0/item/{id}.json",
      ],
      implementation_notes:
        "Fetch item by ID from HN API, return full item details as JSON",
      needs_network: true,
    },
  ],
};

// Handler code that matches what an LLM would generate
const HN_HANDLER_TOP_STORIES = `\
const limit = args.limit || 10;
const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
if (!res.ok) {
  return { content: [{ type: "text", text: "Error: " + res.status + " " + res.statusText }], isError: true };
}
const ids = await res.json();
const result = ids.slice(0, limit);
return { content: [{ type: "text", text: JSON.stringify(result) }] };`;

const HN_HANDLER_GET_ITEM = `\
const res = await fetch("https://hacker-news.firebaseio.com/v0/item/" + args.id + ".json");
if (!res.ok) {
  return { content: [{ type: "text", text: "Error: " + res.status + " " + res.statusText }], isError: true };
}
const item = await res.json();
return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };`;

// Pure computation plan (no network), with rich descriptions
const CALC_PLAN: GenerationPlan = {
  tools: [
    {
      name: "add_numbers",
      description:
        "Adds two numbers together and returns their sum.\n\n" +
        "Use this tool for addition operations. Accepts any numeric values including integers and floating-point numbers.\n\n" +
        "Response format:\n" +
        "Returns the numeric sum as a plain text string.\n" +
        'Example response: "42"\n\n' +
        "Example usage:\n" +
        '- Input: { "a": 17, "b": 25 }\n' +
        '- Returns: "42"\n\n' +
        "Errors:\n" +
        "- Returns an error if either parameter is not a valid number.",
      input_schema: {
        type: "object",
        properties: {
          a: {
            type: "number",
            description: "The first number to add.",
            examples: [1, 17, 3.14],
          },
          b: {
            type: "number",
            description: "The second number to add.",
            examples: [2, 25, 2.72],
          },
        },
        required: ["a", "b"],
      },
      endpoints_used: [],
      implementation_notes: "Return sum of a and b",
      needs_network: false,
    },
    {
      name: "multiply_numbers",
      description:
        "Multiplies two numbers together and returns their product.\n\n" +
        "Use this tool for multiplication operations. Accepts any numeric values including integers and floating-point numbers.\n\n" +
        "Response format:\n" +
        "Returns the numeric product as a plain text string.\n" +
        'Example response: "42"\n\n' +
        "Example usage:\n" +
        '- Input: { "a": 6, "b": 7 }\n' +
        '- Returns: "42"\n\n' +
        "Errors:\n" +
        "- Returns an error if either parameter is not a valid number.",
      input_schema: {
        type: "object",
        properties: {
          a: {
            type: "number",
            description: "The first number to multiply.",
            examples: [2, 6, 3.14],
          },
          b: {
            type: "number",
            description: "The second number to multiply.",
            examples: [3, 7, 2.72],
          },
        },
        required: ["a", "b"],
      },
      endpoints_used: [],
      implementation_notes: "Return product of a and b",
      needs_network: false,
    },
  ],
};

const CALC_HANDLER_ADD = `\
const result = args.a + args.b;
return { content: [{ type: "text", text: String(result) }] };`;

const CALC_HANDLER_MULTIPLY = `\
const result = args.a * args.b;
return { content: [{ type: "text", text: String(result) }] };`;

/**
 * Create a mock LLM that returns predetermined responses based on prompt content.
 * Distinguishes planner calls (system prompt contains "tool planner") from
 * compiler calls (system prompt contains "code generator") by inspecting the prompt.
 */
function createMockLLM(
  plan: GenerationPlan,
  handlers: Record<string, string>,
): LLMClient {
  return {
    async generate(system: string, user: string): Promise<string> {
      // Planner call: system prompt mentions "tool planner"
      if (system.includes("tool planner")) {
        return JSON.stringify(plan);
      }

      // Compiler call: system prompt mentions "code generator"
      if (system.includes("code generator")) {
        for (const [toolName, code] of Object.entries(handlers)) {
          if (user.includes(`Name: ${toolName}`)) {
            return "```javascript\n" + code + "\n```";
          }
        }
      }

      throw new Error(`Unexpected LLM call: ${system.slice(0, 50)}... | ${user.slice(0, 50)}...`);
    },
  };
}

/**
 * Send a JSON-RPC request to the MCP server and get the response.
 */
function mcpRequest(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    });

    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            // Handle SSE format - extract JSON from event stream
            if (raw.startsWith("event:") || raw.startsWith("data:")) {
              const lines = raw.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const data = line.slice(6);
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.id === id) {
                      resolve(parsed);
                      return;
                    }
                  } catch {
                    // Not valid JSON, continue
                  }
                }
              }
              reject(new Error("No matching response found in SSE stream"));
            } else {
              resolve(JSON.parse(raw));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${raw.slice(0, 500)}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("end-to-end: HN API tools", () => {
  const prompt =
    "Create tools for the Hacker News API https://hacker-news.firebaseio.com";
  const contents: FetchedContent[] = [
    {
      url: "https://hacker-news.firebaseio.com",
      content:
        "The Hacker News API. Items are accessible at /v0/item/{id}.json. " +
        "Top stories at /v0/topstories.json. New stories at /v0/newstories.json.",
      contentType: "text/plain",
      discoveredUrls: [
        "https://hacker-news.firebaseio.com/v0/topstories.json",
        "https://hacker-news.firebaseio.com/v0/item/1.json",
      ],
    },
  ];
  const whitelist = buildWhitelist(
    ["https://hacker-news.firebaseio.com"],
    contents,
  );

  it("generates a plan with HN tools", async () => {
    const llm = createMockLLM(HN_PLAN, {});
    const plan = await generatePlan(llm, prompt, contents, whitelist);

    expect(plan.tools).toHaveLength(2);
    expect(plan.tools.map((t) => t.name)).toContain("get_top_stories");
    expect(plan.tools.map((t) => t.name)).toContain("get_item");
    expect(plan.tools[0].needs_network).toBe(true);
  });

  it("compiles plan into executable handlers", async () => {
    const llm = createMockLLM(HN_PLAN, {
      get_top_stories: HN_HANDLER_TOP_STORIES,
      get_item: HN_HANDLER_GET_ITEM,
    });

    // Skip the planner call by calling compilePlan directly
    const compiled = await compilePlan(llm, HN_PLAN, contents);

    expect(compiled.tools.size).toBe(2);
    expect(compiled.tools.has("get_top_stories")).toBe(true);
    expect(compiled.tools.has("get_item")).toBe(true);

    const topStories = compiled.tools.get("get_top_stories")!;
    expect(topStories.handler_code).toContain("topstories.json");
  });

  it("executes handlers against the real HN API", async () => {
    const whitelistedFetch = createWhitelistedFetch(whitelist);
    const sandbox = createSandbox(whitelistedFetch);

    const compiled: CompiledTools = {
      tools: new Map([
        [
          "get_top_stories",
          {
            name: "get_top_stories",
            description: "Get top stories",
            input_schema: { type: "object", properties: {} },
            handler_code: HN_HANDLER_TOP_STORIES,
            needs_network: true,
          },
        ],
        [
          "get_item",
          {
            name: "get_item",
            description: "Get an item",
            input_schema: { type: "object", properties: {} },
            handler_code: HN_HANDLER_GET_ITEM,
            needs_network: true,
          },
        ],
      ]),
      whitelist_domains: ["hacker-news.firebaseio.com"],
    };

    const executor = createExecutor(compiled, sandbox);

    // Test get_top_stories
    const topResult = await executor.execute("get_top_stories", { limit: 3 });
    expect(topResult.isError).toBeFalsy();
    expect(topResult.content).toHaveLength(1);
    const ids = JSON.parse(topResult.content[0].text);
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBe(3);
    expect(typeof ids[0]).toBe("number");

    // Test get_item with one of the returned IDs
    const itemResult = await executor.execute("get_item", { id: ids[0] });
    expect(itemResult.isError).toBeFalsy();
    const item = JSON.parse(itemResult.content[0].text);
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("type");
  }, 15_000); // Allow time for real API calls

  it("serves tools via MCP server and responds to ListTools and CallTool", async () => {
    const whitelistedFetch = createWhitelistedFetch(whitelist);
    const sandbox = createSandbox(whitelistedFetch);

    const compiled: CompiledTools = {
      tools: new Map([
        [
          "get_top_stories",
          {
            name: "get_top_stories",
            description: "Get top HN stories",
            input_schema: {
              type: "object",
              properties: {
                limit: { type: "number" },
              },
            },
            handler_code: HN_HANDLER_TOP_STORIES,
            needs_network: true,
          },
        ],
      ]),
      whitelist_domains: ["hacker-news.firebaseio.com"],
    };

    const executor = createExecutor(compiled, sandbox);
    const server = createExposedServer({ port: 0 }, executor);
    const port = await server.start();

    try {
      // First: initialize session
      const initResponse = await mcpRequest(port, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      });
      expect(initResponse.result).toBeDefined();

      // ListTools
      const listResponse = await mcpRequest(port, "tools/list", {}, 2);
      const listResult = listResponse.result as Record<string, unknown>;
      expect(listResult).toBeDefined();
      const tools = listResult.tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("get_top_stories");
      expect(tools[0].description).toBe("Get top HN stories");

      // CallTool
      const callResponse = await mcpRequest(
        port,
        "tools/call",
        {
          name: "get_top_stories",
          arguments: { limit: 2 },
        },
        3,
      );
      const callResult = callResponse.result as Record<string, unknown>;
      expect(callResult).toBeDefined();
      const content = callResult.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
      const storyIds = JSON.parse(content[0].text as string);
      expect(Array.isArray(storyIds)).toBe(true);
      expect(storyIds.length).toBe(2);
    } finally {
      await server.stop();
    }
  }, 15_000);
});

describe("end-to-end: pure computation tools", () => {
  const prompt = "Create calculator tools that can add and multiply numbers";
  const contents: FetchedContent[] = [];
  const whitelist = buildWhitelist([], []);

  it("generates and executes pure computation tools", async () => {
    const llm = createMockLLM(CALC_PLAN, {
      add_numbers: CALC_HANDLER_ADD,
      multiply_numbers: CALC_HANDLER_MULTIPLY,
    });

    const plan = await generatePlan(llm, prompt, contents, whitelist);
    expect(plan.tools).toHaveLength(2);
    expect(plan.tools.every((t) => !t.needs_network)).toBe(true);

    const compiled = await compilePlan(llm, plan, contents);
    expect(compiled.tools.size).toBe(2);

    // Execute in sandbox without network access
    const noopFetch = async () => {
      throw new Error("No network access");
    };
    const sandbox = createSandbox(noopFetch as unknown as typeof fetch);
    const executor = createExecutor(compiled, sandbox);

    // Test add
    const addResult = await executor.execute("add_numbers", { a: 17, b: 25 });
    expect(addResult.isError).toBeFalsy();
    expect(addResult.content[0].text).toBe("42");

    // Test multiply
    const mulResult = await executor.execute("multiply_numbers", {
      a: 6,
      b: 7,
    });
    expect(mulResult.isError).toBeFalsy();
    expect(mulResult.content[0].text).toBe("42");

    // Test unknown tool
    const unknownResult = await executor.execute("divide_numbers", {});
    expect(unknownResult.isError).toBe(true);
    expect(unknownResult.content[0].text).toContain("Unknown tool");
  });
});

describe("end-to-end: cache round-trip", () => {
  const prompt = "Create calculator tools";
  const contents: FetchedContent[] = [];
  const whitelist = buildWhitelist([], []);

  beforeEach(() => {
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("caches compiled tools and reloads them identically", async () => {
    const llm = createMockLLM(CALC_PLAN, {
      add_numbers: CALC_HANDLER_ADD,
      multiply_numbers: CALC_HANDLER_MULTIPLY,
    });

    // First run: generate and cache
    const plan = await generatePlan(llm, prompt, contents, whitelist);
    const compiled = await compilePlan(llm, plan, contents);
    compiled.whitelist_domains = [];

    const cache = createCache({ enabled: true, dir: TEST_CACHE_DIR });
    const promptHash = hash(prompt);
    const contentHash = hash("");

    const { compiledTools } = serializeCompiled(compiled);
    cache.set({
      promptHash,
      contentHash,
      plan,
      compiledTools,
      whitelist_domains: [],
      createdAt: new Date().toISOString(),
    });

    // Verify cache file exists
    expect(existsSync(TEST_CACHE_DIR)).toBe(true);

    // Second run: load from cache
    const cached = cache.get(promptHash, contentHash);
    expect(cached).not.toBeNull();
    expect(cached!.plan.tools).toHaveLength(2);
    expect(cached!.compiledTools).toHaveLength(2);

    // Verify cached tools produce the same results
    const noopFetch = async () => {
      throw new Error("No network access");
    };
    const sandbox = createSandbox(noopFetch as unknown as typeof fetch);

    // Reconstruct compiled tools from cache
    const restoredTools = new Map(
      cached!.compiledTools.map((t) => [t.name, t]),
    );
    const restoredCompiled: CompiledTools = {
      tools: restoredTools,
      whitelist_domains: cached!.whitelist_domains,
    };

    const executor = createExecutor(restoredCompiled, sandbox);

    const addResult = await executor.execute("add_numbers", { a: 100, b: 23 });
    expect(addResult.content[0].text).toBe("123");

    const mulResult = await executor.execute("multiply_numbers", {
      a: 11,
      b: 11,
    });
    expect(mulResult.content[0].text).toBe("121");
  });

  it("invalidates cache when content changes", () => {
    const cache = createCache({ enabled: true, dir: TEST_CACHE_DIR });
    const promptHash = hash(prompt);
    const contentHash1 = hash("version 1");
    const contentHash2 = hash("version 2");

    cache.set({
      promptHash,
      contentHash: contentHash1,
      plan: CALC_PLAN,
      compiledTools: [
        {
          name: "add_numbers",
          description: "Add",
          input_schema: {},
          handler_code: CALC_HANDLER_ADD,
          needs_network: false,
        },
      ],
      whitelist_domains: [],
      createdAt: new Date().toISOString(),
    });

    // Same prompt, same content hash → hit
    expect(cache.get(promptHash, contentHash1)).not.toBeNull();

    // Same prompt, different content hash → miss
    expect(cache.get(promptHash, contentHash2)).toBeNull();
  });
});

describe("end-to-end: health endpoint", () => {
  it("returns tool count on /health", async () => {
    const noopFetch = async () => {
      throw new Error("No network");
    };
    const sandbox = createSandbox(noopFetch as unknown as typeof fetch);

    const compiled: CompiledTools = {
      tools: new Map([
        [
          "test_tool",
          {
            name: "test_tool",
            description: "A test tool",
            input_schema: { type: "object", properties: {} },
            handler_code:
              'return { content: [{ type: "text", text: "ok" }] };',
            needs_network: false,
          },
        ],
      ]),
      whitelist_domains: [],
    };

    const executor = createExecutor(compiled, sandbox);
    const server = createExposedServer({ port: 0 }, executor);
    const port = await server.start();

    try {
      const response = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          http.get(`http://localhost:${port}/health`, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            });
            res.on("error", reject);
          });
        },
      );

      expect(response.status).toBe("ok");
      expect(response.tools).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
