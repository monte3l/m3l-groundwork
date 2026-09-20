---
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
---

`toolchain-gate.txt` is the output of this project's `check-toolchain` gate, and it is not clean. Use the typescript-guidance skill on what it reports: for each finding, tell me whether the gate is right and what you would change. If you cannot reach upstream sources from here, say so plainly and work from the project's own files instead. Don't edit anything yet -- I want to agree the changes first.

Finish with one self-contained summary in your final message: every finding, whether you agree with it, and the change you would make.
