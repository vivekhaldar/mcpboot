# mcpboot

Generate and serve an MCP server from a natural language prompt.

Point mcpboot at API documentation (or just describe what you want), and it generates a working [MCP](https://modelcontextprotocol.io/) server. No SDK knowledge required. No boilerplate. No code to maintain.

The LLM is used **only at startup** for code generation. At runtime, tool calls execute cached JavaScript with no LLM involvement and no per-call API costs.

## Installation

```bash
npm install -g mcpboot
```

Requires Node.js 18+.

## Quick Start

```bash
# Set your LLM API key
export ANTHROPIC_API_KEY=sk-ant-...

# Generate an MCP server for the Hacker News API
mcpboot --prompt "Create MCP tools for the Hacker News API: https://github.com/HackerNews/API"
```

mcpboot fetches the API docs, generates tool handlers, and starts serving on `http://localhost:8000/mcp`.

## Usage

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
  --dry-run                    Show generation plan without starting server
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

# Create utility tools (no external API needed)
mcpboot --prompt "Create tools for JSON manipulation: pretty-print, validate, diff, and JSONPath extraction"

# Complex prompt from file
mcpboot --prompt-file ./my-api-prompt.txt --port 9000

# Preview what would be generated
mcpboot --prompt "Create MCP tools for https://github.com/HackerNews/API" --dry-run
```

### Walkthrough: Hacker News API

Here's a complete example of generating an MCP server for the [Hacker News API](https://github.com/HackerNews/API).

**1. Start mcpboot:**

```bash
mcpboot --model claude-haiku-4-5 --port 8100 --verbose \
  --prompt "Create MCP tools for the Hacker News API. The API docs are at
    https://github.com/HackerNews/API . Figure out what tools are appropriate
    to expose — things like getting top stories, new stories, getting an item
    by ID, getting a user profile, etc."
```

mcpboot fetches the API docs from GitHub, uses the LLM to plan and compile 10 tools, and starts serving:

```
[mcpboot] Found 1 URL(s) in prompt
[mcpboot] Fetched 1 page(s)
[mcpboot] Cache miss — generating tools via LLM
[mcpboot] Plan: 10 tool(s)
[mcpboot] Compiled 10 handler(s)
[mcpboot] Listening on http://localhost:8100/mcp
[mcpboot] Serving 10 tool(s)
```

With `--verbose`, each step also emits structured JSON events to stderr — one JSON object per line — with timestamps, request correlation IDs, and detailed payloads:

```json
{"ts":"...","event":"llm_call_start","req_id":"startup","call_id":1,"provider":"anthropic","model":"claude-haiku-4-5",...}
{"ts":"...","event":"llm_call_end","req_id":"startup","call_id":1,"elapsed_ms":2100,"prompt_tokens":1240,"completion_tokens":892,...}
```

Use `--log-file mcpboot.log` to capture the full untruncated output (stderr truncates long strings to 500 chars).

**2. Test with the MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector --transport http --server-url http://localhost:8100/mcp
```

Or test from the CLI with [mcporter](https://github.com/steipete/mcporter):

```bash
# List all generated tools
npx mcporter list http://localhost:8100/mcp --schema --allow-http

# Get the top 5 stories (returns story IDs)
npx mcporter call 'http://localhost:8100/mcp.get_top_stories' limit=5 --allow-http

# Fetch details for a story
npx mcporter call 'http://localhost:8100/mcp.get_item_by_id' item_id=42345678 --allow-http

# Look up a user profile
npx mcporter call 'http://localhost:8100/mcp.get_user_profile' username=dang --allow-http
```

**Generated tools:** `get_top_stories`, `get_new_stories`, `get_best_stories`, `get_ask_stories`, `get_show_stories`, `get_job_stories`, `get_item_by_id`, `get_user_profile`, `get_max_item_id`, `get_recent_changes`

Subsequent runs with the same prompt skip the LLM entirely and start instantly from cache.

### Connecting from an MCP Host

Once mcpboot is running, connect any MCP-compatible host to `http://localhost:8000/mcp`. For example, in Claude Desktop's config:

```json
{
  "mcpServers": {
    "my-api": {
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

## How It Works

mcpboot follows a two-phase startup, then serves tools at runtime:

**Startup (LLM-assisted):**

1. **Fetch** — Extract URLs from the prompt, fetch their content (API docs, READMEs, OpenAPI specs), and build a domain whitelist for runtime network access.
2. **Plan** — Send the prompt and fetched docs to the LLM, which produces a structured generation plan: what tools to create, their schemas, which API endpoints they use.
3. **Compile** — Send each planned tool back to the LLM, which generates a JavaScript handler function that calls the API, parses responses, and formats results.
4. **Cache** — Store the plan and compiled handlers on disk, keyed by prompt hash + content hash. Subsequent startups with the same prompt and unchanged docs skip the LLM entirely.

**Runtime (no LLM):**

5. **Serve** — Expose the generated tools as an MCP server over StreamableHTTP. Tool calls execute the cached JavaScript handlers in a sandboxed `vm` with fetch access restricted to whitelisted domains.

```
Prompt + API Docs
       │
       ▼
  URL Fetcher ──► Planner (LLM) ──► Compiler (LLM) ──► Cache
                                                          │
                                                          ▼
  MCP Host ◄──► Exposed Server ◄──► Executor ◄──► Sandbox (vm + fetch)
                                                          │
                                                          ▼
                                                    External APIs
```

### Security Model

Generated handlers run in a Node.js `vm` sandbox with:

- **Allowed:** Standard JS globals, `fetch` (whitelisted domains only), URL, URLSearchParams
- **Blocked:** `require`, `import`, `process`, `fs`, `net`, `child_process`
- **Timeout:** 30 seconds per tool call

The domain whitelist is constructed automatically from URLs in the prompt and URLs discovered in the fetched documentation.

## Comparison with mcpblox

mcpboot and [mcpblox](https://github.com/vivekhaldar/mcpblox) are complementary:

| | mcpblox | mcpboot |
|--|---------|---------|
| **Input** | Existing MCP server + transform prompt | Natural language prompt + optional API docs |
| **Output** | Transformed MCP server | New MCP server from scratch |
| **LLM generates** | Transform functions (input/output mappers) | Tool handler functions (full API integrations) |
| **Use case** | Customize an existing server | Create a server that doesn't exist yet |

They can be chained: use mcpboot to bootstrap a server, then mcpblox to transform it.

```bash
# Bootstrap an MCP server for the HN API
mcpboot --prompt "Create MCP tools for https://github.com/HackerNews/API" --port 8001

# Transform it with mcpblox to add higher-level tools
mcpblox --upstream-url http://localhost:8001/mcp \
  --prompt "Create a 'daily_digest' tool that gets top 10 stories with their top comments" \
  --port 8002
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Run from source
npx tsx src/index.ts --prompt "..."
```

## License

Apache-2.0
