#!/bin/sh
# A genuinely fresh bootstrap (this repo's own built CLI), then a toolchain
# degraded ONLY in ways tsc and ESLint cannot see -- so the grader is the one
# thing that notices, which is the gap `check-toolchain` exists to close. The
# gate's output is captured to toolchain-gate.txt so the case does not depend
# on a shell tool being available in the eval sandbox.
#
# __M3L_CLI__ is replaced with the absolute path of the built CLI when
# bin/lib/eval-lib.mjs's writeToolchainPlugin copies this case; this file is a
# template and is not runnable in place. Every edit below asserts it matched,
# so a baseline that drifts fails loudly instead of quietly testing nothing.
set -eu
CLI="__M3L_CLI__"
node "$CLI" . --name eval-toolchain-project --skip-install >/dev/null
rm -rf .claude/skills/customize

node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const edit = (file, from, to) => {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${file}: expected to find ${from}`);
  writeFileSync(file, text.replace(from, to));
};
// Two strict flags dropped: rubric findings, invisible to tsc.
edit("tsconfig.base.json", "    \"noUncheckedIndexedAccess\": true,\n", "");
edit("tsconfig.base.json", "    \"exactOptionalPropertyTypes\": true,\n", "");
// Untyped ESLint preset: still lints, just without type information.
edit("eslint.config.js", "recommendedTypeChecked", "recommended");
// Coverage no longer per-file: one covered file hides an untested one. The
// line is REMOVED rather than set false -- an explicit false beside the
// baseline comment about a "scaffold-appropriate starting floor" reads as deliberate,
// which is not the silent regression this case models.
edit("vitest.config.ts", "        perFile: true,\n", "");
// Node pin contradicts engines.node (>=24): structural, invisible to check-node-version.
writeFileSync(".node-version", "22\n");
// A verify step naming a script package.json does not have: structural.
edit("bin/lib/verify-steps.mjs", "[\"pnpm\", \"build\"]", "[\"pnpm\", \"compile\"]");
'

node bin/check-toolchain.mjs > toolchain-gate.txt 2>&1 || true
