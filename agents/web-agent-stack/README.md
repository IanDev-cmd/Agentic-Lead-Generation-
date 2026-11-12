# web-agent-stack

Two independent open-source projects side by side, plus a thin glue layer. Nothing inside the clones was edited.

```
web-agent-stack/
├── browser-use/            # clone of browser-use/browser-use (MIT) – general web agent
├── linkedin-mcp-server/    # clone of stickerdaniel/linkedin-mcp-server (Apache-2.0) – LinkedIn MCP tools
└── integration/            # the only new code
    ├── linkedin_tools.py   # wraps the LinkedIn MCP server as browser-use @tools.action functions
    ├── run_agent.py        # example agent using both
    └── .env.example
```

Use either project alone from its own folder (see each README), or run `integration/run_agent.py` to combine them.
The .git folders were removed so this can be a single repo; re-clone to get history or updates.

Notes
- browser-use 1.0.x replaced the 0.x `Controller`/`MCPClient` API. MCP servers are now called from plain `@tools.action` functions, which is what `linkedin_tools.py` does.
- Versions at clone time: browser-use 1.0.3, linkedin-mcp-server 4.29.0 (needs Python >= 3.12.4).
- LinkedIn restricts accounts that automate heavily. Keep usage low-volume and read-focused.
