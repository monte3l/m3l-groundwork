#!/usr/bin/env node
/**
 * Writes a throwaway plugin wrapping `templates/core`'s skills, plus one eval
 * case per entry in `evals/core-harness/triggers.json`, into the directory
 * given as the sole argument -- so the emitted baseline harness can be run
 * through `claude plugin eval <dir>` by hand. `bin/eval.mjs` does this into a
 * temp dir on every run; this entry point exists to inspect or iterate on the
 * generated plugin without spending anything.
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "./lib/report.mjs";
import { writeHarnessPlugin } from "./lib/eval-lib.mjs";

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error("usage: node bin/make-harness-plugin.mjs <output-dir>");
  process.exit(1);
}

const root = repoRoot();
const count = writeHarnessPlugin({
  skillsDir: resolve(root, "templates", "core", ".claude", "skills"),
  corpus: JSON.parse(
    readFileSync(
      resolve(root, "evals", "core-harness", "triggers.json"),
      "utf8",
    ),
  ),
  outDir: resolve(outDir),
});
console.log(
  `wrote ${count} eval cases and the wrapper plugin to ${resolve(outDir)}`,
);
