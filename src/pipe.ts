// ABOUTME: Pipe protocol support for chaining mcpboot with downstream MCP processes.
// ABOUTME: Writes this server's MCP URL to stdout so the next process in a pipe can connect.

import type { Writable } from "node:stream";

export function writeOwnUrl(url: string, output: Writable = process.stdout): void {
  output.write(url + "\n");
}
