---
"@monte3l/groundwork": patch
---

`/customize` now also recommends which locally-installed, built-in `claude-plugins-official` marketplace plugin(s) to enable, using a new `plugin-map.ts` module (same "infer once, visibly, with reasoning attached" pattern as the existing `pack-map.ts`) that the CLI ships as part of the skill's payload alongside `kind-facet-map.ts`, `domain-map.ts` and `pack-map.ts`.

The harness grader also gains a new rubric rule, `agent-mcp-source`: an agent whose `mcpServers` frontmatter names a server that no `enabledPlugins` entry or `.mcp.json` actually supplies is now flagged as a warning (never a structural failure) instead of silently doing nothing -- exactly the gap the baseline's own `code-implementer` agent has (`mcpServers: [context7]`) until a project enables the `context7` plugin.
