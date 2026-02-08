// ABOUTME: Routes tool calls to generated handlers running in the sandbox.
// ABOUTME: Provides the Executor interface consumed by the MCP server.

import type { CompiledTools, ToolCallResult } from "../types.js";
import type { Sandbox } from "./sandbox.js";
import { logEvent, trackSandbox } from "../log.js";

export interface Executor {
  execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  getExposedTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export function createExecutor(
  compiled: CompiledTools,
  sandbox: Sandbox,
): Executor {
  return {
    async execute(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
      const tool = compiled.tools.get(toolName);
      if (!tool) {
        logEvent("executor_unknown_tool", { tool_name: toolName });
        return {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
      }

      logEvent("executor_start", { tool_name: toolName, args });
      const start = performance.now();

      try {
        const result = await sandbox.runHandler(tool.handler_code, args);
        const elapsed_ms = Math.round(performance.now() - start);
        trackSandbox(elapsed_ms);
        logEvent("executor_end", {
          tool_name: toolName,
          result,
          elapsed_ms,
          is_error: false,
        });
        return result;
      } catch (error) {
        const elapsed_ms = Math.round(performance.now() - start);
        trackSandbox(elapsed_ms);
        const message =
          error instanceof Error ? error.message : String(error);
        logEvent("executor_error", {
          tool_name: toolName,
          error: message,
          elapsed_ms,
        });
        return {
          content: [{ type: "text", text: `Handler error: ${message}` }],
          isError: true,
        };
      }
    },

    getExposedTools() {
      return Array.from(compiled.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
      }));
    },
  };
}
