---
"@monte3l/groundwork": patch
---

Adopt mode now recognises a Claude Code plugin repository. The inventory moves to schema 6 and records `survey.harness.pluginLayout` (the `.claude-plugin/plugin.json` manifest and which of `hooks/hooks.json`, `skills/`, `agents/`, `commands/` and `.mcp.json` exist). The adoption report no longer prints "0 of 0 checks pass" or "100% over 0 checks" when nothing was gradable, says plugin components at the repository root are outside the harness grader's scope, and leaves fresh-only packs (`publishing`) out of the post-merge cap estimate. `/customize` gains a `plugin` project kind, recommends `plugin-dev` for it, names `.claude/` files by full path in `CLAUDE.md`, and grades the harness after Round 2.
