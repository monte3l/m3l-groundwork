---
"@monte3l/groundwork": patch
---

Fixes several accuracy bugs in adopt mode's harness and toolchain grading (`.groundwork/adoption-report.md`'s "Harness grade" and "Toolchain grade" sections, and the inventory's `harnessGrade`/`toolchainGrade`):

- The toolchain grader no longer misreads a single-quoted string in `eslint.config.js`/`vitest.config.ts`/`bin/lib/verify-steps.mjs` as opening a comment, which previously corrupted everything after it and produced spurious rubric findings.
- `gate-lane-parity` no longer silently skips judgment of an entire CI/lefthook surface because of a quoted `--group`/`--step` value, a shell line-continuation splitting one invocation across two lines, or an unrelated `echo`/`name:` field elsewhere on the same line.
- The harness grader's `hook-entrypoint` rule now also flags a hook comparing `realpathSync(process.argv[1])` to `new URL(import.meta.url).pathname` -- a form that looks correct but never compares equal at runtime, so the hook fails open just like the two forms already caught.
- A malformed `.claude/settings.local.json` is no longer silently treated as absent: a new `settings-local-parses` finding reports it, and `hook-dangling`/`hook-orphan` now skip judgment (rather than misreporting) while it can't be read.
