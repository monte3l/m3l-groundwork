#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Writes a throwaway plugin wrapping `templates/core`'s skills, plus one eval
 * case per entry in `evals/core-harness/triggers.json`, into the directory
 * given as the sole argument -- so the emitted baseline harness can be run
 * through `claude plugin eval <dir>` by hand. `bin/eval.mjs` does this into a
 * temp dir on every run; this entry point exists to inspect or iterate on the
 * generated plugin without spending anything. `--packs` writes the `packs`
 * suite's wrapper instead (core's skills plus every
 * `templates/packs/*\/files/.claude/skills`, evaluated against
 * `evals/packs-harness/triggers.json`) -- the same params `bin/eval.mjs`
 * builds for that suite, via the shared `coreHarnessParams`/
 * `packsHarnessParams` in `bin/lib/eval-lib.mjs`, so the two entry points
 * can't quietly drift into producing different plugin shapes.
 *
 *   node bin/make-harness-plugin.mjs [--packs] <output-dir>
 */
import process from "node:process";
import { resolve } from "node:path";
import { repoRoot } from "./lib/report.mjs";
import {
  coreHarnessParams,
  packsHarnessParams,
  writeHarnessPlugin,
} from "./lib/eval-lib.mjs";

const args = process.argv.slice(2);
const unknownFlag = args.find((a) => a.startsWith("--") && a !== "--packs");
if (unknownFlag !== undefined) {
  console.error(`unknown flag: ${unknownFlag}`);
  console.error(
    "usage: node bin/make-harness-plugin.mjs [--packs] <output-dir>",
  );
  process.exit(1);
}
const packs = args.includes("--packs");
const outDir = args.find((a) => a !== "--packs");
if (outDir === undefined) {
  console.error(
    "usage: node bin/make-harness-plugin.mjs [--packs] <output-dir>",
  );
  process.exit(1);
}

const root = repoRoot();
const params = packs ? packsHarnessParams(root) : coreHarnessParams(root);
const count = writeHarnessPlugin({ ...params, outDir: resolve(outDir) });
console.log(
  `wrote ${count} eval cases and the wrapper plugin to ${resolve(outDir)}`,
);
