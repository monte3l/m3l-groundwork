---
"@monte3l/groundwork": patch
---

pack(statusline): the Claude Code status line (`statusLine`, `subagentStatusLine` and their three scripts) moves out of the `harness-extras` pack into a new `statusline` pack, so a project that already has its own status line can take the compaction-handoff hooks and the read-only Bash guard without a settings collision. `--pack harness-extras` no longer plants either settings key; pass `--pack harness-extras --pack statusline` for the previous set. `statusline` is a live pack name again, so `--pack statusline` installs it instead of printing a rename hint to `harness-extras`. A project that already installed `harness-extras` keeps its files and settings untouched.
