---
paths:
  - "templates/core/**"
---

# Baseline rules (`templates/core/**`)

> This file is the terse checklist that auto-loads when you edit the
> baseline, exactly what the CLI emits into every fresh project. Its own
> `templates/core/CLAUDE.md` describes the emitted project; this file is
> about changing the template.

- **Brand-neutral.** `templates/**` ships into other people's projects, so
  no m3l-design styling, no monte3l names, and the `docs.md` rule does not
  apply here.
- **The caps bind the baseline.** At most 5 agents, 8 skills (7 in
  `templates/core/.claude/skills/`, plus `/customize`), 10 hooks, 3 CI
  workflows and 12 root scripts, and 0 gates that only check documentation
  about the repo. Adding one means removing or merging one first.
  `packages/cli/src/caps.ts` is the one place the numbers live.
- **A new file needs a domain.** Update `packages/plugin/src/domain-map.ts`
  in the same commit, or its test fails.
- **The grader twins must agree.** `bin/lib/harness-rules.mjs` and
  `bin/lib/toolchain-rules.mjs` mirror `packages/cli/src/harness/` and
  `src/toolchain/`. Change both sides together.
- **A new walker or copy step over this tree restores dotfile names**
  (`_gitignore`, `_npmrc`, `_npmignore`). `templates/core/package.json` is
  not escaped, because `caps.ts` reads it directly.
- **`pnpm test:e2e` is mandatory before calling a change done.** It has
  caught real bugs a unit-test mock hid.
- **Most hook and skill tests live in `packages/cli/tests/templates/`**
  (run them with `pnpm vitest run packages/cli/tests/templates`), but a hook
  that has a root twin is tested from `packages/cli/tests/` itself:
  `guard-hub-bash-writes`, `post-edit-verify`, `nudge-invariants` and
  `verify-steps`. Run those too when you change a twinned file.
- **Dispatch `baseline-impact-reviewer`** alongside `code-reviewer` on any
  diff that touches this tree.
