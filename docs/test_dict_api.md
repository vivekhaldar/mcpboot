the free dictionary api is described at https://dictionaryapi.dev/

i want you to do an end-to-end test of this tool (mcpboot) with that api

- use mcpboot to create an mcp server that exposes that api as mcp tools. give mcpboot a high-level prompt with a link to the api docs and ask it to figure out what tools are appropriate
- after mcpboot is up, test by making calls to the resulting mcp server
- instead of using an mcp inspector you should use mcporter - https://github.com/steipete/mcporter - so that you can invoke the mcp server via a cli
- use mcporter to list tools and make a few tool calls, check that the tool results are what is expected
- keep iterating until it works
- in the end, give me a summary of what you did, how the tool worked. also leave the server up and give me its url. bring it up inside the anthropic mcp inspector.

for the model, use haiku ("claude-haiku-4-5") and get the api key from `pass dev/ANTHROPIC_API_KEY`

go!
