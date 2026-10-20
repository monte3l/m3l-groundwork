---
"@monte3l/groundwork": patch
---

feat(baseline): scope what the baseline's skills may do. Seven core skills and six pack skills gain `allowed-tools` (read-only pre-approvals with no wildcard on `git`, and no `gh api`), `disallowed-tools` (`Write`, `Edit`, `NotebookEdit` on the three github-pack skills that only report or act through `gh`) and `argument-hint`. `allowed-tools` only skips the prompt and does not restrict, so every grant is a command that cannot write. `starting-work` also gains a read-only environment preflight that reports a Node version mismatch, a missing `node_modules` and missing git hooks, and never installs anything.
