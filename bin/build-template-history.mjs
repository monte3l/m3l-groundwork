#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Generates `packages/cli/data/template-history.json` -- the hashes (and,
 * for merge-relevant files, the text) of every template file at every stable
 * `@monte3l/groundwork@x.y.z` tag, which the CLI's update flow compares a
 * project against. Plain `node bin/build-template-history.mjs` regenerates it
 * from the local tags (fetch them first; with none it fails and leaves the
 * committed file untouched). `--check` needs no tags: it
 * validates the committed file and fails when a released version in
 * `packages/cli/CHANGELOG.md` is missing; it is the `template-history` step
 * in `bin/lib/verify-steps.mjs`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { repoRoot } from "./lib/report.mjs";
import {
  assertBuildable,
  buildTemplateHistory,
  checkTemplateHistory,
  serializeTemplateHistory,
} from "./lib/template-history.mjs";

async function main() {
  const root = repoRoot();
  const outPath = path.join(root, "packages/cli/data/template-history.json");
  const relPath = path.relative(root, outPath);

  if (process.argv.includes("--check")) {
    let text = null;
    try {
      text = await readFile(outPath, "utf8");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    const pkg = JSON.parse(
      await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
    );
    const changelogText = await readFile(
      path.join(root, "packages/cli/CHANGELOG.md"),
      "utf8",
    );
    const problems = checkTemplateHistory({
      text,
      path: relPath,
      changelogText,
      currentVersion: pkg.version,
    });
    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(`fail  ${relPath}: ${problem}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`  ok  ${relPath} is valid and covers every release`);
    return;
  }

  const history = buildTemplateHistory({ repoDir: root });
  try {
    assertBuildable(history);
  } catch (error) {
    console.error(`fail  ${relPath} not written: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  await writeFile(outPath, serializeTemplateHistory(history), "utf8");
  console.log(
    `wrote ${relPath} (${String(Object.keys(history.versions).length)} versions)`,
  );
}

await main();
