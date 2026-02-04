// ABOUTME: Routes tool calls to generated handlers running in the sandbox.
// ABOUTME: Provides the Executor interface consumed by the MCP server.

import type { ToolCallResult } from "../types.js";

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
