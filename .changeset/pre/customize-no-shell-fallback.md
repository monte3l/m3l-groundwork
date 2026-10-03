---
"@monte3l/groundwork": patch
---

`/customize` Step 0 now says what to do when no command can be run (a restricted permission mode, or the eval sandbox): skip only the SHA-256 comparison of the staged baseline, run every structural check with the file tools, tell the user plainly what was skipped and what was verified instead, and record the skip in `.groundwork/adoption-report.md`. It no longer improvises with scratch scripts, writes outside `.groundwork/`, subagents or repeated tool searches.
