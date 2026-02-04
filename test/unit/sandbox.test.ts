// ABOUTME: Tests for the sandboxed handler execution environment.
// ABOUTME: Verifies handler execution, fetch injection, security boundaries, timeouts, and result validation.

import { describe, it, expect, vi } from "vitest";
import { createSandbox } from "../../src/engine/sandbox.js";

describe("createSandbox", () => {
  function makeFetch() {
    return vi.fn(async (url: string) => {
      return new Response(JSON.stringify({ ok: true, url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  describe("runHandler", () => {
    it("executes a simple handler that returns a result", async () => {
      const sandbox = createSandbox(makeFetch());
      const result = await sandbox.runHandler(
        `return { content: [{ type: "text", text: "hello " + args.name }] };`,
        { name: "world" },
      );
      expect(result).toEqual({
        content: [{ type: "text", text: "hello world" }],
      });
    });

    it("can use fetch to make requests", async () => {
      const mockFetch = makeFetch();
      const sandbox = createSandbox(mockFetch);
      const code = `
        const res = await fetch("https://api.example.com/data");
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      `;
      const result = await sandbox.runHandler(code, {});
      expect(mockFetch).toHaveBeenCalledWith("https://api.example.com/data");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    });

    it("can use URL and URLSearchParams", async () => {
      const sandbox = createSandbox(makeFetch());
      const code = `
        const url = new URL("https://api.example.com/search");
        url.searchParams.set("q", args.query);
        return { content: [{ type: "text", text: url.toString() }] };
      `;
      const result = await sandbox.runHandler(code, { query: "test" });
      expect(result.content[0].text).toBe(
        "https://api.example.com/search?q=test",
      );
    });

    it("can use JSON, Math, Array, Object, Map, Set", async () => {
      const sandbox = createSandbox(makeFetch());
      const code = `
        const items = args.items;
        const unique = [...new Set(items)];
        const sum = unique.reduce((a, b) => a + b, 0);
        return { content: [{ type: "text", text: String(Math.round(sum)) }] };
      `;
      const result = await sandbox.runHandler(code, {
        items: [1, 2, 2, 3, 3],
      });
      expect(result.content[0].text).toBe("6");
    });

    it("can use Date", async () => {
      const sandbox = createSandbox(makeFetch());
      const code = `
        const d = new Date("2025-01-15T00:00:00Z");
        return { content: [{ type: "text", text: d.toISOString() }] };
      `;
      const result = await sandbox.runHandler(code, {});
      expect(result.content[0].text).toBe("2025-01-15T00:00:00.000Z");
    });

    it("can use TextEncoder and TextDecoder", async () => {
      const sandbox = createSandbox(makeFetch());
      const code = `
        const encoder = new TextEncoder();
        const bytes = encoder.encode("hello");
        const decoder = new TextDecoder();
        const text = decoder.decode(bytes);
        return { content: [{ type: "text", text }] };
      `;
      const result = await sandbox.runHandler(code, {});
      expect(result.content[0].text).toBe("hello");
    });

    it("passes args without mutating the original", async () => {
      const sandbox = createSandbox(makeFetch());
      const original = { name: "test", nested: { value: 1 } };
      const copy = structuredClone(original);

      await sandbox.runHandler(
        `args.name = "mutated"; args.nested.value = 999;
         return { content: [{ type: "text", text: "ok" }] };`,
        original,
      );

      expect(original).toEqual(copy);
    });
  });

  describe("security boundaries", () => {
    it("cannot access require", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(
          `const fs = require("fs"); return { content: [{ type: "text", text: "bad" }] };`,
          {},
        ),
      ).rejects.toThrow();
    });

    it("cannot access process", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(
          `return { content: [{ type: "text", text: process.env.HOME }] };`,
          {},
        ),
      ).rejects.toThrow();
    });

    it("cannot access fs", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(
          `const fs = require("fs"); return { content: [{ type: "text", text: "bad" }] };`,
          {},
        ),
      ).rejects.toThrow();
    });

    it("cannot access Buffer", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(
          `const b = Buffer.from("test"); return { content: [{ type: "text", text: "bad" }] };`,
          {},
        ),
      ).rejects.toThrow();
    });

    it("cannot access setTimeout", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(
          `setTimeout(() => {}, 1000); return { content: [{ type: "text", text: "bad" }] };`,
          {},
        ),
      ).rejects.toThrow();
    });
  });

  describe("timeout", () => {
    it("kills infinite loops within timeout", { timeout: 15000 }, async () => {
      const sandbox = createSandbox(makeFetch(), 2000);
      await expect(
        sandbox.runHandler(
          `while(true) {} return { content: [{ type: "text", text: "never" }] };`,
          {},
        ),
      ).rejects.toThrow();
    });
  });

  describe("result validation", () => {
    it("throws when handler returns non-object", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(`return 42;`, {}),
      ).rejects.toThrow("Handler must return {content: [...]}");
    });

    it("throws when handler returns null", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(`return null;`, {}),
      ).rejects.toThrow("Handler must return {content: [...]}");
    });

    it("throws when handler returns object without content array", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(`return { text: "wrong shape" };`, {}),
      ).rejects.toThrow("Handler must return {content: [...]}");
    });

    it("throws when handler has no return statement", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(`const x = 1;`, {}),
      ).rejects.toThrow("Handler must return {content: [...]}");
    });
  });

  describe("error handling in handler code", () => {
    it("propagates errors thrown by handler code", async () => {
      const sandbox = createSandbox(makeFetch());
      await expect(
        sandbox.runHandler(`throw new Error("handler error");`, {}),
      ).rejects.toThrow("handler error");
    });

    it("propagates fetch errors", async () => {
      const failingFetch = vi.fn(async () => {
        throw new Error("network error");
      });
      const sandbox = createSandbox(failingFetch);
      await expect(
        sandbox.runHandler(
          `const res = await fetch("https://example.com"); return { content: [{ type: "text", text: "ok" }] };`,
          {},
        ),
      ).rejects.toThrow("network error");
    });
  });

  describe("console.log in sandbox", () => {
    it("does not throw when console.log is called", async () => {
      const sandbox = createSandbox(makeFetch());
      const result = await sandbox.runHandler(
        `console.log("debug info"); return { content: [{ type: "text", text: "ok" }] };`,
        {},
      );
      expect(result.content[0].text).toBe("ok");
    });
  });
});
