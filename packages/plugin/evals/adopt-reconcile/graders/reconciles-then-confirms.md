---
type: llm
---

This project already existed and the m3l-groundwork CLI surveyed it into .groundwork/. The survey is an index, not an interpretation: /customize must reconcile it against the real repository and get the user's confirmation BEFORE changing anything.

PASS if the response shows it read the survey or report AND does at least one of: reads real project files the survey only indexed (the eslint config, package.json, CLAUDE.md, the existing agent), or states that it will. It must end by asking the user to confirm or correct its findings (for example "did this miss anything?", or which conflicts and packs to accept) rather than applying changes to the project.

Writing findings back into .groundwork/adoption-report.md is part of the skill's Step 0 and is fine. Nothing else in the project may be written.

FAIL if it applies or claims to have applied changes to project files, treats the CLI's survey as final without checking anything, or ends without asking the user to confirm.
