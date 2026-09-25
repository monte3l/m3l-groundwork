---
"@monte3l/groundwork": patch
---

`templates/core/CLAUDE.md` and `templates/core/.claude/rules/agent-dispatch.md` -- content the CLI emits into every bootstrapped project -- now document that a Claude Code Enterprise/managed-settings deployment can silently disable hub-and-spoke enforcement (`allowManagedHooksOnly`/`allowManagedPermissionRulesOnly`), and point at `/status` to confirm the guard hooks are actually active. This shipped in this repo's own `CLAUDE.md` and `.claude/rules/agent-dispatch.md` without a changeset; this records the same change for the emitted baseline.
