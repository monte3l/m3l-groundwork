#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Put ahead of the real `pnpm` on PATH by the release workflow's `publish`
 * job. Everything passes straight through to pnpm except `publish`, which
 * this rewrites into `npm stage publish` instead.
 *
 * ## Why it exists
 *
 * `changeset publish` in a pnpm workspace publishes through `pnpm publish`.
 * This shim reroutes that call to `npm stage publish`, because
 * `@monte3l/groundwork`'s trusted publisher only allows staged publishing
 * (npm's default for any trusted publisher created since 2026-09-03 -- see
 * CLAUDE.md, "Releases").
 *
 * ## What it translates
 *
 * Only the exact `pnpm publish` invocation changesets makes -- everything
 * else (install, other pnpm subcommands) passes straight through to the real
 * `pnpm` unmodified. Routing only the publish keeps changesets in charge of
 * everything else it does around it -- the publish plan, ordering, git tags,
 * GitHub Releases -- instead of reimplementing any of that. A consequence
 * worth knowing: those git tags and Releases are created the moment
 * `npm stage publish` succeeds, which is *before* the package is actually
 * live -- staging still needs a maintainer to run `npm stage approve <id>`
 * (2FA, never automatable).
 *
 * ## What it refuses
 *
 * `toNpmStagePublishArgs` (see `./lib/npm-publish-args.mjs`) accepts only the
 * flag shape changesets actually passes and throws on anything it does not
 * recognise, rather than guessing a translation for an unfamiliar flag.
 *
 * `PNPM_SHIM_DIR` names this shim's own directory so it can be dropped from
 * PATH when looking for the real pnpm (otherwise it would find itself).
 * Delete this, and the workflow step that installs it, once pnpm's publish
 * authenticates against npmjs.com.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import { pathWithout, toNpmStagePublishArgs } from "./lib/npm-publish-args.mjs";

const args = process.argv.slice(2);

let command;
let commandArgs;
if (args[0] === "publish") {
  try {
    command = "npm";
    commandArgs = toNpmStagePublishArgs(args.slice(1));
  } catch (error) {
    console.error(
      `pnpm-publish-shim: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
} else {
  command = "pnpm";
  commandArgs = args;
}

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: pathWithout(process.env.PATH, process.env.PNPM_SHIM_DIR, delimiter),
  },
});

if (result.error) {
  console.error(
    `pnpm-publish-shim: could not run ${command}: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
