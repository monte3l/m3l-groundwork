---
name: grade-own-harness
description: >-
  Grades THIS repo's own root .claude/ harness (agents, hooks, skills,
  rules, settings.json -- not templates/core's) with the same rule module
  templates/core/bin/check-harness.mjs uses to grade the emitted baseline.
  Use for /grade-own-harness, after adding, removing, or editing any file
  under this repo's root .claude/, or as part of the Definition of Done
  when CLAUDE.md's own harness changed. There is no package.json script
  for this in the emitted baseline (the root `check:harness` script grades
  `templates/core`) -- this skill is the entry point for grading this repo's
  own harness.
---

# grade-own-harness

`templates/core`'s `bin/check-harness.mjs` grades **the baseline it
emits**. Nothing grades **this repo's own** root `.claude/` the same way.
CLAUDE.md's "Definition of Done" section points here rather than embedding
the command inline -- this skill is the one place the snippet lives, so it
can't drift out of sync with a second copy.

## What it does

Runs the same rule module the emitted baseline's gate imports
(`templates/core/bin/lib/harness-rules.mjs`), pointed at this repo's root
instead of at `templates/core`:

```sh
node -e '
import("./bin/lib/report.mjs").then(async (report) => {
  const rules = await import("./templates/core/bin/lib/harness-rules.mjs");
  const reporter = report.createReporter(false);
  const root = process.cwd();
  rules.reportGrade(rules.gradeHarness(root), reporter);
  rules.reportOfficialValidation(root, reporter);
  reporter.finish();
});
'
```

Run it from the repo root. It reports:

- **Structural checks** — hook wiring, frontmatter shape, path-glob
  validity, `disallowedTools`/tool-grant sanity. A structural failure is a
  real defect; expect **0** (this repo's `.claude/` was installed by
  self-adopting `templates/core`, and CLAUDE.md's "Known gaps" states 0
  structural findings is the standing expectation).
- **Rubric checks** — softer, Anthropic-guidance-shaped recommendations.
  These only warn; a rubric score below 100% is not on its own a defect,
  but a dropping trend across runs is worth investigating with
  `harness-guidance`'s `refresh` mode.
- **Official plugin validation**, if the `claude` CLI is installed; skips
  cleanly with a note otherwise.

## When to run it

- After adding, removing, or editing any file under this repo's root
  `.claude/agents/`, `.claude/hooks/`, `.claude/skills/`, `.claude/rules/`,
  or `.claude/settings.json`.
- As the harness half of "Definition of Done" for such a change, alongside
  `pnpm verify`.

## Reading the result

- Any **structural** finding is a Must-fix before the change is done --
  treat it the same way `check:harness` blocks `pnpm verify` for
  `templates/core`.
- A **rubric warning** is advisory. If it names a specific file or rule
  this repo doesn't intend to fix (e.g. a path-glob rule that legitimately
  matches nothing yet), note it rather than chasing it -- the rubric is
  guidance, not a gate, for this repo's own harness the same way it is for
  the emitted one.

## Boundaries

This skill only grades. It never edits `.claude/` itself -- route a
structural fix through the hub the normal way (this is root-level
`.claude/` config, not `packages/*/src/`, so no branch-isolation or
hub-src-write guard applies to it). For a full guidance sweep against
current Anthropic recommendations (not just internal consistency), use
`harness-guidance`'s `refresh` mode instead -- this skill only proves the
harness is internally well-formed, never that it's still current.
