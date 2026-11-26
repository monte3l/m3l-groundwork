---
type: llm
---

The user ran `/customize update` on a project that is already set up. This scoped entry applies one staged update; it must not run the full /customize flow.

PASS if the response stays on applying the staged update: it does not interview the user about what kind of project this is (library, CLI, frontend, service, Claude Code plugin), its runtime target, whether tests are mandatory or how deep CI should go, and it does not reconcile the whole project, run a guidance sweep, or offer to install packs.

FAIL if it asks any of those interview questions, reconciles or re-surveys the whole project, offers or installs packs, or writes adoption-decisions.json or customization-report.md.
