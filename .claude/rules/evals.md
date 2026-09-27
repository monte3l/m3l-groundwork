---
paths:
  - "evals/**"
  - "packages/plugin/evals/**"
  - "bin/eval.mjs"
  - "bin/lib/eval-lib.mjs"
  - "bin/make-harness-plugin.mjs"
---

# Behavioural eval rules (`pnpm eval`, `evals/**`)

> This file is the terse checklist that auto-loads when you touch this
> repo's `claude plugin eval` suites. See CLAUDE.md's "Commands" for how
> `pnpm eval` fits alongside `pnpm verify`.

**Behavioural evals (`pnpm eval`, `bin/eval.mjs`) are a separate, paid layer
from `check:harness`** and are deliberately not in `pnpm verify` or
`pre-push`: they make real model calls. Three suites, all driven by
`claude plugin eval`.

The third, `toolchain`, runs `typescript-guidance` against a bootstrapped
project degraded only in ways `tsc` and ESLint cannot see
(`evals/core-toolchain/toolchain-repair/`): the fixture captures the gate's
output to `toolchain-gate.txt`, so the case needs no shell tool in the
sandbox, and graders check the skill names the findings, edits nothing, and
holds the floor rather than silencing the gate. The eval sandbox has **no
web tools**, so the case cannot measure upstream research; it measures use
of the gate's findings and honesty about that limit (a claim about upstream
it could not have fetched fails). The judge reads only the final message,
hence the prompt's request for one self-contained summary. Its `fixture.sh`
is a template -- it uses `__M3L_CLI__`, substituted by `writeToolchainPlugin`
when the case is copied.

`packages/plugin/evals/` grades `/customize` itself (`fresh-interview`,
`adopt-reconcile`); each case's `fixture.sh` runs this repo's own **built**
CLI to make a genuine fresh/adopted project, so `pnpm eval` runs `pnpm build`
first.

`evals/core-harness/triggers.json` is a `{skill, query, should_trigger}`
corpus that `bin/lib/eval-lib.mjs` turns into a throwaway plugin wrapping
`templates/core`'s skills plus one case per entry (`bin/make-harness-plugin.mjs`
is the standalone entry point for inspecting or iterating on that generated
plugin without spending anything); `eval-lib.test.ts` fails if a baseline
skill ships without a positive and a negative entry.

The interview is graded by an `llm` rubric rather than a
`tool_used: AskUserQuestion` grader because that tool is not available in
the eval sandbox (Claude falls back to plain-text questions). Under
`--ablation with-without` a `tool_used: Skill` grader stops counting toward
the score, so the suites default to `--ablation none`. **`--check` ratchets
against `evals/baseline.json` and `--update` rewrites it -- record it at
`--runs 3` or more, because a one-run baseline flakes.**
