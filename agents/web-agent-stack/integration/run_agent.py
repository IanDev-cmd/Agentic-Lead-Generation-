"""Example: a browser-use agent that can also call the LinkedIn MCP server.

Setup (from the workspace root):
  1. uv sync --directory linkedin-mcp-server          # LinkedIn server deps
  2. uv sync --directory browser-use                  # browser-use deps
  3. cp integration/.env.example integration/.env     # add your key
  4. First run opens a LinkedIn login window; the session is stored in ~/.linkedin-mcp
Run:  cd integration && uv run --directory ../browser-use python ../integration/run_agent.py "your task"
"""
import sys

from browser_use import Agent, Browser, ChatAnthropic

from lead_task import build_task
from linkedin_tools import tools

args = [arg for arg in sys.argv[1:] if arg != "--social"]
channel = "social" if "--social" in sys.argv else "linkedin"
topic = " ".join(args).strip() or "edtech"
task = topic if len(topic.split()) > 8 else build_task(topic, channel)

agent = Agent(
    task,
    llm=ChatAnthropic("claude-sonnet-5-5"),
    browser=Browser("chromium"),
    tools=tools,
)
result = agent.run_sync()
print(result.final_result())
