# mcpboot — Product Requirements Document

**Version:** 1.0
**Author:** Vivek Haldar
**Date:** 2026-02-03
**Status:** Draft

---

## 1. Executive Summary

mcpboot is a CLI tool that generates and serves an MCP server from a natural language prompt. Where mcpblox transforms an *existing* MCP server, mcpboot creates one from *nothing* — given a description of what tools to expose (and optionally a pointer to an underlying API), it uses an LLM to generate tool implementations and serves them as a fully functional MCP server.

Like mcpblox, the LLM is used only at startup for code generation. The generated code is cached and reused for all subsequent invocations. At runtime, tool calls execute pure generated JavaScript — no LLM in the loop, no API costs per call.

The name: if mcpblox lets you snap MCP blocks together, **mcpboot** lets you bootstrap one into existence.

---

## 2. Problem Statement

The MCP ecosystem has hundreds of servers, but there are still gaps:

- **No MCP server exists for many APIs.** Thousands of REST APIs, GraphQL endpoints, and web services have no MCP wrapper. Someone has to write one from scratch every time.
- **Writing an MCP server is boilerplate-heavy.** Even a simple wrapper requires understanding the MCP SDK, defining tool schemas, implementing handlers, setting up transport — all before writing the actual API integration logic.
- **API documentation is the real spec.** Most APIs already have comprehensive docs. The information needed to build an MCP server is *right there* — it just needs to be read, understood, and translated into code.

mcpboot eliminates this friction. Point it at API docs (or just describe what you want), and it generates a working MCP server. No SDK knowledge required. No boilerplate. No code to maintain.

---

## 3. Product Vision

### 3.1 Core Value Proposition

**One sentence:** mcpboot conjures a working MCP server from a natural language prompt.

### 3.2 Strategic Context

mcpblox solves the "last mile" between what an MCP server offers and what a user needs. mcpboot solves the "first mile" — getting an MCP server to exist in the first place. Together, they cover the full lifecycle: create (mcpboot) → customize (mcpblox) → use.

### 3.3 Why This Approach?

- **API docs are structured enough for LLMs.** REST API documentation (README files, OpenAPI specs, developer portals) contains endpoint URLs, parameter schemas, authentication patterns, and response formats. LLMs are excellent at reading these and generating integration code.
- **MCP tool schemas are constrained.** A tool has a name, description, input schema (JSON Schema), and a handler function. This is a small, well-defined target for code generation.
- **The runtime is simple.** Most MCP tool handlers are HTTP calls with argument mapping and response formatting. This is firmly within the capability of LLM-generated JavaScript.

---

## 4. User Personas

### 4.1 The Tinkerer
An individual developer who wants to expose an API as MCP tools without writing a dedicated server. They know the API, they just don't want to do the plumbing.

*"I use the Hacker News API all the time. I want MCP tools to fetch top stories, get comments, search — but I don't want to write and maintain a whole MCP server for it."*

### 4.2 The Prototyper
A developer exploring a new API who wants to interact with it through their AI assistant immediately. They'll refine later — right now they just want tools that work.

*"I just found this cool weather API. Let me point mcpboot at the docs and start querying it from Claude in 30 seconds."*

### 4.3 The Integrator
A developer building AI-powered workflows who needs MCP wrappers for multiple APIs. They think in terms of capabilities, not servers.

*"I need MCP tools for Stripe, SendGrid, and Twilio. I don't want to find, evaluate, and configure three separate MCP servers. Let me just point mcpboot at each API's docs."*

---

## 5. Use Cases

### 5.1 REST API Wrapping (Link to Docs)
**Prompt:** *"Create MCP tools for the Hacker News API: https://github.com/HackerNews/API"*

mcpboot fetches the API documentation, understands the available endpoints, and generates tools like `get_top_stories`, `get_item`, `get_user`, `search_stories`. Each tool's handler makes the appropriate HTTP call, maps arguments, and formats the response.

### 5.2 REST API Wrapping (OpenAPI Spec)
**Prompt:** *"Create MCP tools from this OpenAPI spec: https://petstore.swagger.io/v2/swagger.json"*

mcpboot fetches the OpenAPI/Swagger spec, extracts endpoints, and generates a tool per endpoint (or groups related endpoints into logical tools). Schemas are derived directly from the spec.

### 5.3 Curated Tool Set (with API link)
**Prompt:** *"Using the GitHub REST API (https://docs.github.com/en/rest), create tools for: listing my repos, creating issues, and searching code."*

The user specifies both the API and the specific tools they want. mcpboot reads the docs but only generates the requested subset of tools.

