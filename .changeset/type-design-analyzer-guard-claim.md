---
"@monte3l/groundwork": patch
---

pack(quality): the `type-design-analyzer` agent no longer says the read-only Bash guard blocks every shell write route, since the guard is an allowlist that still does not inspect a script file run through `node` or a package script. A project that already installed the `quality` pack keeps its copy of the agent untouched.
