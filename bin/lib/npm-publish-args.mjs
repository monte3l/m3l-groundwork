#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Parses the arguments of a staged publish of a packed tarball, for
 * `npm-stage-publish.mjs`:
 *   <tarball> --access <a> --tag <t> --expect <name>@<version> [--otp <c>]
 *
 * `--expect` names the `name@version` the caller means to stage;
 * `npm-stage-publish.mjs` requires it and refuses a tarball whose manifest
 * says otherwise.
 *
 * `--json` and `--no-git-checks` are accepted and dropped: they are the flags
 * `pnpm publish` took when Changesets drove the publish. Anything not listed is
 * refused rather than guessed at, so a mistyped flag stops the publish instead
 * of silently doing something else. A flag given twice is refused for the same
 * reason, instead of taking the first or the last value.
 *
 * Staged, not direct: `@monte3l/groundwork`'s trusted publisher only allows a
 * staged publish -- a maintainer must separately run `npm stage approve <id>`
 * (2FA, never automatable) before a staged version actually goes live.
 */

const DROPPED = new Set(["--json", "--no-git-checks"]);
const WITH_VALUE = new Set(["--access", "--tag", "--otp", "--expect"]);

/**
 * Splits the arguments into the tarball and the `[flag, value]` pairs,
 * refusing anything else, including a flag given twice.
 *
 * @param {string[]} args the arguments after the script name
 * @returns {{ tarball: string, pairs: [string, string][] }}
 */
function scanPublishArgs(args) {
  let tarball;
  const pairs = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (DROPPED.has(arg)) continue;

    if (WITH_VALUE.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      if (pairs.some(([flag]) => flag === arg)) {
        throw new Error(`${arg} was given more than once`);
      }
      pairs.push([arg, value]);
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unsupported flag ${arg}`);
    }
    if (tarball !== undefined) {
      throw new Error(`expected one tarball, got a second argument: ${arg}`);
    }
    tarball = arg;
  }

  if (tarball === undefined) {
    throw new Error(
      "no tarball given: this script only publishes packed tarballs",
    );
  }
  return { tarball, pairs };
}

/**
 * Parses the publish arguments as named values
 * for `npm-stage-publish.mjs` (which calls libnpmpublish instead of the npm CLI).
 *
 * @param {string[]} args the arguments after the script name
 * @returns {{ tarball: string, access?: string, tag?: string, otp?: string, expect?: string }}
 * @throws {Error} on an unknown or repeated flag, a flag without a value, or
 *   not exactly one tarball
 */
export function parsePublishArgs(args) {
  const { tarball, pairs } = scanPublishArgs(args);
  const out = { tarball };
  for (const [flag, value] of pairs) out[flag.slice(2)] = value;
  return out;
}
