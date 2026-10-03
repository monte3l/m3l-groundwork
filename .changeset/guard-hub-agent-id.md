---
"@monte3l/groundwork": patch
---

Closes a hub-and-spoke bypass in the emitted `guard-hub-src-writes.mjs`. Claude Code sends `agent_type` both inside a subagent and in a main session started with `--agent <name>`, but `agent_id` only inside a subagent, so a hub launched as `claude --agent code-implementer` was treated as a writer spoke and could write `src/` and `tests/` directly. A call now counts as a writer spoke only when `agent_type` names one and `agent_id` is a non-empty string. The baseline's `CLAUDE.md` also notes that an installed Claude Code mod can override a project `PreToolUse` guard.
