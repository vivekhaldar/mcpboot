// ABOUTME: Generates a structured GenerationPlan from a natural language prompt and fetched API docs.
// ABOUTME: Uses the LLM to plan MCP tools, validates the output, and retries on failure.

import type {
  LLMClient,
  FetchedContent,
  Whitelist,
  GenerationPlan,
  PlannedTool,
} from "../types.js";
import { warn, verbose } from "../log.js";

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const SYSTEM_PROMPT = `You are an MCP tool planner. You receive a natural language description of desired tools, optionally with API documentation content, and you produce a STRUCTURED PLAN (as JSON) describing the tools to generate.

IMPORTANT: The tool descriptions and schemas you produce will be consumed by downstream AI/LLM systems to understand each tool's behavior, generate web UIs, and produce correct tool calls. Descriptions and schemas must therefore be thorough, self-contained, and richly annotated.

OUTPUT FORMAT:
Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
  "tools": [
    {
      "name": "tool_name",
      "description": "A comprehensive, multi-paragraph description (see DESCRIPTION GUIDELINES below)",
      "input_schema": {
        "type": "object",
        "properties": {
          "param_name": {
            "type": "string",
            "description": "Detailed parameter description including purpose, format, and constraints",
            "default": "optional default value if applicable",
            "examples": ["example_value_1", "example_value_2"]
          }
        },
        "required": ["param_name"]
      },
      "endpoints_used": ["GET https://api.example.com/items"],
      "implementation_notes": "Detailed description of how to implement this handler: what URL to call, how to parse the response, what to return",
      "needs_network": true
    }
  ]
}

DESCRIPTION GUIDELINES:
Each tool's "description" field must be a rich, self-contained documentation string. Include ALL of the following sections, separated by blank lines:

1. SUMMARY: A clear one-sentence summary of what the tool does.
2. DETAILS: When to use this tool, how it relates to other tools, any important behavioral notes or caveats.
3. RESPONSE FORMAT: Describe the structure and fields of a successful response. Include a concrete JSON example.
4. EXAMPLE: Show at least one realistic usage example with sample parameter values and a corresponding example response.
5. ERRORS: List common error scenarios (e.g., invalid input, resource not found, rate limits).

Example of a good description:

"Retrieves the full details of a specific Hacker News item (story, comment, job, poll, or pollopt) by its unique numeric ID.\\n\\nUse this tool when you have an item ID (e.g. from get_top_stories) and need its title, author, score, URL, or child comments. Each item type returns slightly different fields.\\n\\nResponse format:\\nReturns a JSON object with the item details. Fields vary by type. Stories include: id, type, by, title, url, score, time, descendants, kids. Comments include: id, type, by, text, parent, time, kids.\\n\\nExample response:\\n{\\n  \\"id\\": 8863,\\n  \\"type\\": \\"story\\",\\n  \\"by\\": \\"dhouston\\",\\n  \\"title\\": \\"My YC app: Dropbox\\",\\n  \\"url\\": \\"http://www.getdropbox.com/u/2/screencast.html\\",\\n  \\"score\\": 111,\\n  \\"time\\": 1175714200,\\n  \\"descendants\\": 71\\n}\\n\\nExample usage:\\n- Input: { \\"id\\": 8863 }\\n- Returns the full item object for story 8863\\n\\nErrors:\\n- Returns an error if the item ID does not exist or the API is unreachable."

INPUT SCHEMA GUIDELINES:
Use the full power of JSON Schema to describe each parameter precisely:
- Every property MUST have a "description" explaining its purpose, expected format, and constraints.
- Use "default" to document the default value when a parameter is optional.
- Use "examples" (array) to provide 2-3 realistic example values.
- Use "minimum" / "maximum" for numeric bounds when applicable.
- Use "enum" for parameters with a fixed set of allowed values.
- Use "pattern" for string parameters with a specific format (e.g., date patterns).
- Use "minLength" / "maxLength" for string length constraints when applicable.

Example of a good input_schema:
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "Maximum number of story IDs to return. The API provides up to 500 stories; this parameter caps the result to the specified count.",
      "default": 10,
      "minimum": 1,
      "maximum": 500,
      "examples": [5, 10, 50]
    },
    "id": {
      "type": "number",
      "description": "The unique numeric Hacker News item ID. Item IDs are positive integers assigned sequentially. Obtain item IDs from tools like get_top_stories or get_new_stories.",
      "minimum": 1,
      "examples": [8863, 37052586]
    }
  },
  "required": ["id"]
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

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: string;
    try {
      response = await llm.generate(SYSTEM_PROMPT, userPrompt);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`LLM error during planning: ${message}`);
    }

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

    verbose(`Generated plan:\n${JSON.stringify(parsed, null, 2)}`);
    return parsed;
  }

  throw lastError ?? new Error("Plan generation failed");
}
