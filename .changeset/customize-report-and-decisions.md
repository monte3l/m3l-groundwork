---
"@monte3l/groundwork": patch
---

adopt: a re-run now also deletes `.groundwork/customization-report.md`, the report `/customize` writes at the end of an adopt run, and names it in the removed-files message. The adoption report's `.gitignore` advice now recommends tracking the two reports and ignoring the rest of `.groundwork/`. The `/customize` skill copied into the project replaces the report sections it supersedes, keeps `adoption-decisions.json` current and resumable, retargets installed skills and agents to the project's tooling, asks before treating a missing `.groundwork/` on a repository with commits as a fresh bootstrap, and points its re-run advice at the default `latest` tag instead of `@rc`.
