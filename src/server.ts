// ABOUTME: MCP server exposed over HTTP that serves generated tools.
// ABOUTME: Delegates tool listing and tool calls to the Executor.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import type { ServerConfig } from "./types.js";
import type { Executor } from "./engine/executor.js";
import { warn, verbose, verboseBody } from "./log.js";

export type { Executor };

export interface ExposedServer {
  start(): Promise<number>;
  stop(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        resolve(body);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function createExposedServer(
  config: ServerConfig,
  executor: Executor,
): ExposedServer {
  const httpServer = http.createServer(async (req, res) => {
    verbose(`HTTP ${req.method} ${req.url}`);

    if (req.method === "POST" && req.url === "/mcp") {
      const mcpServer = new Server(
        { name: "mcpboot", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );

      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = executor.getExposedTools();
        verbose(`MCP ListTools → returning ${tools.length} tool(s)`);
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      });

      mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        verbose(`MCP CallTool → tool="${name}"`);
        verboseBody(`MCP CallTool → args for "${name}"`, JSON.stringify(args ?? {}, null, 2));
        const result = await executor.execute(name, (args ?? {}) as Record<string, unknown>);
        verboseBody(`MCP CallTool → result for "${name}"`, JSON.stringify(result, null, 2));
        return result;
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      try {
        const body = await readBody(req);
        verboseBody("MCP request body", JSON.stringify(body, null, 2));
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on("close", () => {
          transport.close();
          mcpServer.close();
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        warn(`HTTP request error: ${message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        }
      }
    } else if (req.method === "GET" && req.url === "/health") {
      verbose("Health check requested");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          tools: executor.getExposedTools().length,
        }),
      );
    } else {
      verbose(`Unknown route: ${req.method} ${req.url} → 404`);
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return {
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(config.port, () => {
          const addr = httpServer.address();
          const actualPort =
            typeof addr === "object" && addr !== null ? addr.port : config.port;
          resolve(actualPort);
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