### 5.4 Description-Only (No API Link)
**Prompt:** *"Create an MCP tool that converts between currencies. It should accept a source currency, target currency, and amount, and return the converted value with the current exchange rate."*

No API link provided. mcpboot infers that this needs a currency exchange API, selects one (or asks the user), and generates the tool with the appropriate integration.

### 5.5 Utility Tools (No External API)
**Prompt:** *"Create MCP tools for working with JSON: pretty-print, validate against a schema, diff two JSON objects, and extract values with JSONPath."*

No external API needed. mcpboot generates pure computation tools that run entirely in the sandbox.

### 5.6 Chaining with mcpblox
```bash
# Step 1: Bootstrap an MCP server for the HN API
mcpboot --prompt "Create MCP tools for https://github.com/HackerNews/API" --port 8001

# Step 2: Transform it with mcpblox
mcpblox --upstream-url http://localhost:8001/mcp \
  --prompt "Create a 'daily_digest' tool that gets top 10 stories with their top comments" \
  --port 8002
```

mcpboot creates the base tools; mcpblox composes them into higher-level functionality.

---

## 6. Architecture

### 6.1 High-Level Architecture

```
                  ┌──────────────────────────────────────────┐
┌──────────┐      │               mcpboot                     │      ┌───────────┐
│          │      │  ┌────────┐  ┌───────────┐               │      │           │
│   MCP    │◄────►│  │Exposed │  │ Generation│  ┌──────────┐ │─────►│ External  │
│   Host   │ HTTP │  │Server  │──│ Engine    │──│URL Fetch │ │ HTTP │ APIs      │
│          │      │  └────────┘  └─────┬─────┘  └──────────┘ │      │           │
└──────────┘      │                    │                      │      └───────────┘
                  │              ┌─────▼─────┐               │
                  │              │    LLM    │               │
                  │              │ (startup  │               │
                  │              │  codegen) │               │
                  │              └───────────┘               │
                  └──────────────────────────────────────────┘
```

Key difference from mcpblox: there is no upstream MCP client. Instead, generated tool handlers make direct HTTP calls to external APIs. The "upstream" is the API itself, accessed through generated code.

### 6.2 Core Components

#### 6.2.1 URL Fetcher
Fetches and parses content from URLs provided in the prompt:
- HTML pages → extract text content (API documentation)
- JSON files → parse as structured data (OpenAPI specs, API responses)
- Markdown → parse as documentation
- GitHub URLs → fetch README and relevant files

Follows links one level deep: URLs mentioned in the prompt are fetched, and URLs found within those pages are also fetched (to capture API base URLs referenced in documentation). This forms the **URL whitelist** for runtime network access.

#### 6.2.2 Generation Engine
The core of mcpboot. Takes the prompt and fetched documentation, and produces a **generation plan** — a structured specification of what tools to create. The plan is then compiled into executable tool handlers.

Two phases (same pattern as mcpblox):
1. **Planning:** LLM generates a structured JSON plan describing each tool (name, description, schema, which API endpoints it calls)
2. **Compilation:** LLM generates JavaScript handler functions for each tool

#### 6.2.3 Exposed Server
An MCP server exposed over HTTP (StreamableHTTP transport). Serves the generated tool definitions and handles tool calls by executing the generated handler code.

Identical to mcpblox's exposed server — same MCP SDK, same transport.

#### 6.2.4 Generation Cache
Caches generated code and plans. Keyed by:
- Prompt hash
- Fetched content hash (so if the API docs change, cache is invalidated)

Same caching strategy as mcpblox.

### 6.3 Generation Plan

The generation plan is the intermediate representation between the prompt and the executable tool handlers:

```json
{
  "api_base_url": "https://hacker-news.firebaseio.com/v0",
  "url_whitelist": [
    "https://hacker-news.firebaseio.com"
  ],
  "tools": [
    {
      "name": "get_top_stories",
      "description": "Get the current top stories on Hacker News",
      "input_schema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "number",
            "description": "Maximum number of stories to return",
            "default": 10
          }
        }
      },
      "endpoints_used": ["GET /v0/topstories.json", "GET /v0/item/{id}.json"],
      "implementation_notes": "Fetch top story IDs, then fetch details for each up to limit"
    }
  ]
}
```

### 6.4 Network Security Model

Generated tool handlers need to make HTTP calls to external APIs. The sandbox allows network access, but only to whitelisted domains.

**Whitelist construction:**
1. Extract all domains from URLs explicitly mentioned in the prompt
2. Fetch those URLs, extract all domains found in the fetched content
3. The union of (1) and (2) forms the runtime whitelist

