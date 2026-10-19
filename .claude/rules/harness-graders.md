---
paths:
  - "packages/cli/src/harness/**"
  - "packages/cli/src/toolchain/**"
  - "templates/core/bin/lib/harness-rules.mjs"
  - "templates/core/bin/lib/toolchain-rules.mjs"
  - "templates/core/bin/lib/frontmatter.mjs"
  - "bin/check-harness.mjs"
  - "bin/check-toolchain.mjs"
---

# Harness and toolchain grader rules (two implementations that must not drift)

> Moved verbatim from the root `CLAUDE.md` ("Architecture notes") so it loads only when you edit the files it governs.

- **The harness grader has two implementations that must not drift.**
  `packages/cli/src/harness/` (TypeScript: `frontmatter.ts`, `rules.ts`,
  `grade.ts`) feeds adopt mode's `## Harness grade` report section and the
  inventory's `harnessGrade`; `templates/core/bin/lib/{frontmatter,harness-rules}.mjs`
  plus `bin/check-harness.mjs` is the emitted ESM twin every bootstrapped
  project runs as a `pnpm verify` step. `tests/harness/harness-parity.test.ts`
  runs both over the real baseline and a deliberately broken harness and
  asserts identical grades -- change a rule in one, change the other in the
  same commit or that test fails. The gate is a `CORE_STEPS` entry
  (`cmd: ["node", "bin/check-harness.mjs"]`) with **no** `package.json`
  script, which is how it costs zero cap budget in a baseline already at
  every cap. Structural rules fail; rubric rules only warn, and
  `CURRENT_MODELS` in `rules.ts` needs bumping when the model lineup moves.
  The root `bin/check-harness.mjs` imports the emitted rule module directly
  rather than a copy, so this repo grades `templates/core` with exactly what
  ships.
- **The toolchain grader has the same two-implementations shape, for the same
  reason, and the same rule.** `packages/cli/src/toolchain/{rules,grade}.ts`
  feeds adopt mode's `## Toolchain grade` report section and the inventory's
  `toolchainGrade` (`schemaVersion` 4);
  `templates/core/bin/lib/toolchain-rules.mjs` plus `bin/check-toolchain.mjs` is
  the emitted twin every bootstrapped project runs as a `pnpm verify` step, and
  the root `bin/check-toolchain.mjs` imports that emitted module rather than a
  third copy. `tests/toolchain/toolchain-parity.test.ts` runs both over the real
  baseline, an empty directory and broken projects, and asserts identical grades
  -- change a rule in one, change the other in the same commit. Like the harness
  gate it is a `CORE_STEPS` entry with **no** `package.json` script, so it costs
  zero cap budget. It grades a **rubric**, not a diff against `templates/core`:
  the baseline is expected to score zero structural findings and 100% rubric
  (asserted by a test), and a project's deviation is reported against the rule.
  Three properties are load-bearing. **Absence is never a defect**: a rule whose
  subject does not exist (no `vitest.config.ts`, no verify steps) returns
  `{ checked: 0 }`, because adopt mode runs it against arbitrary projects.
  **It never executes project code**: `eslint.config.js`, `vitest.config.ts` and
  `verify-steps.mjs` are read by regex over comment-stripped source, and a scrape
  that cannot tell the answer returns `{ checked: 0 }` rather than a failure. And
  **it does not restate what `tsc` or ESLint already reject** -- a structural rule
  that only fires once `tsc` has failed adds nothing, which is why removed
  options are a rubric warning about the _next_ major
  (`tsconfig-option-lifecycle`), not a gate. For the same reason it keeps no
  table of "current" package majors: whether a pin has fallen behind upstream is
  `typescript-guidance`'s question, answered by a live sweep, and a closed-loop
  gate restating it would go stale silently. The
  tsconfig `extends` resolver (`toolchain/tsconfig-chain.ts`) is shared with
  `survey-toolchain.ts`, so the survey's `effectiveFlags` and the grade cannot
  disagree.
