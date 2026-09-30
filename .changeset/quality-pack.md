---
"@monte3l/groundwork": patch
---

Splits the `harness-extras` pack in two. The `type-design-analyzer` review agent and the `check-file-budget` per-file size ratchet (a `build`-group verify step) move into a new `quality` pack, which is adopt-capable and recommended for every project kind. `harness-extras` keeps what is really session ergonomics: the compaction-handoff hooks, `guard-readonly-bash`, and the statusLine. `harness-extras` now requires only `bin/lib/agent-roster.mjs` and `quality` only `bin/lib/report.mjs`, so each pack asks only for what it uses. A project that already installed `harness-extras` keeps its files; a new `--pack harness-extras` no longer installs the agent or the gate, so add `--pack quality` for those. Nothing in the baseline's `CLAUDE.md` dispatches the agent by name, so it is used on request or after a project adds it to its own review step.
