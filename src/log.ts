// ABOUTME: Centralized logging for mcpboot with verbose mode support.
// ABOUTME: All output goes to stderr to keep the MCP protocol channel clean.

let verboseEnabled = false;

export function setVerbose(enabled: boolean) {
  verboseEnabled = enabled;
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

export function log(msg: string) {
  console.error(`[mcpboot] ${msg}`);
}

export function warn(msg: string) {
  console.error(`[mcpboot] WARN: ${msg}`);
}

export function verbose(msg: string) {
  if (verboseEnabled) console.error(`[mcpboot] ${msg}`);
}

/**
 * Log a verbose message with a truncated body preview.
 * Shows up to `limit` characters with a note about total length.
 */
export function verboseBody(label: string, body: string, limit: number = 500) {
  if (!verboseEnabled) return;
  const preview = body.length > limit ? body.slice(0, limit) + `... (${body.length} chars total)` : body;
  console.error(`[mcpboot] ${label}:\n${preview}`);
}

/**
 * Log the start of a timed operation. Returns a function that logs completion with elapsed time.
 */
export function verboseTimer(label: string): () => void {
  if (!verboseEnabled) return () => {};
  const start = performance.now();
  console.error(`[mcpboot] ${label} — started`);
  return () => {
    const elapsed = (performance.now() - start).toFixed(0);
    console.error(`[mcpboot] ${label} — completed in ${elapsed}ms`);
  };
}
