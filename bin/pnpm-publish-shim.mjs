#!/usr/bin/env node
/**
 * Put ahead of the real `pnpm` on PATH by the release workflow's `publish` job.
 * Everything passes straight through to pnpm except `publish`, which goes to
 * `npm publish` instead.
 *
 * Why: `changeset publish` in a pnpm workspace publishes through `pnpm publish`,
 * and pnpm 12's native publish does its own OIDC exchange, which npmjs.com
 * rejects (`403 OIDC permission denied`) even for a correctly configured trusted
 * publisher. The npm CLI's exchange works. Routing only the publish keeps
 * changesets in charge of everything else it does around it -- the publish plan,
 * ordering, git tags, GitHub Releases -- instead of reimplementing any of that.
 *
 * `PNPM_SHIM_DIR` names this shim's own directory so it can be dropped from
 * PATH when looking for the real pnpm (otherwise it would find itself).
 * Delete this, and the workflow step that installs it, once pnpm's publish
 * authenticates against npmjs.com.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import { pathWithout, toNpmPublishArgs } from "./lib/npm-publish-args.mjs";

const args = process.argv.slice(2);

let command;
let commandArgs;
if (args[0] === "publish") {
  try {
    command = "npm";
    commandArgs = toNpmPublishArgs(args.slice(1));
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
