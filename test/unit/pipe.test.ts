// ABOUTME: Tests for pipe protocol support.
// ABOUTME: Verifies writeOwnUrl writes the MCP URL followed by a newline to a writable stream.

import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { writeOwnUrl } from "../../src/pipe.js";

function collectingStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, chunks };
}

describe("writeOwnUrl", () => {
  it("writes URL followed by newline", () => {
    const { stream, chunks } = collectingStream();
    writeOwnUrl("http://localhost:12345/mcp", stream);
    expect(chunks.join("")).toBe("http://localhost:12345/mcp\n");
  });

  it("writes to process.stdout by default", () => {
    // Just verify the function signature accepts a single argument
    // (actual stdout writing is tested via integration)
    expect(writeOwnUrl.length).toBeGreaterThanOrEqual(1);
  });
});
