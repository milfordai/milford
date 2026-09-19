# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository, choose **Security**, then **Report a vulnerability**. Include the version, what you did, and what you expected.

You can expect a first reply within a few days. Milford is at an early version and only the latest release receives fixes.

## What to keep in mind when running Milford

- Set `server.auth.tokens`. Without tokens the API is open, and the server logs a warning.
- Chat channels are deny by default and need an `allow` list. Webhooks need a secret and signed requests.
- The MCP server exposes nothing unless you list flows in `mcp.expose`. An LLM that reads untrusted text can be tricked into calling any tool it can see, so keep flows that act on real systems out of that list.
- Keep API keys in environment variables and reference them as `${NAME}` in the config file.
