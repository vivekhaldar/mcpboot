// ABOUTME: Generates JavaScript handler code for each planned tool via LLM.
// ABOUTME: Compiles a GenerationPlan into CompiledTools with validated handler function bodies.

import type {
  LLMClient,
  FetchedContent,
  PlannedTool,
  GenerationPlan,
  CompiledTool,
  CompiledTools,
} from "../types.js";
import { warn, logEvent } from "../log.js";

const SYSTEM_PROMPT_NETWORK = `You are a JavaScript code generator for MCP tool handlers. You write async function BODIES (not full function declarations) that:

- Receive \`args\` (the tool call arguments object) and \`fetch\` (a whitelisted fetch function) as parameters
- Make HTTP calls using \`fetch\` to the specified API endpoints
- Parse responses
- Return \`{ content: [{ type: "text", text: "..." }] }\`
- Handle errors gracefully with try/catch and meaningful error messages

Available globals: JSON, Math, String, Number, Boolean, Array, Object, Map, Set, Date, RegExp, Promise, URL, URLSearchParams, TextEncoder, TextDecoder, Headers, Response, fetch, console.log, parseInt, parseFloat, isNaN, isFinite

NOT available: require, import, process, fs, net, http, Buffer, setTimeout, setInterval

OUTPUT FORMAT:
Return ONLY the function body code. No function declaration, no exports, no imports. The code will be wrapped in \`(async function(args, fetch) { YOUR_CODE_HERE })(inputArgs, fetchFn)\`.

Example output:
\`\`\`javascript
const url = "https://api.example.com/items?limit=" + (args.limit || 10);
const res = await fetch(url);
if (!res.ok) {
  return { content: [{ type: "text", text: "Error: " + res.status + " " + res.statusText }], isError: true };
}
const data = await res.json();
return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
\`\`\``;

const SYSTEM_PROMPT_PURE = `You are a JavaScript code generator for MCP tool handlers. You write async function BODIES (not full function declarations) that:

- Receive \`args\` (the tool call arguments object) as a parameter
- Perform computation using the provided arguments
- Return \`{ content: [{ type: "text", text: "..." }] }\`
- Handle errors gracefully with try/catch and meaningful error messages

This tool does NOT have network access. Do NOT use fetch.

Available globals: JSON, Math, String, Number, Boolean, Array, Object, Map, Set, Date, RegExp, Promise, URL, URLSearchParams, TextEncoder, TextDecoder, console.log, parseInt, parseFloat, isNaN, isFinite

NOT available: require, import, process, fs, net, http, Buffer, setTimeout, setInterval, fetch

OUTPUT FORMAT:
Return ONLY the function body code. No function declaration, no exports, no imports. The code will be wrapped in \`(async function(args) { YOUR_CODE_HERE })(inputArgs)\`.

Example output:
\`\`\`javascript
const result = args.a + args.b;
return { content: [{ type: "text", text: String(result) }] };
\`\`\``;

export function extractCode(text: string): string {
  const fenceMatch = text.match(
    /```(?:javascript|js|typescript|ts)?\s*\n?([\s\S]*?)\n?```/,
  );
  if (fenceMatch) return fenceMatch[1].trim();
  return text.trim();
}

export function validateCode(code: string): void {
  // Check for disallowed patterns
  if (/\bimport\s+/.test(code)) {
    throw new Error("Generated code must not use import statements");
  }
  if (/\brequire\s*\(/.test(code)) {
    throw new Error("Generated code must not use require()");
  }

  // Validate syntax by wrapping as an async function body
  try {
    new Function(`return (async function(args, fetch) { ${code} });`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JavaScript syntax: ${message}`);
  }
}

export function buildHandlerPrompt(
  prompt: string,
  tool: PlannedTool,
  contents: FetchedContent[],
): string {
  let userPrompt = `ORIGINAL PROMPT:\n${prompt}\n`;

  userPrompt += `\nTOOL TO IMPLEMENT:\n`;
  userPrompt += `Name: ${tool.name}\n`;
  userPrompt += `Description: ${tool.description}\n`;
  userPrompt += `Input Schema: ${JSON.stringify(tool.input_schema, null, 2)}\n`;
  userPrompt += `Implementation Notes: ${tool.implementation_notes}\n`;

  if (tool.needs_network) {
    userPrompt += `\nEndpoints Used:\n`;
    for (const endpoint of tool.endpoints_used) {
      userPrompt += `  - ${endpoint}\n`;
    }
  } else {
    userPrompt += `\nThis tool does NOT need network access. Do not use fetch.\n`;
  }

  if (contents.length > 0) {
    userPrompt += `\nAPI DOCUMENTATION:\n`;
    for (const content of contents) {
      userPrompt += `\n--- Source: ${content.url} ---\n${content.content}\n`;
    }
  }

  return userPrompt;
}

export async function compilePlan(
  llm: LLMClient,
  plan: GenerationPlan,
  contents: FetchedContent[],
): Promise<CompiledTools> {
  const tools = new Map<string, CompiledTool>();

  logEvent("compile_start", { tool_count: plan.tools.length });

  for (const plannedTool of plan.tools) {
    logEvent("compile_tool_start", {
      tool_name: plannedTool.name,
      needs_network: plannedTool.needs_network,
    });

    const systemPrompt = plannedTool.needs_network
      ? SYSTEM_PROMPT_NETWORK
      : SYSTEM_PROMPT_PURE;
    const userPrompt = buildHandlerPrompt("", plannedTool, contents);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        logEvent("compile_tool_retry", {
          tool_name: plannedTool.name,
          attempt: attempt + 1,
        });
      }

      let response: string;
      try {
        response = await llm.generate(systemPrompt, userPrompt);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `LLM error while compiling "${plannedTool.name}": ${message}`,
        );
      }

      logEvent("compile_tool_llm_response", {
        tool_name: plannedTool.name,
        response,
        attempt: attempt + 1,
      });

      const code = extractCode(response);

      try {
        validateCode(code);
      } catch (error: unknown) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        if (attempt === 0) {
          warn(
            `Invalid code for "${plannedTool.name}" (${lastError.message}), retrying...`,
          );
          continue;
        }
        throw new Error(
          `Failed to compile handler for "${plannedTool.name}": ${lastError.message}`,
        );
      }

      tools.set(plannedTool.name, {
        name: plannedTool.name,
        description: plannedTool.description,
        input_schema: plannedTool.input_schema,
        handler_code: code,
        needs_network: plannedTool.needs_network,
      });

      logEvent("compile_tool_end", {
        tool_name: plannedTool.name,
        code_length: code.length,
        handler_code: code,
      });
      break;
    }
  }

  return { tools, whitelist_domains: [] };
}
