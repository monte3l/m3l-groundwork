#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Generates `packages/cli/README.md` -- the README npm shows for
 * `@monte3l/groundwork` -- from the root `README.md` that GitHub shows, so the
 * two can never describe different things. `--check` regenerates in memory
 * and fails (without writing) on drift; it is the `npm-readme` step in
 * `bin/lib/verify-steps.mjs`. Plain `node bin/build-npm-readme.mjs` writes it.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { format as formatWithPrettier, resolveConfig } from "prettier";
import { buildNpmReadme } from "./lib/npm-readme.mjs";
import { repoRoot } from "./lib/report.mjs";

async function main() {
  const root = repoRoot();
  const check = process.argv.includes("--check");
  const outPath = path.join(root, "packages/cli/README.md");
  const relPath = path.relative(root, outPath);

  const rootReadme = await readFile(path.join(root, "README.md"), "utf8");
  const pkg = JSON.parse(
    await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
  );

  const prettierConfig = (await resolveConfig(root)) ?? {};
  const content = await formatWithPrettier(
    buildNpmReadme(rootReadme, pkg.repository.url),
    { ...prettierConfig, filepath: outPath },
  );

  if (check) {
    let existing = null;
    try {
      existing = await readFile(outPath, "utf8");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    if (existing !== content) {
      console.error(
        `fail  ${relPath} is out of date -- run \`node bin/build-npm-readme.mjs\` and commit the result`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  ok  ${relPath} is current`);
    return;
  }

  await writeFile(outPath, content, "utf8");
  console.log(`wrote ${relPath}`);
}

await main();