**Example:**
- Prompt contains `https://github.com/HackerNews/API`
- Fetched README contains `https://hacker-news.firebaseio.com/v0/...`
- Whitelist: `github.com`, `hacker-news.firebaseio.com`
- At runtime, generated code can only `fetch()` URLs matching these domains

This prevents LLM-generated code from making requests to arbitrary endpoints while allowing legitimate API access.

### 6.5 Data Flow

**Startup:**
1. Parse prompt, extract URLs
2. Fetch all URLs, extract content and discover linked URLs (one level)
3. Build URL whitelist
4. Check cache (keyed by prompt hash + content hash)
5. If cache miss: send prompt + fetched docs to LLM → generation plan
6. If cache miss: send plan to LLM → JavaScript handler functions
7. Cache everything
8. Start exposed MCP server

**Tool call (runtime):**
1. Host calls tool on exposed server
2. Execute generated handler in network-enabled sandbox
3. Handler makes HTTP calls to external API (whitelist enforced)
4. Handler formats response
5. Return result to host

---

## 7. Functional Requirements

### 7.1 Core Generation (P0 — MVP)

| ID | Requirement | Details |
|----|-------------|---------|
| F-1 | Prompt input | Accept a natural language prompt via CLI flag or file |
| F-2 | URL fetching | Fetch and parse URLs referenced in the prompt (HTML, JSON, Markdown) |
| F-3 | URL discovery | Follow links one level deep from fetched pages to discover API base URLs |
| F-4 | URL whitelist | Build a domain whitelist from prompt URLs + discovered URLs |
| F-5 | Generation plan | Use LLM to produce a structured generation plan from prompt + fetched docs |
| F-6 | Tool codegen | Generate JavaScript handler functions for each planned tool |
| F-7 | Network-enabled sandbox | Execute generated code with `fetch` access restricted to whitelisted domains |
| F-8 | Exposed MCP server | Serve generated tools over HTTP (StreamableHTTP) |
| F-9 | Generation cache | Cache generated code and plans, keyed by prompt hash + content hash |
| F-10 | Multi-provider LLM | Support Anthropic and OpenAI as LLM providers via Vercel AI SDK |
| F-11 | Dry run | `--dry-run` flag displays the generation plan without starting the server |

### 7.2 Enhanced Generation (P1)

| ID | Requirement | Details |
|----|-------------|---------|
| F-12 | OpenAPI spec parsing | Detect and parse OpenAPI/Swagger specs for precise endpoint discovery |
| F-13 | Authentication support | Handle API keys, Bearer tokens, and basic auth via CLI flags or env vars |
| F-14 | Tool inference | When the prompt doesn't specify tools, infer a reasonable set from the API surface |
| F-15 | Error handling in generated code | Generated handlers include retry logic and meaningful error messages |

### 7.3 Ecosystem Integration (P2)

| ID | Requirement | Details |
|----|-------------|---------|
| F-16 | Pipe compatibility with mcpblox | mcpboot's output can pipe into mcpblox for further transformation |
| F-17 | Export to standalone server | Generate a standalone MCP server project (package.json, source files) that can run independently |
| F-18 | Multiple API composition | Single prompt references multiple APIs; generated tools span all of them |

---

## 8. Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NF-1 | Startup latency (cached) | < 3 seconds from launch to serving tools |
| NF-2 | Startup latency (cold) | < 60 seconds including URL fetching + LLM generation |
| NF-3 | Tool call latency | < 50ms overhead above external API latency |
| NF-4 | Cache persistence | Survive process restarts; file-based JSON |
| NF-5 | Error resilience | If a generated handler fails, return a clear error (no silent failures) |
| NF-6 | Security | Generated code can only access whitelisted domains; no filesystem or process access |

---

## 9. Technical Design

### 9.1 Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (Node.js, ESM) | Same as mcpblox; shared architecture patterns |
| MCP SDK | `@modelcontextprotocol/sdk` | Reference implementation, StreamableHTTP transport |
| LLM | Vercel AI SDK (`ai`) | Multi-provider abstraction, structured output |
| LLM Providers | `@ai-sdk/anthropic`, `@ai-sdk/openai` | Anthropic (default) + OpenAI |
| Build | esbuild | Fast bundling, same as mcpblox |
| Test | vitest | Modern, TypeScript-native |
| CLI | commander | Lightweight CLI parsing |
| HTTP Client | Node.js native `fetch` | Available in Node 18+; no extra dependency |

### 9.2 Code Execution Strategy

mcpboot's sandbox differs from mcpblox's in one critical way: **network access is allowed, but scoped.**

