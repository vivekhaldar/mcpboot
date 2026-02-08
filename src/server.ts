// ABOUTME: MCP server exposed over HTTP that serves generated tools.
// ABOUTME: Delegates tool listing and tool calls to the Executor.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { ServerConfig } from "./types.js";
import type { Executor } from "./engine/executor.js";
import { warn, logEvent, setRequestId } from "./log.js";

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
    const reqId = randomBytes(6).toString("hex");
    setRequestId(reqId);

    logEvent("http_request", { method: req.method, url: req.url });

    if (req.method === "POST" && req.url === "/mcp") {
      const mcpServer = new Server(
        { name: "mcpboot", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );

      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = executor.getExposedTools();
        logEvent("mcp_list_tools", { tool_count: tools.length });
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
        logEvent("mcp_call_tool_start", {
          tool_name: name,
          args: args ?? {},
        });
        const start = performance.now();
        const result = await executor.execute(name, (args ?? {}) as Record<string, unknown>);
        const elapsed_ms = Math.round(performance.now() - start);
        logEvent("mcp_call_tool_end", {
          tool_name: name,
          result,
          elapsed_ms,
          is_error: result.isError ?? false,
        });
        return result;
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      try {
        const body = await readBody(req);
        logEvent("mcp_request_body", { body });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on("close", () => {
          setRequestId(undefined);
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
      logEvent("health_check", {
        tool_count: executor.getExposedTools().length,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          tools: executor.getExposedTools().length,
        }),
      );
    } else {
      logEvent("unknown_route", { method: req.method, url: req.url });
      res.writeHead(404);
      res.end("Not found");
    }

    setRequestId(undefined);
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
