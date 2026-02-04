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
