---
"@monte3l/groundwork": patch
---

Consolidates `templates/packs/` from three packs down to two, each covering one theme instead of one theme per artifact, and hardens `loadPack`'s manifest validation:

- The `statusline` pack is folded into `harness-extras` (both are Claude Code session ergonomics): its three scripts and top-level `statusLine`/`subagentStatusLine` settings now install as part of `--pack harness-extras`. `--pack statusline` is no longer accepted.
- The `claude-action` pack is renamed to `github` (GitHub-hosted collaboration is its actual theme, and it's the natural home for a planned follow-up of GitHub-repository-maintenance skills). `--pack claude-action` is no longer accepted -- use `--pack github`.
- In adopt mode, a project that already defines a top-level `statusLine`/`subagentStatusLine` no longer blocks the whole `harness-extras` install: `/customize`'s Step 3 now skips just those two settings keys and the three statusline scripts, installing the pack's other artifacts (the compaction-handoff hooks, `guard-readonly-bash`, the type-design-analyzer agent, the file-budget gate) normally.
- `loadPack` now rejects a manifest with a `modes` value other than `fresh`/`adopt`, a `wiring.settings`/`wiring.packageScripts` that isn't present as an object, a `wiring.verifySteps` that isn't present as an array, and a `verifySteps[]` entry whose `group` isn't one of the five known verify groups or whose `id`/`name`/`cmd` aren't well-formed -- each with a clear error naming the offending value, instead of loading successfully and later crashing `installPack`/`observeWiring` with an anonymous `TypeError`.
