"""Optional read-only hook. The desk does not call this unless USE_BROWSER_AGENT=true.

It does not log in, submit a form, or store credentials. linkedin-mcp-server is not imported.
A missing browser stack must print an empty list so the desk keeps the HTTP evidence path.
"""

print("[]")
