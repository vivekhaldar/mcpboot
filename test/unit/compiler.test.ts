// ABOUTME: Tests for the handler code compiler.
// ABOUTME: Verifies code extraction, validation, prompt building, and compilation of planned tools.

import { describe, it, expect } from "vitest";
import {
  extractCode,
  validateCode,
  buildHandlerPrompt,
  compilePlan,
} from "../../src/engine/compiler.js";
import type {
  LLMClient,
  FetchedContent,
  PlannedTool,
  GenerationPlan,
} from "../../src/types.js";

function makeMockLLM(response: string): LLMClient;
function makeMockLLM(responses: string[]): LLMClient;
function makeMockLLM(responseOrResponses: string | string[]): LLMClient {
  if (typeof responseOrResponses === "string") {
    return {
      async generate(): Promise<string> {
        return responseOrResponses;
      },
    };
  }
  let callIndex = 0;
  return {
    async generate(): Promise<string> {
      const response = responseOrResponses[callIndex];
      callIndex++;
      return response ?? "";
    },
  };
}

const NETWORK_TOOL: PlannedTool = {
  name: "get_items",
  description: "Fetches items from the API",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max items" },
    },
    required: [],
  },
  endpoints_used: ["GET https://api.example.com/items"],
  implementation_notes: "Call the items endpoint and return JSON",
  needs_network: true,
};

const PURE_TOOL: PlannedTool = {
  name: "calculate",
  description: "Performs a calculation",
  input_schema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression" },
    },
    required: ["expression"],
  },
  endpoints_used: [],
  implementation_notes: "Evaluate the expression safely and return result",
  needs_network: false,
};

const VALID_HANDLER_CODE = `
const url = "https://api.example.com/items?limit=" + (args.limit || 10);
const res = await fetch(url);
const data = await res.json();
return { content: [{ type: "text", text: JSON.stringify(data) }] };
`;

const VALID_PURE_CODE = `
const result = args.a + args.b;
return { content: [{ type: "text", text: String(result) }] };
`;

describe("extractCode", () => {
  it("extracts code from javascript code fences", () => {
    const input = "```javascript\nconst x = 1;\n```";
    expect(extractCode(input)).toBe("const x = 1;");
  });

  it("extracts code from js code fences", () => {
    const input = "```js\nconst x = 1;\n```";
    expect(extractCode(input)).toBe("const x = 1;");
  });

  it("extracts code from typescript code fences", () => {
    const input = "```typescript\nconst x: number = 1;\n```";
    expect(extractCode(input)).toBe("const x: number = 1;");
  });

  it("extracts code from ts code fences", () => {
    const input = "```ts\nconst x = 1;\n```";
    expect(extractCode(input)).toBe("const x = 1;");
  });

  it("extracts code from unfenced text", () => {
    const input = "const x = 1;\nreturn x;";
    expect(extractCode(input)).toBe("const x = 1;\nreturn x;");
  });

  it("extracts code from fences without language tag", () => {
    const input = "```\nconst x = 1;\n```";
    expect(extractCode(input)).toBe("const x = 1;");
  });

  it("extracts code when surrounded by explanation text", () => {
    const input =
      "Here is the handler:\n```javascript\nconst x = 1;\nreturn { content: [] };\n```\nThis handler does stuff.";
    expect(extractCode(input)).toBe(
      "const x = 1;\nreturn { content: [] };",
    );
  });

  it("trims whitespace from extracted code", () => {
    const input = "  const x = 1;  ";
    expect(extractCode(input)).toBe("const x = 1;");
  });
});

describe("validateCode", () => {
  it("accepts valid async function body", () => {
    const code =
      'const x = 1;\nreturn { content: [{ type: "text", text: String(x) }] };';
    expect(() => validateCode(code)).not.toThrow();
  });

  it("accepts code with await expressions", () => {
    const code =
      'const res = await fetch("https://example.com");\nconst data = await res.json();\nreturn { content: [{ type: "text", text: JSON.stringify(data) }] };';
    expect(() => validateCode(code)).not.toThrow();
  });

  it("accepts code with try/catch", () => {
    const code = `
try {
  const res = await fetch("https://example.com");
  return { content: [{ type: "text", text: "ok" }] };
} catch (e) {
  return { content: [{ type: "text", text: e.message }], isError: true };
}`;
    expect(() => validateCode(code)).not.toThrow();
  });

  it("rejects code with syntax errors", () => {
    const code = "const x = {;\nreturn x;";
    expect(() => validateCode(code)).toThrow();
  });

  it("rejects code with import statements", () => {
    const code = 'import fs from "fs";\nreturn { content: [] };';
    expect(() => validateCode(code)).toThrow();
  });

  it("rejects code with require calls", () => {
    const code = 'const fs = require("fs");\nreturn { content: [] };';
    expect(() => validateCode(code)).toThrow();
  });

  it("accepts empty code (syntactically valid)", () => {
    expect(() => validateCode("")).not.toThrow();
  });
});

