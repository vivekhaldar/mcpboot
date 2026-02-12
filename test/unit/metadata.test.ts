// ABOUTME: Tests for the _mcp_metadata hidden tool in the MCP server.
// ABOUTME: Verifies metadata response shape and that the tool is hidden from listing.

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createExposedServer } from "../../src/server.js";
import { createExecutor } from "../../src/engine/executor.js";
import { createSandbox } from "../../src/engine/sandbox.js";
import { createWhitelistedFetch } from "../../src/whitelist.js";
import type { CompiledTools, Whitelist } from "../../src/types.js";

function mcpRequest(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, id });
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            if (raw.startsWith("event:") || raw.startsWith("data:")) {
              const lines = raw.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const data = line.slice(6);
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.id === id) {
                      resolve(parsed);
                      return;
                    }
                  } catch {}
                }
              }
              reject(new Error("No matching response found in SSE stream"));
            } else {
              resolve(JSON.parse(raw));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${raw.slice(0, 500)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("_mcp_metadata", () => {
  let server: { start(): Promise<number>; stop(): Promise<void> };
  let port: number;

  const compiled: CompiledTools = {
    tools: new Map([
      [
        "test_tool",
        {
          name: "test_tool",
          description: "A test tool",
          input_schema: { type: "object", properties: { x: { type: "number" } } },
          handler_code: 'return { content: [{ type: "text", text: "ok" }] };',
          needs_network: false,
        },
      ],
    ]),
    whitelist_domains: ["example.com"],
  };

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("returns metadata when _mcp_metadata is called", async () => {
    const whitelist: Whitelist = { domains: new Set(), allows: () => false };
    const whitelistedFetch = createWhitelistedFetch(whitelist);
    const sandbox = createSandbox(whitelistedFetch);
    const executor = createExecutor(compiled, sandbox);
    server = createExposedServer({ port: 0 }, executor, compiled);
    port = await server.start();

    // Initialize
    await mcpRequest(port, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    // Call _mcp_metadata
    const response = await mcpRequest(port, "tools/call", {
      name: "_mcp_metadata",
      arguments: {},
    }, 2);

    const result = response.result as Record<string, unknown>;
    expect(result).toBeDefined();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");

    const metadata = JSON.parse(content[0].text);
    expect(metadata.stage).toBe("boot");
    expect(metadata.version).toBeDefined();
    expect(metadata.upstream_url).toBeNull();
    expect(metadata.whitelist_domains).toEqual(["example.com"]);
    expect(metadata.tools).toHaveLength(1);
    expect(metadata.tools[0].name).toBe("test_tool");
    expect(metadata.tools[0].handler_code).toBeDefined();
    expect(metadata.tools[0].needs_network).toBe(false);
  });

  it("does not list _mcp_metadata in tools/list", async () => {
    const whitelist: Whitelist = { domains: new Set(), allows: () => false };
    const whitelistedFetch = createWhitelistedFetch(whitelist);
    const sandbox = createSandbox(whitelistedFetch);
    const executor = createExecutor(compiled, sandbox);
    server = createExposedServer({ port: 0 }, executor, compiled);
    port = await server.start();

    await mcpRequest(port, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    const listResponse = await mcpRequest(port, "tools/list", {}, 2);
    const listResult = listResponse.result as Record<string, unknown>;
    const tools = listResult.tools as Array<{ name: string }>;

    // _mcp_metadata should NOT appear in the tools list
    expect(tools.map(t => t.name)).not.toContain("_mcp_metadata");
    // But normal tools should
    expect(tools.map(t => t.name)).toContain("test_tool");
  });
});
