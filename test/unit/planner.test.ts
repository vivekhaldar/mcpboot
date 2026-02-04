// ABOUTME: Tests for the generation plan planner.
// ABOUTME: Verifies plan generation, JSON extraction, validation, and user prompt formatting.

import { describe, it, expect } from "vitest";
import {
  generatePlan,
  extractJSON,
  validatePlan,
  validatePlanWhitelist,
  buildUserPrompt,
} from "../../src/engine/planner.js";
import type {
  LLMClient,
  FetchedContent,
  Whitelist,
  GenerationPlan,
} from "../../src/types.js";

function makeMockLLM(response: string): LLMClient {
  return {
    async generate(_system: string, _user: string): Promise<string> {
      return response;
    },
  };
}

function makeWhitelist(domains: string[]): Whitelist {
  const domainSet = new Set(domains);
  return {
    domains: domainSet,
    allows(url: string): boolean {
      const hostname = new URL(url).hostname;
      for (const d of domainSet) {
        if (hostname === d || hostname.endsWith("." + d)) return true;
      }
      return false;
    },
  };
}

const VALID_PLAN: GenerationPlan = {
  tools: [
    {
      name: "get_items",
      description: "Fetches items from the API",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max items to return" },
        },
        required: [],
      },
      endpoints_used: ["GET https://api.example.com/items"],
      implementation_notes: "Call the items endpoint and return the JSON array",
      needs_network: true,
    },
  ],
};

describe("extractJSON", () => {
  it("extracts JSON from plain text", () => {
    const input = '{"tools":[]}';
    expect(JSON.parse(extractJSON(input))).toEqual({ tools: [] });
  });

  it("extracts JSON from markdown code fences", () => {
    const input = '```json\n{"tools":[{"name":"test"}]}\n```';
    expect(JSON.parse(extractJSON(input))).toEqual({
      tools: [{ name: "test" }],
    });
  });

  it("extracts JSON from code fences without language tag", () => {
    const input = '```\n{"tools":[]}\n```';
    expect(JSON.parse(extractJSON(input))).toEqual({ tools: [] });
  });

  it("extracts JSON embedded in surrounding text", () => {
    const input =
      'Here is the plan:\n{"tools":[{"name":"hello"}]}\nThat is all.';
    expect(JSON.parse(extractJSON(input))).toEqual({
      tools: [{ name: "hello" }],
    });
  });
});

describe("validatePlan", () => {
  it("accepts a valid plan", () => {
    expect(() => validatePlan(VALID_PLAN)).not.toThrow();
  });

  it("accepts a plan with multiple tools", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "tool_a",
          description: "First tool",
          input_schema: { type: "object", properties: {} },
          endpoints_used: [],
          implementation_notes: "Does something",
          needs_network: false,
        },
        {
          name: "tool_b",
          description: "Second tool",
          input_schema: { type: "object", properties: {} },
          endpoints_used: ["GET https://api.example.com/b"],
          implementation_notes: "Calls API",
          needs_network: true,
        },
      ],
    };
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it("rejects a plan with no tools array", () => {
    expect(() => validatePlan({} as GenerationPlan)).toThrow(
      /missing or non-array 'tools'/,
    );
  });

  it("rejects a plan with empty tools array", () => {
    expect(() => validatePlan({ tools: [] })).toThrow(
      /'tools' array is empty/,
    );
  });

  it("rejects a tool with missing name", () => {
    const plan = {
      tools: [
        {
          name: "",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    } as GenerationPlan;
    expect(() => validatePlan(plan)).toThrow(/missing 'name'/);
  });

  it("rejects a tool with invalid name format", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "Invalid-Name",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    };
    expect(() => validatePlan(plan)).toThrow(/must be lowercase/);
  });

  it("rejects a tool name starting with a digit", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "1tool",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    };
    expect(() => validatePlan(plan)).toThrow(/must be lowercase/);
  });

  it("accepts a tool name with digits after the first character", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "tool_v2",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    };
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it("rejects duplicate tool names", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "my_tool",
          description: "First",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
        {
          name: "my_tool",
          description: "Second",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    };
    expect(() => validatePlan(plan)).toThrow(/Duplicate tool name/);
  });

  it("rejects a tool with missing description", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "my_tool",
          description: "",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    };
    expect(() => validatePlan(plan)).toThrow(/description is required/);
  });

  it("rejects a tool with missing input_schema", () => {
    const plan = {
      tools: [
        {
          name: "my_tool",
          description: "A tool",
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: false,
        },
      ],
    } as unknown as GenerationPlan;
    expect(() => validatePlan(plan)).toThrow(/input_schema is required/);
  });

  it("rejects a tool with missing implementation_notes", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "my_tool",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "",
          needs_network: false,
        },
      ],
    };
    expect(() => validatePlan(plan)).toThrow(
      /implementation_notes is required/,
    );
  });

  it("rejects a tool with non-boolean needs_network", () => {
    const plan = {
      tools: [
        {
          name: "my_tool",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: [],
          implementation_notes: "Notes",
          needs_network: "yes",
        },
      ],
    } as unknown as GenerationPlan;
    expect(() => validatePlan(plan)).toThrow(/needs_network must be a boolean/);
  });

  it("rejects a tool with non-array endpoints_used", () => {
    const plan = {
      tools: [
        {
          name: "my_tool",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: "GET https://api.example.com",
          implementation_notes: "Notes",
          needs_network: true,
        },
      ],
    } as unknown as GenerationPlan;
    expect(() => validatePlan(plan)).toThrow(/endpoints_used must be an array/);
  });
});