describe("buildHandlerPrompt", () => {
  it("includes tool name and description", () => {
    const result = buildHandlerPrompt("Create API tools", NETWORK_TOOL, []);
    expect(result).toContain("get_items");
    expect(result).toContain("Fetches items from the API");
  });

  it("includes implementation notes", () => {
    const result = buildHandlerPrompt("Create API tools", NETWORK_TOOL, []);
    expect(result).toContain("Call the items endpoint and return JSON");
  });

  it("includes input schema", () => {
    const result = buildHandlerPrompt("Create API tools", NETWORK_TOOL, []);
    expect(result).toContain("limit");
  });

  it("includes endpoints used", () => {
    const result = buildHandlerPrompt("Create API tools", NETWORK_TOOL, []);
    expect(result).toContain("GET https://api.example.com/items");
  });

  it("includes fetched content", () => {
    const contents: FetchedContent[] = [
      {
        url: "https://api.example.com/docs",
        content: "Items API documentation with endpoints",
        contentType: "text/html",
        discoveredUrls: [],
      },
    ];
    const result = buildHandlerPrompt(
      "Create API tools",
      NETWORK_TOOL,
      contents,
    );
    expect(result).toContain("Items API documentation with endpoints");
    expect(result).toContain("https://api.example.com/docs");
  });

  it("includes original prompt for context", () => {
    const result = buildHandlerPrompt(
      "Create a weather API wrapper",
      NETWORK_TOOL,
      [],
    );
    expect(result).toContain("Create a weather API wrapper");
  });

  it("notes when tool does not need network", () => {
    const result = buildHandlerPrompt("Create calc tools", PURE_TOOL, []);
    expect(result).toContain("does NOT need network");
  });
});

describe("compilePlan", () => {
  it("compiles a single network tool", async () => {
    const plan: GenerationPlan = { tools: [NETWORK_TOOL] };
    const llm = makeMockLLM(
      "```javascript\n" + VALID_HANDLER_CODE + "\n```",
    );

    const result = await compilePlan(llm, plan, []);

    expect(result.tools.size).toBe(1);
    const tool = result.tools.get("get_items");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("get_items");
    expect(tool!.description).toBe("Fetches items from the API");
    expect(tool!.handler_code).toContain("fetch");
    expect(tool!.needs_network).toBe(true);
  });

  it("compiles a pure computation tool", async () => {
    const plan: GenerationPlan = { tools: [PURE_TOOL] };
    const llm = makeMockLLM(VALID_PURE_CODE);

    const result = await compilePlan(llm, plan, []);

    expect(result.tools.size).toBe(1);
    const tool = result.tools.get("calculate");
    expect(tool).toBeDefined();
    expect(tool!.needs_network).toBe(false);
  });

  it("compiles multiple tools sequentially", async () => {
    const plan: GenerationPlan = { tools: [NETWORK_TOOL, PURE_TOOL] };
    const llm = makeMockLLM([
      "```javascript\n" + VALID_HANDLER_CODE + "\n```",
      VALID_PURE_CODE,
    ]);

    const result = await compilePlan(llm, plan, []);

    expect(result.tools.size).toBe(2);
    expect(result.tools.has("get_items")).toBe(true);
    expect(result.tools.has("calculate")).toBe(true);
  });

  it("throws on LLM communication error", async () => {
    const plan: GenerationPlan = { tools: [NETWORK_TOOL] };
    const llm: LLMClient = {
      async generate(): Promise<string> {
        throw new Error("API error");
      },
    };

    await expect(compilePlan(llm, plan, [])).rejects.toThrow(
      /LLM error.*get_items/,
    );
  });

  it("throws when generated code has syntax errors after retries", async () => {
    const plan: GenerationPlan = { tools: [NETWORK_TOOL] };
    const llm = makeMockLLM("const x = {;");

    await expect(compilePlan(llm, plan, [])).rejects.toThrow(
      /Failed to compile.*get_items/,
    );
  });

  it("retries once on invalid code before failing", async () => {
    const plan: GenerationPlan = { tools: [NETWORK_TOOL] };
    let callCount = 0;
    const llm: LLMClient = {
      async generate(): Promise<string> {
        callCount++;
        if (callCount === 1) return "const x = {;";
        return VALID_HANDLER_CODE;
      },
    };

    const result = await compilePlan(llm, plan, []);
    expect(callCount).toBe(2);
    expect(result.tools.has("get_items")).toBe(true);
  });

  it("passes tool and content info to the LLM", async () => {
    const plan: GenerationPlan = { tools: [NETWORK_TOOL] };
    let capturedUser = "";
    const llm: LLMClient = {
      async generate(_system: string, user: string): Promise<string> {
        capturedUser = user;
        return VALID_HANDLER_CODE;
      },
    };

    const contents: FetchedContent[] = [
      {
        url: "https://api.example.com/docs",
        content: "API endpoint documentation",
        contentType: "text/html",
        discoveredUrls: [],
      },
    ];

    await compilePlan(llm, plan, contents);

    expect(capturedUser).toContain("get_items");
    expect(capturedUser).toContain("API endpoint documentation");
  });
});
