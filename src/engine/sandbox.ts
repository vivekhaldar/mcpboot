// ABOUTME: Executes LLM-generated handler code in a restricted Node.js vm context.
// ABOUTME: Provides whitelisted fetch access for API calls while blocking filesystem, process, and module access.

import vm from "node:vm";
import type { ToolCallResult } from "../types.js";

export interface Sandbox {
  runHandler(
    code: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult>;
}

const HANDLER_TIMEOUT_MS = 30_000;

export function createSandbox(
  whitelistedFetch: (url: string) => Promise<Response>,
  timeoutMs: number = HANDLER_TIMEOUT_MS,
): Sandbox {
  return {
    async runHandler(
      code: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
      const context = vm.createContext({
        // Safe data-manipulation globals
        JSON,
        Math,
        String,
        Number,
        Boolean,
        Array,
        Object,
        Map,
        Set,
        Date,
        RegExp,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        structuredClone,
        Promise,

        // URL handling
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Headers,
        Response,

        // Network access (whitelisted)
        fetch: whitelistedFetch,

        // Logging (redirected to stderr)
        console: {
          log: (...logArgs: unknown[]) =>
            console.error("[sandbox]", ...logArgs),
        },

        // Injected per-call
        inputArgs: structuredClone(args),
        fetchFn: whitelistedFetch,
      });

      const wrappedCode = `(async function(args, fetch) { ${code} })(inputArgs, fetchFn)`;
      const script = new vm.Script(wrappedCode);

      const resultPromise = script.runInContext(context, {
        timeout: timeoutMs,
      });

      // Race against a timeout for async operations (vm timeout only covers sync)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Handler timed out")),
          timeoutMs,
        );
      });

      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (!result || !Array.isArray(result.content)) {
        throw new Error("Handler must return {content: [...]}");
      }

      return result as ToolCallResult;
    },
  };
}
