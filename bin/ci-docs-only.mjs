#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Prints `docs_only=true|false` and appends it to `$GITHUB_OUTPUT`, for the
 * `scope` step of `ci.yml`'s `e2e`, `e2e-macos` and `node-current` jobs. Reads
 * `EVENT_NAME` and `BASE_SHA` from the environment, never from the command
 * line. A failure to decide is `docs_only=false`, which makes the job run in
 * full, and the reason goes to stderr. It exits 0 unless the answer cannot be
 * recorded. See lib/ci-scope.mjs.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { docsOnlyFor } from "./lib/ci-scope.mjs";

const docsOnly = docsOnlyFor({
  eventName: process.env.EVENT_NAME,
  baseSha: process.env.BASE_SHA,
  git: (args) => execFileSync("git", args, { encoding: "utf8" }),
  log: (reason) => console.error(`ci-docs-only: ${reason}`),
});

const line = `docs_only=${docsOnly}`;
console.log(line);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}
