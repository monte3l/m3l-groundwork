#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Deprecates every published `@monte3l/groundwork` version older than
 * `latest` that is not already deprecated, as `Superseded by <latest>`.
 * Existing messages are left alone. The plan comes from the pure
 * `lib/deprecation-plan.mjs`; this file only does the I/O.
 *
 * ## Usage
 *
 * ```bash
 * node bin/deprecate-superseded.mjs                                   # dry run
 * node bin/deprecate-superseded.mjs --expect 1.0.4 --apply [--otp <code>]
 * ```
 *
 * The default is a dry run: it prints the plan and the one command it would
 * run (shell-pasteable), and calls nothing. `--apply` runs that command, then
 * re-reads the packument (up to 6 times, `DEPRECATE_VERIFY_DELAY_MS` apart,
 * default 5000, with `Cache-Control: no-cache`) and exits non-zero if any
 * planned version still lacks the message. `--apply` requires
 * `--expect <version>`, which refuses unless `latest` is that version: that
 * catches a run made before `npm stage approve` has moved `latest`. `--otp` is
 * only accepted with `--apply`, and is never echoed. A rerun only touches what
 * is still undeprecated.
 *
 * ## Why this is not a CI step
 *
 * A staged version is not installable until a maintainer runs
 * `npm stage approve` (a live 2FA step no GitHub event reports), so deprecating
 * at publish time would leave users with only deprecated installable versions
 * until then. The trusted publisher's OIDC token authorizes publishing, not
 * `npm deprecate`, so CI could only do it with a long-lived npm token, which
 * this design deliberately avoids. The maintainer runs it with their own login.
 *
 * ## Why one range call
 *
 * `npm deprecate` takes a version range, so the planned exact versions go out
 * as one `name@a || b || c` spec: npm writes the packument once and challenges
 * 2FA once, instead of once per version. `--otp <code>` passes the code
 * through, and npm sets `auth-type` to `legacy` whenever `otp` is given, so a
 * TOTP user sees no browser at all. The spec lists exact versions rather than
 * `<latest`, so versions that already carry their own message are never
 * matched.
 *
 * Rejected: a granular "bypass 2FA" token (npm documents it for publishing
 * only, and it is long-lived), and relying on the browser's "remember for 5
 * minutes" option (documented for `publish` only, not `deprecate`).
 *
 * ## Inputs
 *
 * `NPM_CONFIG_REGISTRY` overrides the registry (as in npm; the tests point it
 * at a local server; default npmjs.org). The packument is read anonymously,
 * since `npm view` does not expose per-version `deprecated`.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  buildDeprecateRange,
  compareSemver,
  planDeprecations,
} from "./lib/deprecation-plan.mjs";

const PACKAGE = "@monte3l/groundwork";
const FETCH_TIMEOUT_MS = 30_000;
const VERIFY_READS = 6;
// Every read bypasses caches: the registry's CDN can serve a packument from
// before the deprecation for a while.
const NO_CACHE = { "Cache-Control": "no-cache" };

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`deprecate-superseded: ${message}`);
  process.exit(1);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} registry
 * @param {Record<string, string>} [headers] extra request headers
 * @returns {Promise<import("./lib/deprecation-plan.mjs").Packument>}
 */
async function fetchPackument(registry, headers = {}) {
  const url = `${registry.replace(/\/+$/, "")}/${PACKAGE.replace("/", "%2f")}`;
  let json;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      fail(`GET ${url} returned HTTP ${response.status}`);
    }
    json = await response.json();
  } catch (error) {
    fail(`cannot read the packument from ${url}: ${reason(error)}`);
  }
  if (
    typeof json !== "object" ||
    json === null ||
    typeof json.versions !== "object" ||
    json.versions === null
  ) {
    fail(`${url} did not return a packument with a versions map`);
  }
  return json;
}

let options;
try {
  ({ values: options } = parseArgs({
    args: process.argv.slice(2),
    options: {
      apply: { type: "boolean", default: false },
      expect: { type: "string" },
      otp: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail(reason(error));
}
if (options.apply && options.expect === undefined) {
  fail("--apply requires --expect <version>");
}
if (!options.apply && options.otp !== undefined) {
  fail("--otp is only used with --apply; a dry run would ignore it");
}

const delayText = process.env.DEPRECATE_VERIFY_DELAY_MS ?? "5000";
if (!/^\d+$/.test(delayText)) {
  fail(
    `DEPRECATE_VERIFY_DELAY_MS must be a non-negative integer, got ${JSON.stringify(delayText)}`,
  );
}
const verifyDelayMs = Number(delayText);

const registry =
  process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org";

const plan = planDeprecations(await fetchPackument(registry, NO_CACHE));
if (plan.refused !== undefined) {
  fail(`refusing to plan: ${plan.refused}`);
}
if (options.expect !== undefined && options.expect !== plan.target) {
  fail(
    `latest is ${plan.target ?? "unset"}, not the expected ${options.expect} (has npm stage approve run yet?)`,
  );
}

console.log(`latest: ${plan.target}`);
if (plan.alreadyDeprecated.length > 0) {
  console.log(`already deprecated: ${plan.alreadyDeprecated.join(", ")}`);
}
if (plan.deprecate.length === 0) {
  console.log("nothing to deprecate");
  process.exit(0);
}

// The planner gives every entry the same message; one range call can only
// set one, so take it from the plan rather than re-deriving it here.
const message = plan.deprecate[0]?.message;
if (
  message === undefined ||
  plan.deprecate.some((d) => d.message !== message)
) {
  fail("the plan does not carry a single message for one npm deprecate call");
}
// Newest first, so the spec reads from the version just superseded downward.
const versions = plan.deprecate
  .map((d) => d.version)
  .sort((a, b) => compareSemver(b, a));
const range = buildDeprecateRange(PACKAGE, versions);
for (const version of versions) {
  console.log(`deprecate ${version}: ${message}`);
}
// JSON string quoting is shell-pasteable for these values (no `$`, backtick
// or backslash can appear in a SemVer string or this message).
const shownCommand = `npm deprecate ${JSON.stringify(range)} ${JSON.stringify(message)}`;
console.log(`command: ${shownCommand}`);

if (!options.apply) {
  console.log("dry run: pass --expect <version> --apply to run it");
  process.exit(0);
}

const npmArgs = ["deprecate", range, message];
if (options.otp !== undefined) npmArgs.push("--otp", options.otp);
try {
  execFileSync("npm", npmArgs, { stdio: "inherit" });
} catch (error) {
  // Never print execFileSync's own message: it embeds the full argv, which
  // would echo the --otp code.
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? `exit status ${String(error.status)}`
      : "could not run npm";
  fail(
    `npm deprecate failed (${status}) running: ${shownCommand}${options.otp === undefined ? "" : " --otp <redacted>"}`,
  );
}

/** @type {string[]} */
let missing = versions;
for (let read = 1; read <= VERIFY_READS; read++) {
  await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
  const after = await fetchPackument(registry, NO_CACHE);
  missing = versions.filter((v) => after.versions[v]?.deprecated !== message);
  if (missing.length === 0) break;
}
if (missing.length > 0) {
  fail(
    `npm deprecate exited 0, but after ${VERIFY_READS} reads these versions still lack "${message}": ${missing.join(", ")}. The registry may be lagging; a rerun is idempotent and only touches what is still undeprecated.`,
  );
}
console.log(`deprecated ${versions.join(", ")}`);