describe("validatePlanWhitelist", () => {
  it("passes when endpoints match whitelisted domains", () => {
    const whitelist = makeWhitelist(["api.example.com"]);
    expect(() => validatePlanWhitelist(VALID_PLAN, whitelist)).not.toThrow();
  });

  it("passes for subdomain when parent is whitelisted", () => {
    const whitelist = makeWhitelist(["example.com"]);
    expect(() => validatePlanWhitelist(VALID_PLAN, whitelist)).not.toThrow();
  });

  it("rejects when endpoint domain is not whitelisted", () => {
    const whitelist = makeWhitelist(["other.com"]);
    expect(() => validatePlanWhitelist(VALID_PLAN, whitelist)).toThrow(
      /not in the whitelist/,
    );
  });

  it("skips whitelist check for tools that do not need network", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "compute",
          description: "Pure computation",
          input_schema: { type: "object" },
          endpoints_used: ["GET https://evil.com/data"],
          implementation_notes: "Compute locally",
          needs_network: false,
        },
      ],
    };
    const whitelist = makeWhitelist([]);
    expect(() => validatePlanWhitelist(plan, whitelist)).not.toThrow();
  });

  it("skips endpoints without recognizable URLs", () => {
    const plan: GenerationPlan = {
      tools: [
        {
          name: "my_tool",
          description: "A tool",
          input_schema: { type: "object" },
          endpoints_used: ["some non-url text"],
          implementation_notes: "Notes",
          needs_network: true,
        },
      ],
    };
    const whitelist = makeWhitelist(["example.com"]);
    expect(() => validatePlanWhitelist(plan, whitelist)).not.toThrow();
  });
});

describe("buildUserPrompt", () => {
  it("includes the prompt text", () => {
    const result = buildUserPrompt(
      "Create weather tools",
      [],
      makeWhitelist([]),
    );
    expect(result).toContain("Create weather tools");
  });

  it("includes fetched content with source URLs", () => {
    const contents: FetchedContent[] = [
      {
        url: "https://api.example.com/docs",
        content: "API documentation here",
        contentType: "text/html",
        discoveredUrls: [],
      },
    ];
    const result = buildUserPrompt(
      "Create tools",
      contents,
      makeWhitelist(["api.example.com"]),
    );
    expect(result).toContain("https://api.example.com/docs");
    expect(result).toContain("API documentation here");
  });

  it("includes whitelisted domains", () => {
    const result = buildUserPrompt(
      "Create tools",
      [],
      makeWhitelist(["api.example.com", "data.example.com"]),
    );
    expect(result).toContain("api.example.com");
    expect(result).toContain("data.example.com");
  });

  it("notes when no domains are whitelisted", () => {
    const result = buildUserPrompt("Create tools", [], makeWhitelist([]));
    expect(result).toContain("No domains are whitelisted");
    expect(result).toContain("pure computation");
  });

  it("includes multiple content sources", () => {
    const contents: FetchedContent[] = [
      {
        url: "https://api1.example.com/docs",
        content: "First API docs",
        contentType: "text/html",
        discoveredUrls: [],
      },
      {
        url: "https://api2.example.com/docs",
        content: "Second API docs",
        contentType: "text/html",
        discoveredUrls: [],
      },
    ];
    const result = buildUserPrompt(
      "Create tools",
      contents,
      makeWhitelist(["api1.example.com", "api2.example.com"]),
    );
    expect(result).toContain("First API docs");
    expect(result).toContain("Second API docs");
    expect(result).toContain("api1.example.com");
  });
});

