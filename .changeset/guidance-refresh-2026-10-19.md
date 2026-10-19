---
"@monte3l/groundwork": patch
---

Refresh the emitted baseline and packs against current Claude Code and TypeScript guidance. `templates/core/CLAUDE.md` is trimmed under the 200-line startup-warning target (the guard detail moved to `agent-dispatch.md`), the skill-description grader message now states the real limits, `guard-worktree-only` fails closed (`onFailure: "block"`), the `github` pack's `claude-code-action` pin moves to v1.0.253, and a few config comments (`consistent-type-imports`, Vitest coverage, attw) are corrected. A project that already installed the `worktrees` pack should add `"onFailure": "block"` to its `guard-worktree-only.mjs` registration by hand, unless `/customize` installs the pack again, which now adds the missing key.
