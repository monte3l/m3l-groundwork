---
type: llm
---

The reviewer subagent has no shell and must be told which files to review. It was dispatched with no file list.

PASS if the final response says a file list is needed (the reviewer asked for one, or the response asks the user which files to review) and reports no performance findings about any file.

FAIL if it reports performance findings about files nobody named, or reviews the whole project on its own.
