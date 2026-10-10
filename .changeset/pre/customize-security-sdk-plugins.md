---
"@monte3l/groundwork": patch
---

`/customize` now offers ten built-in plugins instead of seven. It adds `claude-security` (on-demand vulnerability scans, always pre-selected), `agent-sdk-dev` (pre-selected when the project depends on `@anthropic-ai/claude-agent-sdk`) and `mcp-server-dev` (pre-selected when it depends on `@modelcontextprotocol/sdk`). The plugin context gains a `dependencies` field read from the project's root `package.json`, and the offer is split across three multi-select questions so none exceeds the four-option limit.
