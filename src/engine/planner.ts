// ABOUTME: Generates a structured GenerationPlan from a natural language prompt and fetched API docs.
// ABOUTME: Uses the LLM to plan MCP tools, validates the output, and retries on failure.

import type {
  LLMClient,
  FetchedContent,
  Whitelist,
  GenerationPlan,
  PlannedTool,
} from "../types.js";
import { warn, logEvent } from "../log.js";

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const SYSTEM_PROMPT = `You are an MCP tool planner. You receive a natural language description of desired tools, optionally with API documentation content, and you produce a STRUCTURED PLAN (as JSON) describing the tools to generate.

OUTPUT FORMAT:
Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
  "tools": [
    {
      "name": "tool_name",
      "description": "What the tool does",
      "input_schema": {
        "type": "object",
        "properties": {
          "param_name": { "type": "string", "description": "Parameter description" }
        },
        "required": ["param_name"]
      },
      "endpoints_used": ["GET https://api.example.com/items"],
      "implementation_notes": "Detailed description of how to implement this handler: what URL to call, how to parse the response, what to return",
      "needs_network": true
    }
  ]
}

RULES:
1. Tool names must be lowercase with underscores only (a-z, 0-9, _). Must start with a letter.
2. Each tool must have a unique name.
3. input_schema must be valid JSON Schema with "type": "object".
4. endpoints_used lists the HTTP endpoints the tool will call. Use format "METHOD url".
5. implementation_notes must be detailed enough for a code generator to write the handler.
6. Set needs_network to true if the tool makes HTTP requests, false for pure computation.
7. If API documentation is provided, base the tools on the actual API endpoints documented.
8. Create focused, single-purpose tools. Prefer multiple simple tools over one complex tool.
9. The endpoints_used URLs must use domains from the provided whitelist.
10. For pure computation tools (no API calls), set endpoints_used to an empty array.`;

export function extractJSON(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text.trim();
}

export function validatePlan(plan: GenerationPlan): void {
  if (!plan.tools || !Array.isArray(plan.tools)) {
    throw new Error("Invalid plan: missing or non-array 'tools' field");
  }

  if (plan.tools.length === 0) {
    throw new Error("Invalid plan: 'tools' array is empty");
  }

  const names = new Set<string>();

  for (const tool of plan.tools) {
    if (!tool.name) {
      throw new Error("Invalid plan: tool missing 'name'");
    }

    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `Invalid tool name "${tool.name}": must be lowercase letters, digits, and underscores, starting with a letter`,
      );
    }

    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: "${tool.name}"`);
    }
    names.add(tool.name);

    if (!tool.description) {
      throw new Error(`Tool "${tool.name}": description is required`);
    }

    if (!tool.input_schema || typeof tool.input_schema !== "object") {
      throw new Error(`Tool "${tool.name}": input_schema is required`);
    }

    if (!tool.implementation_notes) {
      throw new Error(`Tool "${tool.name}": implementation_notes is required`);
    }

    if (typeof tool.needs_network !== "boolean") {
      throw new Error(`Tool "${tool.name}": needs_network must be a boolean`);
    }

    if (!Array.isArray(tool.endpoints_used)) {
      throw new Error(`Tool "${tool.name}": endpoints_used must be an array`);
    }
  }
}

export function validatePlanWhitelist(
  plan: GenerationPlan,
  whitelist: Whitelist,
): void {
  for (const tool of plan.tools) {
    if (!tool.needs_network) continue;

    for (const endpoint of tool.endpoints_used) {
      // Extract URL from endpoint string like "GET https://api.example.com/items"
      const urlMatch = endpoint.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) continue;

      if (!whitelist.allows(urlMatch[0])) {
        throw new Error(
          `Tool "${tool.name}" uses endpoint "${endpoint}" whose domain is not in the whitelist`,
        );
      }
    }
  }
}

export function buildUserPrompt(
  prompt: string,
  contents: FetchedContent[],
  whitelist: Whitelist,
): string {
  let userPrompt = `GENERATION PROMPT:\n${prompt}\n`;

  if (contents.length > 0) {
    userPrompt += "\nFETCHED API DOCUMENTATION:\n";
    for (const content of contents) {
      userPrompt += `\n--- Source: ${content.url} ---\n${content.content}\n`;
    }
  }

  const domains = [...whitelist.domains];
  if (domains.length > 0) {
    userPrompt += `\nALLOWED DOMAINS (whitelist):\n${domains.join("\n")}\n`;
    userPrompt +=
      "\nGenerated tools may only make HTTP requests to these domains.\n";
  } else {
    userPrompt +=
      "\nNo domains are whitelisted. Generate only pure computation tools (needs_network: false).\n";
  }

  return userPrompt;
}

export async function generatePlan(
  llm: LLMClient,
  prompt: string,
  contents: FetchedContent[],
  whitelist: Whitelist,
): Promise<GenerationPlan> {
  const userPrompt = buildUserPrompt(prompt, contents, whitelist);
  let lastError: Error | null = null;

  logEvent("plan_start", {
    doc_count: contents.length,
    whitelist: [...whitelist.domains],
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      logEvent("plan_retry", { attempt: attempt + 1 });
    }

    let response: string;
    try {
      response = await llm.generate(SYSTEM_PROMPT, userPrompt);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`LLM error during planning: ${message}`);
    }

    logEvent("plan_llm_response", { response, attempt: attempt + 1 });

    const jsonText = extractJSON(response);
    let parsed: GenerationPlan;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      lastError = new Error(
        `Failed to parse plan JSON from LLM response: ${jsonText.slice(0, 200)}`,
      );
      if (attempt === 0) {
        warn("Invalid JSON from LLM, retrying...");
        continue;
      }
      throw lastError;
    }

    try {
      validatePlan(parsed);
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 0) {
        warn(`Invalid plan from LLM (${lastError.message}), retrying...`);
        continue;
      }
      throw lastError;
    }

    try {
      validatePlanWhitelist(parsed, whitelist);
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 0) {
        warn(
          `Plan whitelist violation (${lastError.message}), retrying...`,
        );
        continue;
      }
      throw lastError;
    }

    logEvent("plan_end", {
      tool_count: parsed.tools.length,
      tool_names: parsed.tools.map((t) => t.name),
      plan: parsed,
    });
    return parsed;
  }

  throw lastError ?? new Error("Plan generation failed");
}