describe("generatePlan", () => {
  const whitelist = makeWhitelist(["api.example.com"]);

  it("generates a plan from LLM response", async () => {
    const llm = makeMockLLM(JSON.stringify(VALID_PLAN));
    const plan = await generatePlan(llm, "Create items API tools", [], whitelist);

    expect(plan.tools).toHaveLength(1);
    expect(plan.tools[0].name).toBe("get_items");
    expect(plan.tools[0].needs_network).toBe(true);
  });

  it("handles LLM response wrapped in code fences", async () => {
    const llm = makeMockLLM(
      "```json\n" + JSON.stringify(VALID_PLAN) + "\n```",
    );
    const plan = await generatePlan(llm, "Create tools", [], whitelist);

    expect(plan.tools).toHaveLength(1);
    expect(plan.tools[0].name).toBe("get_items");
  });

  it("throws on invalid JSON from LLM after retries", async () => {
    const llm = makeMockLLM("This is not JSON at all");
    await expect(
      generatePlan(llm, "Create tools", [], whitelist),
    ).rejects.toThrow(/Failed to parse plan JSON/);
  });

  it("throws on valid JSON but invalid plan structure after retries", async () => {
    const llm = makeMockLLM('{"not_a_plan": true}');
    await expect(
      generatePlan(llm, "Create tools", [], whitelist),
    ).rejects.toThrow();
  });

  it("retries once on invalid JSON before failing", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async generate(): Promise<string> {
        callCount++;
        if (callCount === 1) return "not json";
        return JSON.stringify(VALID_PLAN);
      },
    };
    const plan = await generatePlan(llm, "Create tools", [], whitelist);
    expect(callCount).toBe(2);
    expect(plan.tools).toHaveLength(1);
  });

  it("retries once on invalid plan before failing", async () => {
    let callCount = 0;
    const invalidPlan = { tools: [] };
    const llm: LLMClient = {
      async generate(): Promise<string> {
        callCount++;
        if (callCount === 1) return JSON.stringify(invalidPlan);
        return JSON.stringify(VALID_PLAN);
      },
    };
    const plan = await generatePlan(llm, "Create tools", [], whitelist);
    expect(callCount).toBe(2);
    expect(plan.tools).toHaveLength(1);
  });

  it("throws on LLM communication error", async () => {
    const llm: LLMClient = {
      async generate(): Promise<string> {
        throw new Error("API rate limit exceeded");
      },
    };
    await expect(
      generatePlan(llm, "Create tools", [], whitelist),
    ).rejects.toThrow(/LLM error during planning/);
  });

  it("passes prompt and content to the LLM", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    const llm: LLMClient = {
      async generate(system: string, user: string): Promise<string> {
        capturedSystem = system;
        capturedUser = user;
        return JSON.stringify(VALID_PLAN);
      },
    };

    const contents: FetchedContent[] = [
      {
        url: "https://api.example.com/docs",
        content: "Items API documentation",
        contentType: "text/html",
        discoveredUrls: [],
      },
    ];

    await generatePlan(llm, "Create items tools", contents, whitelist);

    expect(capturedSystem).toContain("MCP tool planner");
    expect(capturedUser).toContain("Create items tools");
    expect(capturedUser).toContain("Items API documentation");
    expect(capturedUser).toContain("api.example.com");
  });

  it("validates endpoints against whitelist", async () => {
    const planWithBadDomain: GenerationPlan = {
      tools: [
        {
          name: "bad_tool",
          description: "Calls non-whitelisted domain",
          input_schema: { type: "object" },
          endpoints_used: ["GET https://evil.com/data"],
          implementation_notes: "Call evil endpoint",
          needs_network: true,
        },
      ],
    };
    const llm = makeMockLLM(JSON.stringify(planWithBadDomain));
    await expect(
      generatePlan(llm, "Create tools", [], makeWhitelist(["example.com"])),
    ).rejects.toThrow(/not in the whitelist/);
  });

  it("generates plan for pure computation tools with empty whitelist", async () => {
    const purePlan: GenerationPlan = {
      tools: [
        {
          name: "calculate",
          description: "Performs a calculation",
          input_schema: {
            type: "object",
            properties: { expression: { type: "string" } },
          },
          endpoints_used: [],
          implementation_notes: "Evaluate the expression and return result",
          needs_network: false,
        },
      ],
    };
    const llm = makeMockLLM(JSON.stringify(purePlan));
    const plan = await generatePlan(
      llm,
      "Create a calculator",
      [],
      makeWhitelist([]),
    );

    expect(plan.tools).toHaveLength(1);
    expect(plan.tools[0].needs_network).toBe(false);
  });
});
