// ABOUTME: Routes tool calls to generated handlers running in the sandbox.
// ABOUTME: Provides the Executor interface consumed by the MCP server.

import type { CompiledTools, ToolCallResult } from "../types.js";
import type { Sandbox } from "./sandbox.js";
import { verbose, verboseBody, verboseTimer } from "../log.js";

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
        verbose(`Executor: unknown tool "${toolName}"`);
        return {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
      }

      verbose(`Executor: running "${toolName}"`);
      verboseBody(`Executor: args for "${toolName}"`, JSON.stringify(args, null, 2));
      const done = verboseTimer(`Executor: "${toolName}" sandbox execution`);

      try {
        const result = await sandbox.runHandler(tool.handler_code, args);
        done();
        verboseBody(`Executor: result for "${toolName}"`, JSON.stringify(result, null, 2));
        return result;
      } catch (error) {
        done();
        const message =
          error instanceof Error ? error.message : String(error);
        verbose(`Executor: handler error for "${toolName}": ${message}`);
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
