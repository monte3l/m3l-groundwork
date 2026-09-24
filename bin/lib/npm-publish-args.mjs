#!/usr/bin/env node
/**
 * Translates the one `pnpm publish` invocation changesets makes for a packed
 * tarball into the equivalent `npm publish`, for `pnpm-publish-shim.mjs`.
 *
 * Changesets runs (see its `lib/pnpm.ts`):
 *   pnpm publish <tarball> [--json] --access <a> --tag <t> --no-git-checks [--otp <c>]
 *
 * `--json` and `--no-git-checks` are pnpm-only and dropped. Anything not listed
 * is refused rather than guessed at: if changesets ever starts passing a flag
 * this does not understand, publishing must stop, not silently do something else.
 */

const DROPPED = new Set(["--json", "--no-git-checks"]);
const WITH_VALUE = new Set(["--access", "--tag", "--otp"]);

/**
 * @param {string[]} args the arguments following `pnpm publish`
 * @returns {string[]} the argument vector for `npm publish`
 */
export function toNpmPublishArgs(args) {
  let tarball;
  const flags = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (DROPPED.has(arg)) continue;

    if (WITH_VALUE.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      flags.push(arg, value);
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

  // Provenance is requested explicitly rather than relied on: npm's automatic
  // attestation for trusted publishing has been reported not to engage without it.
  return ["publish", tarball, ...flags, "--provenance"];
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
