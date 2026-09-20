---
type: llm
---

This is a freshly bootstrapped project and the user asked for /customize. The skill must interview the user BEFORE changing anything.

PASS if the response asks the user (through a question tool or in plain text) about at least three of: what kind of project this is (library, CLI, frontend, service), the runtime target, whether tests are mandatory, and how deep CI should go. It must not assume those answers, and must not claim to have already modified files.

FAIL if it edits or claims to have edited files, answers its own interview questions, skips the interview to apply a generic customization, or stops without asking anything.
