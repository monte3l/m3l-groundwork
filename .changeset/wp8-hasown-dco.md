---
"@monte3l/groundwork": patch
---

The toolchain grade and the adopt survey no longer treat inherited object members (such as `constructor` or `toString`) as present scripts or `package.json` fields. The emitted `bin/lint-commit.mjs` now also enforces a configured `trailer-exists` rule (severity 2) on every message commitlint's default ignores skip (merge, revert, `fixup!`, `squash!`, `amend!`, semver release subjects); projects that do not enable that rule see no change.
