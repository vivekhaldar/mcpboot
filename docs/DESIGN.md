# mcpboot — Engineering Design Document

**Version:** 1.0
**Author:** Claude (reviewed by Vivek Haldar)
**Date:** 2026-02-03
**Status:** Draft
**PRD:** [docs/PRD.md](./PRD.md)

---

## 1. Overview

mcpboot generates and serves an MCP server from a natural language prompt. The user provides a description of desired tools (optionally with links to API documentation), and mcpboot:

1. Fetches and parses any referenced URLs
2. Uses an LLM to plan what tools to create
3. Uses the LLM to generate JavaScript handler code for each tool
4. Caches everything
5. Serves the tools as an MCP server over HTTP

The LLM is used **only at startup**. At runtime, tool calls execute cached generated JavaScript with no LLM involvement.

### 1.1 Relationship to mcpblox

mcpboot shares significant architecture with [mcpblox](https://github.com/vivekhaldar/mcpblox). This table summarizes what's reused vs. what's new:

| Component | mcpblox | mcpboot | Reuse? |
|-----------|---------|---------|--------|
| CLI parsing (`config.ts`) | Parses upstream + prompt flags | Parses prompt flags (no upstream) | **Adapt** — remove upstream flags, keep everything else |
| LLM client (`llm.ts`) | Vercel AI SDK multi-provider | Identical | **Copy verbatim** |
| Cache (`cache.ts`) | hash + file-based JSON | Same pattern, different types | **Adapt** — change CacheEntry type |
| MCP server (`server.ts`) | StreamableHTTP exposed server | Identical | **Copy verbatim** |
| Logging (`log.ts`) | stderr with verbose mode | Identical (change prefix) | **Copy, rename prefix** |
| Planner (`engine/planner.ts`) | TransformPlan from upstream tools | GenerationPlan from fetched docs | **Rewrite** — different LLM prompts, different plan shape |
| Compiler (`engine/compiler.ts`) | Generates transform functions | Generates handler functions | **Rewrite** — different codegen target |
| Executor (`engine/executor.ts`) | Routes through transforms | Routes to handlers | **Adapt** — simpler (no transform chain) |
| Sandbox (`engine/sandbox.ts`) | Restricted vm, no network | Restricted vm, **with** whitelisted fetch | **Extend** — add fetch proxy |
| Types (`types.ts`) | Transform-oriented types | Generation-oriented types | **Rewrite** |
| Upstream client (`upstream.ts`) | MCP client for upstream server | **Not needed** | **Drop** |
| Pipe protocol (`pipe.ts`) | stdin/stdout URL chaining | **Not needed for MVP** | **Drop** |
| URL fetcher (`fetcher.ts`) | N/A | **New** — fetch + parse URLs | **New** |
| URL whitelist (`whitelist.ts`) | N/A | **New** — domain whitelist | **New** |

---

## 2. Architecture

```
┌──────────┐      ┌─────────────────────────────────────────────┐
│          │      │                  mcpboot                     │
│   MCP    │◄────►│  ┌────────┐  ┌────────────┐                │
│   Host   │ HTTP │  │Exposed │  │  Executor  │                │
│          │      │  │Server  │──│            │                │
└──────────┘      │  └────────┘  └──────┬─────┘                │
                  │                     │                        │
                  │           ┌─────────▼──────────┐            │
                  │           │ Sandbox (vm)        │            │      ┌───────────┐
                  │           │ ┌────────────────┐  │   fetch    │      │           │
                  │           │ │ Generated      │──│──(whitelist)──────►│ External  │
                  │           │ │ Handler Code   │  │            │      │ APIs      │
                  │           │ └────────────────┘  │            │      │           │
                  │           └────────────────────┘            │      └───────────┘
                  │                                              │
                  │  ─── Startup only ───────────────────────── │
                  │  ┌──────────┐  ┌─────────┐  ┌───────────┐  │
                  │  │URL Fetch │─►│ Planner │─►│ Compiler  │  │
                  │  └──────────┘  └─────────┘  └───────────┘  │
                  │        │            │             │          │
                  │        │      ┌─────▼─────┐      │          │
                  │        │      │    LLM    │      │          │
                  │        │      └───────────┘      │          │
                  │        └────────────┬────────────┘          │
                  │               ┌─────▼─────┐                 │
                  │               │   Cache   │                 │
                  │               └───────────┘                 │
                  └─────────────────────────────────────────────┘
```

### 2.1 Startup Data Flow

```
CLI args
  │
  ▼
buildConfig()         → Config
  │
  ▼
extractUrls(prompt)   → URL[]
  │
  ▼
fetchAll(urls)        → FetchedContent[]     (fetch pages, extract text)
  │
  ▼
buildWhitelist(urls, content)  → Whitelist   (domains from prompt + fetched pages)
  │
  ▼
cache.get(promptHash, contentHash)
  │
  ├── hit  → deserialize → CompiledTools
  │
  └── miss:
        │
        ▼
      planner.generatePlan(llm, prompt, content)  → GenerationPlan
        │
        ▼
      compiler.compilePlan(llm, plan, content)    → CompiledTools
        │
        ▼
      cache.set(...)
  │
  ▼
createExecutor(compiled, whitelist)  → Executor
  │
  ▼
createExposedServer(config, executor).start()
```

### 2.2 Runtime Data Flow (Tool Call)

```
MCP Host → POST /mcp (CallTool)
  │
  ▼
Executor.execute(toolName, args)
  │
  ▼
sandbox.runHandler(handler_code, args, whitelistedFetch)
  │
  ▼
Generated JS runs:
  - Builds URL from args
  - Calls fetch() → proxy checks whitelist → real fetch
  - Parses response
  - Formats MCP result
  │
  ▼
Return { content: [{ type: "text", text: "..." }] }
```

---

## 3. Component Designs

### 3.1 Types (`src/types.ts`)

New types for mcpboot, replacing mcpblox's transform-oriented types:

```typescript
// ─── Config ────────────────────────────────────────────────
interface Config {
  prompt: string;
  llm: LLMConfig;
  server: ServerConfig;
  cache: CacheConfig;
  dryRun: boolean;
  verbose: boolean;
}

// LLMConfig, ServerConfig, CacheConfig — identical to mcpblox

// ─── Fetched Content ───────────────────────────────────────
interface FetchedContent {
  url: string;
  content: string;         // extracted text (markdown/plain)
  contentType: string;     // original content-type header
  discoveredUrls: string[]; // URLs found within this page
}

// ─── Whitelist ─────────────────────────────────────────────
interface Whitelist {
  domains: Set<string>;
  allows(url: string): boolean;
}

// ─── Generation Plan ───────────────────────────────────────
interface GenerationPlan {
  tools: PlannedTool[];
}

interface PlannedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  endpoints_used: string[];           // e.g. ["GET https://api.example.com/items"]
  implementation_notes: string;       // natural language description for compiler
  needs_network: boolean;             // false for pure-computation tools
}

// ─── Compiled Tools ────────────────────────────────────────
interface CompiledTools {
  tools: Map<string, CompiledTool>;
  whitelist_domains: string[];        // persisted in cache for reconstruction
}

interface CompiledTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler_code: string;               // JavaScript async function body
  needs_network: boolean;
}

// ─── Executor ──────────────────────────────────────────────
interface ToolCallResult {
  content: Array<{ type: string; text: string; [key: string]: unknown }>;
  isError?: boolean;
}

// ─── Cache ─────────────────────────────────────────────────
interface CacheEntry {
  promptHash: string;
  contentHash: string;
  plan: GenerationPlan;
  compiledTools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    handler_code: string;
    needs_network: boolean;
  }>;
  whitelist_domains: string[];
  createdAt: string;
}

// ─── LLM ───────────────────────────────────────────────────
interface LLMClient {
  generate(system: string, user: string): Promise<string>;
}
```

**Design decision: flat tool list, not categorized.** mcpblox needs categories (pass-through, modified, hidden, synthetic) because it transforms existing tools. mcpboot creates all tools from scratch, so a flat list is simpler and more appropriate.

### 3.2 Config (`src/config.ts`)

Adapted from mcpblox. Key changes:
- Remove all `--upstream*` flags
- Remove `PipeConfig` (no pipe support in MVP)
- Require `--prompt` or `--prompt-file` (no pass-through mode)
- Keep: `--provider`, `--model`, `--api-key`, `--port`, `--cache-dir`, `--no-cache`, `--verbose`, `--dry-run`

```
mcpboot [options]

Required:
  --prompt <text>              Generation prompt (inline)
  --prompt-file <path>         Generation prompt from file

Optional:
  --provider <name>            LLM provider: anthropic | openai (default: anthropic)
  --model <id>                 LLM model ID (default: provider-specific)
  --api-key <key>              LLM API key (env: ANTHROPIC_API_KEY | OPENAI_API_KEY)
  --port <number>              HTTP server port (default: 8000)
  --cache-dir <path>           Cache directory (default: .mcpboot-cache)
  --no-cache                   Disable caching
  --verbose                    Verbose logging
  --dry-run                    Show generation plan without starting server
```

**Validation rules:**
- Exactly one of `--prompt` or `--prompt-file` is required
- API key is required (flag > env var)
- Port must be valid integer 0–65535

### 3.3 URL Fetcher (`src/fetcher.ts`)

**New component.** Fetches URLs referenced in the prompt and extracts usable text content.

#### URL extraction from prompt

Use a regex to find all URLs in the prompt text:
```
/(https?:\/\/[^\s"'<>)\]]+)/g
```

#### Fetch + content extraction

For each URL:
1. `fetch()` with a 15-second timeout and a user-agent header
2. Check content-type:
   - `application/json` → store as-is (may be OpenAPI spec or API response)
   - `text/html` → strip HTML tags, extract main content text. Use a simple approach: strip `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>` tags first, then strip all remaining tags. This is intentionally simple — we don't need a full DOM parser.
   - `text/markdown` or `text/plain` → store as-is
3. Extract URLs found in the fetched content (for whitelist + potential second-level fetch)

#### GitHub URL special handling

GitHub repository URLs like `https://github.com/HackerNews/API` need special treatment because the HTML page contains rendered markdown buried in UI chrome. Instead:
- Detect `github.com/:owner/:repo` pattern
- Rewrite to `https://raw.githubusercontent.com/:owner/:repo/HEAD/README.md`
- Fetch the raw README directly

**Design decision: simple HTML stripping vs. DOM parser.** A full DOM parser (like `cheerio` or `jsdom`) would be more accurate but adds a dependency. Since the extracted text goes to an LLM (which is robust to noise), simple tag stripping is good enough. If HTML extraction quality becomes a problem, we can add a dependency later.

**Design decision: one level of URL following.** We fetch URLs from the prompt, and we extract URLs from those pages (for the whitelist). We do NOT recursively follow those discovered URLs to fetch their content. This keeps the startup bounded and predictable. The LLM gets the direct content; the discovered URLs just expand the whitelist.

#### Content size management

API docs can be very large. Strategies:
- Truncate each fetched page to 100,000 characters (well within modern LLM context windows)
- If total fetched content exceeds 200,000 characters, summarize: keep the first and last 20,000 characters of each page, plus any JSON/YAML blocks (likely to be endpoint definitions)
- Log a warning when truncation occurs

#### Interface

```typescript
interface FetchResult {
  contents: FetchedContent[];
  whitelist: Whitelist;
}

async function fetchUrls(urls: string[]): Promise<FetchResult>;
```

### 3.4 Whitelist (`src/whitelist.ts`)

**New component.** Constructs and enforces the domain whitelist for the runtime sandbox.

#### Construction

```typescript
function buildWhitelist(promptUrls: string[], fetchedContents: FetchedContent[]): Whitelist;
```

1. Extract domains from all prompt URLs → add to set
2. For each FetchedContent, extract domains from `discoveredUrls` → add to set
3. Return a `Whitelist` object with a `allows(url: string): boolean` method

#### Enforcement

The whitelist checks are at the domain level (not full URL). A URL is allowed if its hostname matches any whitelisted domain or is a subdomain of one:
- Whitelist has `example.com` → `api.example.com` is allowed
- Whitelist has `api.example.com` → `example.com` is NOT allowed (more specific doesn't grant broader)

**Design decision: domain-level, not URL-path-level.** URL-path-level whitelisting would be more restrictive but also more fragile (APIs often have many path patterns). Domain-level is the right granularity — if you trust the API, you trust its whole domain.

#### createWhitelistedFetch

```typescript
function createWhitelistedFetch(whitelist: Whitelist): typeof fetch;
```

Returns a `fetch` wrapper that:
1. Parses the URL
2. Calls `whitelist.allows(url)`
3. If allowed: delegates to real `fetch`
4. If blocked: throws `Error: Fetch blocked: domain "evil.com" not in whitelist. Add it to your prompt to allow access.`

The error message is important — it tells the user exactly how to fix the problem.

### 3.5 Generation Engine

#### 3.5.1 Planner (`src/engine/planner.ts`)

**Rewrite from mcpblox.** Same structure (system prompt + user prompt → structured JSON → validate), but different content.

**System prompt** instructs the LLM to:
- Read the provided API documentation
- Plan a set of MCP tools that cover the API's capabilities (or just the ones the user requested)
- For each tool, specify: name, description, input_schema (JSON Schema), endpoints used, implementation notes, and whether it needs network access
- Output valid JSON matching the `GenerationPlan` schema

**User prompt** includes:
- The user's original prompt
- All fetched content (with source URLs labeled)
- The constructed whitelist (so the LLM knows which domains are available)

**Validation** (`validatePlan`):
- Plan must have a `tools` array with at least one entry
- Each tool must have: name, description, input_schema, implementation_notes
- Tool names must be unique
- Tool names must be valid identifiers (lowercase, underscores, no spaces)
- `endpoints_used` must reference URLs whose domains are in the whitelist (if the tool needs network)

**Retry logic:** Same as mcpblox — up to 2 attempts if the LLM returns invalid JSON or a plan that fails validation.

#### 3.5.2 Compiler (`src/engine/compiler.ts`)

**Rewrite from mcpblox.** Generates one handler function per tool.

**System prompt** instructs the LLM to write an async JavaScript function body that:
- Receives `args` (the tool call arguments) and `fetch` (a whitelisted fetch function)
- Makes HTTP calls using `fetch` to the specified API endpoints
- Parses responses
- Returns `{ content: [{ type: "text", text: "..." }] }`
- Handles errors gracefully (try/catch around fetch, meaningful error messages)

The system prompt also specifies:
- Available globals: JSON, Math, String, Number, Boolean, Array, Object, Map, Set, Date, RegExp, Promise, URL, URLSearchParams, TextEncoder, TextDecoder, fetch, console.log
- NOT available: require, import, process, fs, net, http, Buffer, setTimeout

**Per-tool user prompt** includes:
- The tool's plan entry (name, description, schema, endpoints, implementation notes)
- Relevant API documentation excerpts (the fetched content)
- The user's original prompt for context

**Validation** (`validateCode`): Same as mcpblox — use `new Function()` to check syntax. Additionally check that the code is valid as an async function body.

**For pure-computation tools** (needs_network = false), the system prompt omits `fetch` from available globals and the handler signature uses just `args`.

#### 3.5.3 Executor (`src/engine/executor.ts`)

**Adapted from mcpblox.** Simpler because there's no transform chain — just dispatch to the handler.

```typescript
interface Executor {
  execute(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  getExposedTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

function createExecutor(compiled: CompiledTools, sandbox: Sandbox): Executor;
```

`execute()` flow:
1. Look up tool by name
2. If not found → return error result
3. Call `sandbox.runHandler(tool.handler_code, args)`
4. Return the result

No fallback behavior (unlike mcpblox where a transform failure falls back to pass-through). If a handler fails, we return an error result with the error message.

**Design decision: no fallback.** In mcpblox, falling back to the upstream result makes sense because the upstream tool exists and works. In mcpboot, there's nothing to fall back to — the generated handler IS the implementation. A failed handler should surface the error so the user can refine their prompt.

#### 3.5.4 Sandbox (`src/engine/sandbox.ts`)

**Extended from mcpblox.** The key difference: we provide `fetch` (whitelisted) in the sandbox context.

mcpblox's sandbox has three methods (`runInputTransform`, `runOutputTransform`, `runOrchestration`). mcpboot needs only one:

```typescript
interface Sandbox {
  runHandler(
    code: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult>;
}
```

**Sandbox context globals:**
```typescript
const context = vm.createContext({
  // Same as mcpblox
  JSON, Math, String, Number, Boolean, Array, Object,
  Map, Set, Date, RegExp, parseInt, parseFloat,
  isNaN, isFinite, structuredClone, Promise,
  console: { log: (...args) => console.error("[sandbox]", ...args) },

  // New for mcpboot
  fetch: whitelistedFetch,     // the proxied fetch
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Headers,                      // needed for fetch response handling
  Response,                     // for instanceof checks in generated code
});
```

**Execution:**
```typescript
const wrappedCode = `(async function(args, fetch) { ${code} })(inputArgs, fetchFn)`;
const script = new vm.Script(wrappedCode);
const resultPromise = script.runInContext(context, { timeout: HANDLER_TIMEOUT_MS });
```

**Timeout:** 30 seconds (same as mcpblox orchestration timeout). External API calls may be slow.

**Design decision: inject `fetch` as a parameter vs. as a global.** We inject it as both: it's in the context globals (so `fetch("...")` works naturally in generated code) AND passed as a parameter (so the LLM can reference it explicitly). This makes generated code more natural — the LLM can write `const res = await fetch(url)` without special syntax.

### 3.6 Cache (`src/cache.ts`)

**Adapted from mcpblox.** Same structure, different key and entry types.

**Cache key:** `hash(prompt) + hash(fetchedContent)`

The content hash ensures that if the API docs change (e.g., new endpoints added), the cache is invalidated and tools are regenerated.

**Content hash construction:**
```typescript
const contentHash = hash(
  fetchedContents
    .sort((a, b) => a.url.localeCompare(b.url))
    .map(c => c.content)
    .join("\n---\n")
);
```

Sort by URL for determinism. Join with a separator. Hash the result.

**Cache entry** stores: promptHash, contentHash, plan, compiled tools, whitelist domains, creation timestamp.

**Cache directory:** `.mcpboot-cache/` (default, configurable via `--cache-dir`).

**Whitelist reconstruction from cache:** When loading from cache, the whitelist is reconstructed from the stored `whitelist_domains` array. This avoids re-fetching URLs on cached startup.

### 3.7 MCP Server (`src/server.ts`)

**Copy from mcpblox with minimal changes:**
- Change server name from `"mcpblox"` to `"mcpboot"`
- Everything else is identical: StreamableHTTP transport, ListTools handler, CallTool handler, health endpoint

### 3.8 LLM Client (`src/llm.ts`)

**Copy from mcpblox verbatim.** Same Vercel AI SDK setup, same providers, same `generate()` interface. Consider increasing `maxTokens` from 8192 to 16384 — generated handlers may be longer than transform functions since they include full API integration logic.

### 3.9 Logging (`src/log.ts`)

**Copy from mcpblox, change prefix** from `[mcpblox]` to `[mcpboot]`.

### 3.10 CLI Entry Point (`src/index.ts`)

**Adapted from mcpblox.** The orchestration logic follows the same pattern but with different steps:

```typescript
async function main() {
  const config = buildConfig(process.argv);
  setVerbose(config.verbose);

  // 1. Extract and fetch URLs
  const urls = extractUrls(config.prompt);
  log(`Found ${urls.length} URLs in prompt`);
  const { contents, whitelist } = await fetchUrls(urls);
  log(`Fetched ${contents.length} pages, whitelist: ${[...whitelist.domains].join(", ")}`);

  // 2. Check cache
  const cache = createCache(config.cache);
  const promptHash = hash(config.prompt);
  const contentHash = hash(/* sorted content */);
  const cached = cache.get(promptHash, contentHash);

  let compiled: CompiledTools;

  if (cached) {
    log("Cache hit — loading generated tools from cache");
    compiled = deserializeCompiled(cached);
    // Reconstruct whitelist from cache if URL fetching found nothing new
  } else {
    // 3. Generate plan
    const llm = createLLMClient(config.llm);
    const plan = await generatePlan(llm, config.prompt, contents, whitelist);

    if (config.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      process.exit(0);
    }

    // 4. Compile handlers
    compiled = await compilePlan(llm, plan, contents);

    // 5. Cache
    cache.set({ promptHash, contentHash, plan, compiled, whitelist });
  }

  // 6. Start server
  const sandbox = createSandbox(whitelist);
  const executor = createExecutor(compiled, sandbox);
  const server = createExposedServer(config.server, executor);
  const port = await server.start();
  log(`mcpboot listening on http://localhost:${port}/mcp`);
  log(`Serving ${executor.getExposedTools().length} tools`);

  // Shutdown handlers (same as mcpblox)
  // ...
}
```

---

## 4. Design Decisions and Tradeoffs

### 4.1 Sandbox with Network Access

**Decision:** Provide `fetch` in the vm sandbox, gated by a domain whitelist.

**Alternatives considered:**
1. **No sandbox, just eval.** Simplest, but no security boundary at all. LLM-generated code could do anything — read files, spawn processes, make arbitrary network requests. Rejected.
2. **Full sandbox, no network.** Same as mcpblox. But then generated handlers can't call APIs, which defeats the purpose. Rejected.
3. **Separate worker process.** Run generated code in a child process with network restrictions at the OS level (e.g., seccomp, sandbox profiles). Much stronger isolation but significantly more complex, platform-dependent, and slower (IPC overhead per tool call). Rejected for MVP — could be a P2 hardening option.
4. **vm with whitelisted fetch (chosen).** Pragmatic middle ground. The vm blocks filesystem/process access. The fetch proxy blocks network access to non-whitelisted domains. Not a perfect security boundary (vm escapes are theoretically possible), but good enough for a tool that runs locally under the user's own credentials.

**Tradeoff:** We accept that a sufficiently adversarial LLM output could theoretically escape the vm. This is acceptable because (a) the user controls the prompt, (b) the user reviews the plan via `--dry-run`, and (c) the tool runs locally with the user's own permissions anyway. The sandbox prevents accidental damage, not targeted attacks.

### 4.2 Whitelist Construction

**Decision:** Two-level domain discovery: prompt URLs + URLs found in fetched content.

**Alternatives considered:**
1. **Prompt URLs only.** Too restrictive. The common case is "here are the docs" → docs mention the API base URL → that URL needs to be whitelisted.
2. **Unlimited recursive following.** Could spider the entire internet starting from one docs page. Too broad, too slow, too dangerous.
3. **Let the LLM specify the whitelist.** The planner could output required domains. But this means the LLM controls the security boundary, which is backwards.
4. **Two-level (chosen).** Covers the common case (docs → API URL) without unbounded following. The whitelist is deterministic and inspectable.

### 4.3 Content Extraction (HTML → Text)

**Decision:** Simple regex-based tag stripping. No DOM parser dependency.

**Tradeoff:** Less accurate extraction. May include navigation text, footers, etc. But the LLM is robust to noise — extra context is better than missing context. Adding `cheerio` or `jsdom` would improve extraction quality but adds a dependency we might not need.

**Mitigation:** GitHub URLs get special treatment (fetch raw README), which covers the most common use case well.

### 4.4 Cache Key: Content Hash

**Decision:** Include a hash of fetched content in the cache key.

**Alternative:** Hash only the prompt. Simpler, but if the API docs change (new endpoints, changed URLs), the cached tools would be stale. By hashing the content, we automatically invalidate when docs change.

**Tradeoff:** On cold start with no cache, URLs are always fetched (even if the content hasn't changed). This is acceptable — URL fetching adds ~2-5 seconds, which is small compared to LLM generation time (~20-40 seconds).

### 4.5 No Fallback on Handler Failure

**Decision:** If a generated handler throws at runtime, return an error. No fallback.

**Rationale:** mcpblox falls back to the upstream result because the upstream tool exists and works. In mcpboot, the handler IS the entire implementation. There's nothing to fall back to. Surfacing the error helps the user debug and refine their prompt.

### 4.6 LLM maxTokens

**Decision:** Increase from 8192 (mcpblox) to 16384.

**Rationale:** mcpblox generates short transform functions (10-30 lines). mcpboot generates full API integration handlers that may include multiple fetch calls, response parsing, error handling, and data formatting (30-100 lines per tool). More output tokens are needed.

### 4.7 Handler Signature: `(args, fetch)` as async function body

**Decision:** Generated code is an async function body receiving `args` and `fetch` as parameters.

**Alternative:** Generate complete function declarations. But then the LLM may also generate imports, type annotations, or other artifacts that break in the sandbox. By generating only the function body, we constrain the output to pure logic.

This mirrors mcpblox's approach exactly (transform functions are also bare function bodies).

---

## 5. Testing Strategy

### 5.1 Unit Tests (`test/unit/`)

| File | What it tests |
|------|--------------|
| `config.test.ts` | CLI parsing: valid args, missing required flags, env var fallback, validation errors |
| `fetcher.test.ts` | URL extraction from prompt, HTML stripping, GitHub URL rewriting, timeout handling, content truncation |
| `whitelist.test.ts` | Domain extraction, subdomain matching, `allows()` logic, whitelisted fetch proxy (blocked and allowed) |
| `planner.test.ts` | JSON extraction, plan validation (valid plans, missing fields, duplicate names, invalid tool names), `buildUserPrompt` formatting |
| `compiler.test.ts` | Code extraction, code validation, `validateCode` with valid/invalid JS |
| `executor.test.ts` | Tool dispatch, unknown tool error, handler execution delegation |
| `sandbox.test.ts` | Handler execution with mocked fetch, timeout enforcement, blocked globals (require, process, fs), whitelist enforcement in sandbox |
| `cache.test.ts` | Cache hit/miss, content hash determinism, corrupt file handling, serialization round-trip |

### 5.2 Integration Tests (`test/integration/`)

| Test | What it validates |
|------|------------------|
| `hn-api.test.ts` | Full pipeline: prompt with HN API URL → plan → compile → execute `get_top_stories` against real API |
| `pure-computation.test.ts` | Prompt for utility tools (no network) → plan → compile → execute in sandbox |
| `dry-run.test.ts` | `--dry-run` outputs valid JSON plan and exits without starting server |
| `cache-roundtrip.test.ts` | First run generates + caches; second run loads from cache; results are identical |

### 5.3 Manual Tests (`test/manual/`)

Test prompts for various APIs that can be run manually to validate end-to-end behavior:
- Hacker News API
- JSONPlaceholder (fake REST API)
- Open-Meteo weather API (no auth required)
- GitHub REST API (public endpoints)

---

## 6. Task Breakdown

Tasks are ordered for sequential implementation. Each task produces a working, testable artifact.

### Phase 1: Project Scaffolding

**Task 1.1: Initialize project** ✅ DONE
- Create `package.json` with same structure as mcpblox (ESM, esbuild build, vitest test)
- Create `tsconfig.json` (ES2022 target, ESM modules, strict mode)
- Create `vitest.config.ts`
- Create `.gitignore` (node_modules, dist, .mcpboot-cache)
- Install dependencies: `@modelcontextprotocol/sdk`, `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `commander`
- Install devDependencies: `typescript`, `tsx`, `esbuild`, `vitest`, `@types/node`
- Verify: `npm run build` succeeds (empty index.ts), `npm test` runs (no tests yet)

**Task 1.2: Copy shared modules from mcpblox** ✅ DONE
- Copy `src/log.ts` → change prefix from `[mcpblox]` to `[mcpboot]`
- Copy `src/llm.ts` → increase `maxTokens` to 16384
- Copy `src/server.ts` → change server name to `"mcpboot"`
- Write ABOUTME comments for each file
- Write unit test for `log.ts` (verify prefix, verbose toggle)
- Verify: tests pass

### Phase 2: New Components

**Task 2.1: Types (`src/types.ts`)** ✅ DONE
- Define all interfaces: `Config`, `FetchedContent`, `Whitelist`, `GenerationPlan`, `PlannedTool`, `CompiledTools`, `CompiledTool`, `ToolCallResult`, `CacheEntry`, `LLMClient`
- No runtime logic — just type definitions
- Write ABOUTME comments

**Task 2.2: Config (`src/config.ts`)** ✅ DONE
- Adapt from mcpblox's `config.ts`
- Remove: `--upstream`, `--upstream-url`, `--upstream-token`, pipe config
- Keep: `--prompt`, `--prompt-file`, `--provider`, `--model`, `--api-key`, `--port`, `--cache-dir`, `--no-cache`, `--verbose`, `--dry-run`
- Require prompt (either `--prompt` or `--prompt-file`)
- Write unit tests (14 tests in `test/unit/config.test.ts`):
  - Valid config with all flags
  - `--prompt-file` reads file content
  - Missing prompt → error
  - Invalid provider → error
  - API key from env var (both providers)
  - Flag overrides env var
  - Port validation
  - --no-cache, --help

**Task 2.3: URL Fetcher (`src/fetcher.ts`)** ✅ DONE
- `extractUrls(prompt: string): string[]` — regex extraction
- `fetchUrl(url: string): Promise<FetchedContent>` — single URL fetch with timeout
- `fetchUrls(urls: string[]): Promise<FetchResult>` — parallel fetch all URLs
- GitHub URL rewriting (`github.com/:owner/:repo` → raw README)
- HTML tag stripping (remove script/style/nav/header/footer, then strip all tags)
- URL discovery within fetched content
- Content truncation (100k chars per page)
- Write unit tests:
  - URL extraction from various prompt formats
  - GitHub URL rewriting
  - HTML stripping (with script tags, nested tags, etc.)
  - URL discovery in content
  - Content truncation
- Write integration test: fetch a real URL (use a stable public page)

**Task 2.4: Whitelist (`src/whitelist.ts`)** ✅ DONE
- `buildWhitelist(promptUrls: string[], contents: FetchedContent[]): Whitelist`
- `Whitelist.allows(url: string): boolean` — domain matching with subdomain support
- `createWhitelistedFetch(whitelist: Whitelist): typeof fetch` — proxied fetch
- Write unit tests:
  - Domain extraction from URLs
  - Subdomain matching (api.example.com allowed when example.com is whitelisted)
  - Exact domain matching
  - Blocked fetch throws descriptive error
  - Allowed fetch delegates to real fetch (mock)

### Phase 3: Engine

**Task 3.1: Sandbox (`src/engine/sandbox.ts`)** ✅ DONE
- `createSandbox(whitelistedFetch: typeof fetch): Sandbox`
- `Sandbox.runHandler(code: string, args: Record<string, unknown>): Promise<ToolCallResult>`
- vm context with: JSON, Math, String, Number, Boolean, Array, Object, Map, Set, Date, RegExp, Promise, URL, URLSearchParams, TextEncoder, TextDecoder, Headers, fetch (whitelisted), console.log
- Blocked: require, import, process, fs, net, http, Buffer, setTimeout
- 30-second timeout
- Write unit tests:
  - Simple handler returns result
  - Handler can use `fetch` (mock whitelisted fetch)
  - Handler cannot access `process` → throws
  - Handler cannot access `require` → throws
  - Handler cannot access `fs` → throws
  - Timeout enforcement
  - Handler that returns invalid shape → error

**Task 3.2: Planner (`src/engine/planner.ts`)** ✅ DONE
- System prompt for tool generation planning
- `buildUserPrompt(prompt: string, contents: FetchedContent[], whitelist: Whitelist): string`
- `validatePlan(plan: GenerationPlan): void`
- `generatePlan(llm: LLMClient, prompt: string, contents: FetchedContent[], whitelist: Whitelist): Promise<GenerationPlan>`
- JSON extraction (reuse `extractJSON` from mcpblox)
- Retry logic (up to 2 attempts)
- Write unit tests:
  - `extractJSON` with fenced and unfenced JSON
  - `validatePlan` with valid plan
  - `validatePlan` with missing fields → error
  - `validatePlan` with duplicate tool names → error
  - `validatePlan` with invalid tool name format → error
  - `buildUserPrompt` includes content and whitelist

**Task 3.3: Compiler (`src/engine/compiler.ts`)** ✅ DONE
- System prompt for handler code generation
- `buildHandlerPrompt(prompt: string, tool: PlannedTool, contents: FetchedContent[]): string`
- `compilePlan(llm: LLMClient, plan: GenerationPlan, contents: FetchedContent[]): Promise<CompiledTools>`
- Code extraction (reuse `extractCode` from mcpblox)
- Code validation (async function body)
- Compile each tool's handler sequentially (one LLM call per tool)
- Write unit tests:
  - `extractCode` with fenced and unfenced code
  - `validateCode` with valid/invalid async function bodies
  - `buildHandlerPrompt` includes tool plan and relevant content

**Task 3.4: Executor (`src/engine/executor.ts`)** ✅ DONE
- `createExecutor(compiled: CompiledTools, sandbox: Sandbox): Executor`
- `execute(toolName, args)` — look up tool, run handler in sandbox
- `getExposedTools()` — return tool list for ListTools
- Write unit tests:
  - Known tool dispatches to sandbox
  - Unknown tool returns error result
  - Handler error is caught and returned as error result
  - `getExposedTools` returns all tools with schemas

### Phase 4: Cache

**Task 4.1: Cache (`src/cache.ts`)**
- Adapt from mcpblox's cache
- Change cache key from `promptHash + schemaHash` to `promptHash + contentHash`
- `hash(input: string): string` — SHA-256, first 16 hex chars (copy from mcpblox)
- `serializeCompiled` / `deserializeCompiled` for CompiledTools
- Store whitelist domains in cache entry
- Write unit tests:
  - Cache miss returns null
  - Cache set + get round-trip
  - Content hash determinism (same content → same hash)
  - Corrupt cache file → removed, returns null
  - Cache disabled → always null

### Phase 5: Integration

**Task 5.1: CLI entry point (`src/index.ts`)**
- Wire all components together: config → fetch → cache check → plan → compile → cache set → executor → server
- Dry-run mode: output plan JSON and exit
- Shutdown handlers (SIGINT, SIGTERM)
- Error handling with clear messages at each stage
- Write ABOUTME comments

**Task 5.2: Build configuration**
- esbuild script in package.json (same as mcpblox, change entry point)
- Add shebang for CLI: `#!/usr/bin/env node`
- Verify: `npm run build` produces `dist/index.js`
- Verify: `node dist/index.js --help` shows usage

**Task 5.3: End-to-end integration test**
- Test with Hacker News API prompt
- Verify: plan is generated with reasonable tools
- Verify: handlers compile and execute
- Verify: MCP server responds to ListTools and CallTool
- Verify: cache works (second run is fast)

### Phase 6: Polish

**Task 6.1: Error messages and edge cases**
- No URLs in prompt → proceed without fetching (pure computation tools)
- URL fetch failure → warn and continue with remaining URLs
- All URL fetches fail → proceed with prompt-only content
- LLM returns empty plan → clear error message
- Generated handler has syntax errors → clear error during compilation
- Empty prompt file → error

**Task 6.2: README**
- Installation instructions
- Usage examples (same as PRD Section 10)
- How it works (brief architecture description)
- Comparison with mcpblox

**Task 6.3: Manual validation**
- Test with 5+ real APIs (HN, JSONPlaceholder, Open-Meteo, etc.)
- Verify tools work when connected from a real MCP host (Claude Desktop or similar)
- Document any issues found

---

## 7. File Inventory

Final file list for MVP:

```
mcpboot/
├── src/
│   ├── index.ts              # CLI entry point, orchestrates lifecycle
│   ├── config.ts             # CLI argument parsing and validation
│   ├── types.ts              # All TypeScript type definitions
│   ├── fetcher.ts            # URL fetching and content extraction
│   ├── whitelist.ts          # Domain whitelist construction and enforcement
│   ├── server.ts             # MCP server over StreamableHTTP
│   ├── llm.ts                # Multi-provider LLM client (Vercel AI SDK)
│   ├── cache.ts              # File-backed generation cache
│   ├── log.ts                # Logging to stderr with verbose mode
│   └── engine/
│       ├── planner.ts        # LLM generates GenerationPlan from prompt + docs
│       ├── compiler.ts       # LLM generates handler code from plan
│       ├── executor.ts       # Routes tool calls to handlers
│       └── sandbox.ts        # vm sandbox with whitelisted network access
├── test/
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── fetcher.test.ts
│   │   ├── whitelist.test.ts
│   │   ├── planner.test.ts
│   │   ├── compiler.test.ts
│   │   ├── executor.test.ts
│   │   ├── sandbox.test.ts
│   │   └── cache.test.ts
│   ├── integration/
│   │   ├── hn-api.test.ts
│   │   ├── pure-computation.test.ts
│   │   ├── dry-run.test.ts
│   │   └── cache-roundtrip.test.ts
│   └── manual/
│       └── prompts/          # Test prompt files for various APIs
├── docs/
│   ├── PRD.md
│   └── DESIGN.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .gitignore
```

---

## 8. Open Questions

1. **Response format from handlers.** Should handlers always return `{ content: [{ type: "text", text: "..." }] }` with stringified JSON in the text field? Or should we support structured content types (e.g., images, embedded objects)? For MVP, text-only is sufficient. Structured content could be P1.

2. **Concurrent tool calls.** The MCP protocol allows concurrent tool calls. The current design creates a new vm context per call, which is safe for concurrency. No mutex needed since each call gets its own context.

3. **fetch Response object in vm.** Node.js `fetch` returns a `Response` object. When this object crosses the vm boundary (from real `fetch` into the sandbox context), some methods may not work. We may need to serialize the response and reconstruct it inside the sandbox, or provide a simplified response wrapper. This needs testing during Task 3.1.

4. **Content extraction quality.** If simple HTML stripping proves insufficient for important API docs sites, we may need to add `cheerio` or a similar dependency. This is a "try simple first, upgrade if needed" decision.
