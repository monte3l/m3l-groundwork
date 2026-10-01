---
"@monte3l/groundwork": patch
---

Installing the `/customize` skill no longer writes through a symlink. Presence under `.claude/skills/customize/` is now decided with `lstat`, so a project-owned entry there (a file, a directory, or a symlink, dangling or not) is never removed or overwritten: the skill goes to `.groundwork/customize/` instead, and so does a symlinked `.claude`, `.claude/skills` or `.claude/skills/customize` (the output says why). A symlinked `.groundwork` or `.groundwork/customize` still stops the install before the skill is written. `SKILL.md` is written last, and if a write fails the CLI removes the files it had already written and says how many, so a half-installed skill is never left for Claude Code to load. Errors from the install now say what happened and carry their cause.