Generated handler functions run in a Node.js `vm` context with:
- **Allowed:** JSON, Math, String, Number, Array, Object, Map, Set, Date, RegExp, Promise, `fetch` (proxied to enforce whitelist), URL, URLSearchParams, TextEncoder, TextDecoder
- **Blocked:** require, import, process, fs, net, http (raw), child_process, Buffer (for file I/O)
- **Timeouts:** 30 seconds per tool call (external APIs may be slow)

The `fetch` function provided to the sandbox is a proxy that:
1. Parses the target URL
2. Checks the domain against the whitelist
3. If allowed, delegates to the real `fetch`
4. If blocked, throws a descriptive error

### 9.3 Tool Handler Interface

Every generated handler follows a strict signature:

```typescript
// Handles a tool call by making API requests and returning formatted results
interface ToolHandler {
  (args: Record<string, unknown>, fetch: WhitelistedFetch): Promise<ToolResult>;
}

// fetch restricted to whitelisted domains
type WhitelistedFetch = (url: string, init?: RequestInit) => Promise<Response>;
```

### 9.4 Project Structure

```
mcpboot/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── config.ts             # CLI + env config parsing
│   ├── server.ts             # Exposed MCP server
│   ├── fetcher.ts            # URL fetching + content extraction
│   ├── whitelist.ts          # URL whitelist construction + enforcement
│   ├── engine/
│   │   ├── planner.ts        # Generation plan (LLM)
│   │   ├── compiler.ts       # Plan → executable handlers (LLM codegen)
│   │   ├── executor.ts       # Runtime handler execution
│   │   └── sandbox.ts        # vm-based sandbox with whitelisted fetch
│   ├── llm.ts                # Multi-provider LLM client
│   └── cache.ts              # Generation cache with file persistence
├── test/
├── package.json
├── tsconfig.json
└── docs/
    └── PRD.md
```

---

## 10. CLI Interface

```
mcpboot [options]

Options:
  --prompt <text>              Generation prompt (inline)
  --prompt-file <path>         Generation prompt from file

  --provider <name>            LLM provider: anthropic | openai (default: anthropic)
  --model <id>                 LLM model ID (default: provider-specific)
  --api-key <key>              LLM API key (env: ANTHROPIC_API_KEY | OPENAI_API_KEY)

  --port <number>              HTTP server port (default: 8000)
  --cache-dir <path>           Cache directory (default: .mcpboot-cache)
  --no-cache                   Disable caching, regenerate on every startup
  --verbose                    Verbose logging (structured JSON to stderr)
  --log-file <path>            Write full verbose log to file (JSON lines, untruncated)

  --dry-run                    Generate and display the generation plan without starting the server
```

### Examples

```bash
# Wrap the Hacker News API
mcpboot --prompt "Create MCP tools for the Hacker News API: https://github.com/HackerNews/API"

# Wrap an API from an OpenAPI spec
mcpboot --prompt "Create MCP tools from https://petstore.swagger.io/v2/swagger.json"

# Create specific tools from a known API
mcpboot --prompt "Using the GitHub REST API (https://docs.github.com/en/rest), \
  create tools for listing repos, creating issues, and searching code"

# Create utility tools (no external API)
mcpboot --prompt "Create tools for JSON manipulation: pretty-print, validate, diff, and JSONPath extraction"

# Complex prompt from file
mcpboot --prompt-file ./my-api-prompt.txt --port 9000

# Preview what would be generated
mcpboot --prompt "Create MCP tools for https://github.com/HackerNews/API" --dry-run
```

---

## 11. Success Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Generation success rate | > 85% of prompts produce a working server on first try | Automated test suite with diverse prompts + API targets |
| Handler correctness | > 90% of generated handlers correctly call the target API and return valid results | Integration tests against real APIs |
| Startup time (cached) | < 3s | CI benchmark |
| Tool call overhead | < 50ms above API latency | CI benchmark |
| API coverage | Successfully generates tools for 15+ popular REST APIs | Integration test suite |

---

## 12. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| LLM generates incorrect API integration code | Broken tools | Medium-High | Validation step: after codegen, make a test call to each tool and verify the response shape. `--dry-run` for user review. |
| API docs are incomplete or ambiguous | Incorrect or missing tools | Medium | Let user augment with explicit tool descriptions in the prompt. Surface warnings when docs seem incomplete. |
| Generated code makes unintended API calls | Unexpected side effects (e.g., write operations) | Medium | Default to read-only operations unless the user explicitly requests write tools. Surface the plan for review via `--dry-run`. |
| API authentication varies widely | Hard to generalize | High | Start with unauthenticated APIs and API-key auth (P0). Add Bearer token and basic auth in P1. Complex auth (OAuth) is out of scope. |
| URL whitelist is too restrictive | Legitimate API calls blocked | Low | Clear error messages when a fetch is blocked, with instructions to add the domain to the prompt. |
| URL whitelist is too permissive | Security concern | Low | Only one level of link following. User can review whitelist via `--dry-run`. |
| Fetched API docs are too large for LLM context | Truncated or missed information | Medium | Smart content extraction: prioritize endpoint definitions, schemas, and examples. Summarize long pages. |

