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
  --verbose                    Verbose logging
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
