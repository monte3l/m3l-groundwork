---
"@monte3l/groundwork": patch
---

Installing the `/customize` skill now refuses to write through a symlink. An adopted project that ships `.claude`, `.claude/skills`, `.claude/skills/customize`, `.groundwork` or `.groundwork/customize` as a symlink makes the CLI stop before it writes anything, and a symlinked skill file is removed and replaced with a regular file instead of being written through.
