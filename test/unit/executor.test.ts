// ABOUTME: Unit tests for the executor module.
// ABOUTME: Verifies tool dispatch, unknown tool handling, error propagation, and tool listing.

import { describe, it, expect, vi } from "vitest";
import { createExecutor } from "../../src/engine/executor.js";
import type { Sandbox } from "../../src/engine/sandbox.js";
import type { CompiledTools, ToolCallResult } from "../../src/types.js";

function makeSandbox(
  impl?: (
    code: string,
    args: Record<string, unknown>,
  ) => Promise<ToolCallResult>,
): Sandbox {
  return {
    runHandler: vi.fn(
      impl ??
        (async () => ({
          content: [{ type: "text", text: "ok" }],
        })),
    ),
  };
}

function makeCompiledTools(
  tools: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    handler_code?: string;
    needs_network?: boolean;
  }>,
): CompiledTools {
  const map = new Map<string, (typeof tools)[0] & { description: string; input_schema: Record<string, unknown>; handler_code: string; needs_network: boolean }>();
  for (const t of tools) {
    map.set(t.name, {
      name: t.name,
      description: t.description ?? `Tool ${t.name}`,
      input_schema: t.input_schema ?? { type: "object", properties: {} },
      handler_code: t.handler_code ?? 'return { content: [{ type: "text", text: "stub" }] };',
      needs_network: t.needs_network ?? false,
    });
  }
  return { tools: map, whitelist_domains: [] };
}

describe("createExecutor", () => {
  describe("execute", () => {
    it("dispatches known tool to sandbox", async () => {
      const sandbox = makeSandbox();
      const compiled = makeCompiledTools([
        { name: "greet", handler_code: 'return { content: [{ type: "text", text: "hello" }] };' },
      ]);
      const executor = createExecutor(compiled, sandbox);

      const result = await executor.execute("greet", { name: "world" });

      expect(sandbox.runHandler).toHaveBeenCalledOnce();
      expect(sandbox.runHandler).toHaveBeenCalledWith(
        'return { content: [{ type: "text", text: "hello" }] };',
        { name: "world" },
      );
      expect(result.content[0].text).toBe("ok");
    });

    it("returns error for unknown tool", async () => {
      const sandbox = makeSandbox();
      const compiled = makeCompiledTools([{ name: "greet" }]);
      const executor = createExecutor(compiled, sandbox);

      const result = await executor.execute("nonexistent", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("nonexistent");
      expect(sandbox.runHandler).not.toHaveBeenCalled();
    });

    it("catches handler errors and returns error result", async () => {
      const sandbox = makeSandbox(async () => {
        throw new Error("API call failed");
      });
      const compiled = makeCompiledTools([{ name: "fetch_data" }]);
      const executor = createExecutor(compiled, sandbox);

      const result = await executor.execute("fetch_data", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("API call failed");
    });

    it("passes args through to sandbox unchanged", async () => {
      const sandbox = makeSandbox();
      const compiled = makeCompiledTools([{ name: "search" }]);
      const executor = createExecutor(compiled, sandbox);

      const args = { query: "test", limit: 10, nested: { a: 1 } };
      await executor.execute("search", args);

      expect(sandbox.runHandler).toHaveBeenCalledWith(
        expect.any(String),
        args,
      );
    });

    it("returns sandbox result directly on success", async () => {
      const expectedResult: ToolCallResult = {
        content: [
          { type: "text", text: "result A" },
          { type: "text", text: "result B" },
        ],
      };
      const sandbox = makeSandbox(async () => expectedResult);
      const compiled = makeCompiledTools([{ name: "multi" }]);
      const executor = createExecutor(compiled, sandbox);

      const result = await executor.execute("multi", {});

      expect(result).toEqual(expectedResult);
    });
  });

  describe("getExposedTools", () => {
    it("returns all tools with name, description, and inputSchema", () => {
      const sandbox = makeSandbox();
      const compiled = makeCompiledTools([
        {
          name: "tool_a",
          description: "Does A",
          input_schema: { type: "object", properties: { x: { type: "number" } } },
        },
        {
          name: "tool_b",
          description: "Does B",
          input_schema: { type: "object", properties: { y: { type: "string" } } },
        },
      ]);
      const executor = createExecutor(compiled, sandbox);

      const tools = executor.getExposedTools();

      expect(tools).toHaveLength(2);
      expect(tools).toContainEqual({
        name: "tool_a",
        description: "Does A",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
      });
      expect(tools).toContainEqual({
        name: "tool_b",
        description: "Does B",
        inputSchema: { type: "object", properties: { y: { type: "string" } } },
      });
    });

    it("returns empty array when no tools are compiled", () => {
      const sandbox = makeSandbox();
      const compiled = makeCompiledTools([]);
      const executor = createExecutor(compiled, sandbox);

      expect(executor.getExposedTools()).toEqual([]);
    });
  });
});
