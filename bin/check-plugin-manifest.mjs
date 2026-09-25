#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Runs `claude plugin validate --strict` against this repo's marketplace
 * manifest and the plugin it lists, catching a `plugin.json`/
 * `marketplace.json` mistake `check-plugin-version.mjs` doesn't check
 * (kebab-case names, path forms, unknown fields, a missing `version`/
 * `description`/`author`). Skips cleanly (exit 0, one warning) when the
 * `claude` CLI isn't installed, same pattern as `bin/eval.mjs` -- this is a
 * local/CI convenience, not something a contributor without Claude Code
 * installed should be blocked by.
 */
import { spawnSync } from "node:child_process";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot();
const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));

if (spawnSync("claude", ["--version"], { stdio: "ignore" }).error) {
  reporter.warn("claude CLI not found -- skipping plugin manifest validation");
  reporter.finish();
  process.exit(0);
}

const targets = [
  { label: "marketplace manifest", path: root },
  { label: "m3l-groundwork-customize plugin", path: "packages/plugin" },
];

for (const { label, path } of targets) {
  const result = spawnSync("claude", ["plugin", "validate", "--strict", path], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) {
    reporter.ok(`claude plugin validate: ${label} passed`);
  } else {
    reporter.fail(
      `claude plugin validate: ${label} failed\n${(result.stdout ?? "") + (result.stderr ?? "")}`,
    );
  }
}

reporter.finish();
