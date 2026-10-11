#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Parses the one `pnpm publish` invocation changesets makes for a packed
 * tarball, for `pnpm-publish-shim.mjs` and `npm-stage-publish.mjs`.
 *
 * Changesets runs (see its `lib/pnpm.ts`):
 *   pnpm publish <tarball> [--json] --access <a> --tag <t> --no-git-checks [--otp <c>]
 *
 * `--json` and `--no-git-checks` are pnpm-only and dropped. Anything not listed
 * is refused rather than guessed at: if changesets ever starts passing a flag
 * this does not understand, publishing must stop, not silently do something else.
 *
 * Staged, not direct: `@monte3l/groundwork`'s trusted publisher only allows a
 * staged publish -- a maintainer must separately run `npm stage approve <id>`
 * (2FA, never automatable) before a staged version actually goes live.
 */

const DROPPED = new Set(["--json", "--no-git-checks"]);
const WITH_VALUE = new Set(["--access", "--tag", "--otp"]);

/**
 * Splits the arguments after `pnpm publish` into the tarball and the
 * `[flag, value]` pairs changesets passes, refusing anything else.
 *
 * @param {string[]} args the arguments following `pnpm publish`
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
      "no tarball given: this shim only publishes packed tarballs (changesets' --from-pack-dir mode)",
    );
  }
  return { tarball, pairs };
}

/**
 * Parses the one `pnpm publish` invocation changesets makes, as named values
 * for `npm-stage-publish.mjs` (which calls libnpmpublish instead of the npm CLI).
 *
 * @param {string[]} args the arguments following `pnpm publish`
 * @returns {{ tarball: string, access?: string, tag?: string, otp?: string }}
 */
export function parsePublishArgs(args) {
  const { tarball, pairs } = scanPublishArgs(args);
  const out = { tarball };
  for (const [flag, value] of pairs) out[flag.slice(2)] = value;
  return out;
}

/**
 * `PATH` with `dir` removed, so the shim can find the real `pnpm` behind it.
 * @param {string | undefined} pathValue
 * @param {string | undefined} dir
 * @param {string} separator
 */
export function pathWithout(pathValue, dir, separator) {
  if (pathValue === undefined || dir === undefined || dir === "") {
    return pathValue ?? "";
  }
  return pathValue
    .split(separator)
    .filter((entry) => entry !== dir)
    .join(separator);
}