---

## 13. MVP Scope

The MVP (v0.1) focuses on proving the core loop: **prompt + API docs → LLM codegen → working MCP server**.

**In scope for MVP:**
- F-1 through F-11 (Core Generation)
- URL fetching and content extraction
- URL whitelist construction and enforcement
- Generation plan and handler codegen
- Network-enabled sandbox with whitelisted fetch
- File-based caching
- Anthropic + OpenAI provider support
- HTTP exposed server (StreamableHTTP)
- `--dry-run` mode

**Out of scope for MVP:**
- OpenAPI spec parsing (P1) — docs are read as text, not parsed as structured specs
- Authentication support (P1) — unauthenticated APIs only
- Tool inference without explicit prompt guidance (P1)
- Pipe compatibility with mcpblox (P2)
- Export to standalone server (P2)
- Multi-API composition (P2)

### MVP Milestone Sequence

1. **M1: URL Fetch + Plan** — Fetch URLs from prompt, send to LLM, get back a structured generation plan. `--dry-run` displays it.
2. **M2: Codegen + Sandbox** — LLM generates handler functions. Execute them in a network-enabled sandbox with whitelisted fetch. First tools work end-to-end.
3. **M3: MCP Server** — Expose generated tools as an MCP server over HTTP. A real MCP host can connect and call tools.
4. **M4: Caching + Polish** — Add generation cache, error handling, CLI polish, verbose logging.

---

## 14. Future Directions

- **Pipe composition with mcpblox** — `mcpboot ... | mcpblox ...` to bootstrap and transform in one pipeline.
- **Export to standalone project** — Generate a self-contained MCP server repo (with package.json, source, README) that doesn't need mcpboot to run.
- **OpenAPI-native mode** — Detect OpenAPI specs and use structured parsing instead of LLM interpretation for precise schema extraction.
- **Authentication profiles** — Built-in support for common auth patterns (API key header, Bearer token, OAuth client credentials).
- **Multi-API composition** — A single prompt that references multiple APIs, generating tools that span all of them.
- **Community prompt library** — Shareable, versioned generation prompts for popular APIs. "The npm of MCP server bootstrapping."

---

## Appendix A: Relationship to mcpblox

mcpboot and mcpblox are complementary tools in the same family:

| | mcpblox | mcpboot |
|--|---------|---------|
| **Input** | Existing MCP server + transform prompt | Natural language prompt (+ optional API docs) |
| **Output** | Transformed MCP server | New MCP server |
| **LLM generates** | Transform functions (input/output mappers) | Tool handler functions (API integrations) |
| **Upstream** | MCP server (stdio/HTTP) | External APIs (HTTP) or none |
| **Sandbox network** | Blocked (proxies through upstream MCP client) | Allowed (whitelisted domains) |
| **Shared** | LLM client, cache, MCP server, CLI framework, plan→compile pattern | |

Architecture reuse from mcpblox:
- Two-phase LLM interaction (plan → compile)
- Cache system (file-backed, hash-keyed)
- MCP server + StreamableHTTP transport
- LLM client abstraction (Vercel AI SDK, multi-provider)
- CLI framework (commander)
- Sandbox foundation (vm module, extended with network proxy)

## Appendix B: Generation Prompt Examples

### Minimal — Point at API docs
```
Create MCP tools for the Hacker News API: https://github.com/HackerNews/API
```

### Targeted — Specific tools from a known API
```
Using the GitHub REST API (https://docs.github.com/en/rest), create these tools:
- list_repos: List repositories for the authenticated user
- create_issue: Create an issue in a specified repo
- search_code: Search for code across all public repos
```

### Descriptive — No API link
```
Create an MCP tool called "url_summarize" that takes a URL, fetches the page
content, extracts the main text, and returns a structured summary with:
- Title
- Word count
- Top 5 key phrases
- First 500 characters of body text
```

### Utility — Pure computation
```
Create MCP tools for working with timestamps:
- now: Return current UTC time in ISO 8601
- convert: Convert between timezones
- diff: Calculate duration between two timestamps
- parse: Parse a natural language date string into ISO 8601
```
