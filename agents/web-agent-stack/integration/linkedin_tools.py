"""Glue: exposes the LinkedIn MCP server to a browser-use agent as plain @tools.action functions.

Neither repo is modified. Requires `uv` (for uvx) and `pip install mcp` (already a browser-use dependency).
"""
import asyncio
import json
import threading
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from browser_use import Tools

# Runs the sibling clone; swap for ["uvx", "mcp-server-linkedin@latest"] to use the published package.
LINKEDIN_SERVER = StdioServerParameters(
    command="uv",
    args=["run", "--directory", "../linkedin-mcp-server", "mcp-server-linkedin"],
)

tools = Tools()


async def _call(tool: str | None, arguments: dict[str, Any]) -> str:
    async with stdio_client(LINKEDIN_SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            if tool is None:
                listing = await session.list_tools()
                return "\n".join(f"{t.name}: {t.description}" for t in listing.tools)
            result = await session.call_tool(tool, arguments)
            return "\n".join(c.text for c in result.content if getattr(c, "text", None))


def _run(tool: str | None, arguments: dict[str, Any]) -> str:
    # Own thread + loop so this works even when the agent already runs inside an event loop.
    out: dict[str, str] = {}

    def worker() -> None:
        try:
            out["v"] = asyncio.run(_call(tool, arguments))
        except Exception as e:  # surface errors to the model instead of crashing the run
            out["v"] = f"LinkedIn MCP error: {e}"

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    return out["v"]


@tools.action("List the available LinkedIn tools (profiles, companies, jobs, messaging) and their descriptions")
def linkedin_list_tools() -> str:
    return _run(None, {})


@tools.action(
    "Call a LinkedIn MCP tool by name. Use linkedin_list_tools first to see names. "
    "arguments_json is a JSON object string, e.g. '{\"linkedin_username\": \"someone\"}'"
)
def linkedin_call(tool: str, arguments_json: str = "{}") -> str:
    return _run(tool, json.loads(arguments_json))
