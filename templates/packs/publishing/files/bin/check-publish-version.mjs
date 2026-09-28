#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the __PROJECT_NAME__ contributors
// SPDX-License-Identifier: NOASSERTION

/**
 * Checks that the version this project's `package.json` currently declares
 * has not already been published to npm -- catches a version bump that
 * silently duplicates one already live (a stale manual edit, a rebase that
 * dropped a changeset), surfaced here rather than as a cryptic registry
 * rejection deep inside the release workflow's `publish` job.
 *
 * Deliberately NOT one of this pack's `pnpm verify` steps: with changesets,
 * `package.json`'s version on the release branch is always the one just
 * published between releases, so running this on every ordinary push would
 * fail every single time until the next version PR lands. Invoke it
 * directly, once, right before packing -- see `release.yml`'s `pack` job.
 *
 * A no-op (`checked: 0`, exit 0), not a failure, when:
 * - `package.json` has `private: true` (the baseline's own default) -- there
 *   is nothing to publish, so nothing to check.
 * - The registry lookup fails for a reason other than "package not found"
 *   (network error, timeout, registry outage, an unparseable body) -- this
 *   is a best-effort due-diligence check, not a hard dependency on the
 *   registry being reachable; a real duplicate-version publish still fails
 *   at `npm stage publish` itself, which is the actual enforcement point.
 *
 * A package that has never been published at all (the registry 404s) is
 * also fine: there is no prior version to collide with. A 404 can also mean
 * a scoped/restricted package the anonymous registry lookup can't see --
 * this check has no npm auth token to look further, so it reports that
 * possibility rather than asserting the package has definitely never
 * published.
 *
 * A non-private `package.json` missing `name` or `version` is a real
 * misconfiguration, not something to wave through: the version and dts-deps
 * gates only make sense once both fields say what's actually being shipped.
 */
import process from "node:process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const REGISTRY_TIMEOUT_MS = 10_000;

/**
 * @param {string} name
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ ok: true, versions: string[] } | { ok: false, reason: string }>}
 * `ok: false` means the lookup could not be completed (network error,
 * timeout, a non-404 error status, an unparseable body) -- distinct from
 * "the package has never been published" (a 404), which resolves
 * `{ ok: true, versions: [] }`.
 */
export async function fetchPublishedVersions(name, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(name).replaceAll("%40", "@")}`,
      { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) },
    );
  } catch (cause) {
    return {
      ok: false,
      reason: `request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (response.status === 404) {
    return { ok: true, versions: [] };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `registry responded with HTTP ${String(response.status)}`,
    };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "registry response body was not valid JSON" };
  }
  const versions = body?.versions;
  if (versions === null || typeof versions !== "object") {
    return {
      ok: false,
      reason: 'registry response had no usable "versions" field',
    };
  }
  return { ok: true, versions: Object.keys(versions) };
}

async function main() {
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  if (pkg?.private === true) {
    console.log("check-publish-version: package.json is private -- skipping");
    return;
  }
  const name = pkg?.name;
  const version = pkg?.version;
  if (typeof name !== "string" || name.length === 0) {
    console.error(
      "check-publish-version: package.json has no name, but is not private -- " +
        "either set private: true, or give it a real name",
    );
    process.exitCode = 1;
    return;
  }
  if (typeof version !== "string" || version.length === 0) {
    console.error("check-publish-version: package.json has no version");
    process.exitCode = 1;
    return;
  }

  const result = await fetchPublishedVersions(name, fetch);
  if (!result.ok) {
    console.log(
      `check-publish-version: could not check the npm registry for "${name}" -- skipping ` +
        `(${result.reason}; best-effort check, a real duplicate version still fails at publish time)`,
    );
    return;
  }
  if (result.versions.includes(version)) {
    console.error(
      `check-publish-version: ${name}@${version} is already published -- bump the version ` +
        "(or add a changeset, if this project uses one) before releasing again",
    );
    process.exitCode = 1;
    return;
  }
  if (result.versions.length === 0) {
    console.log(
      `check-publish-version: ok -- ${name}@${version} (the registry has no published versions ` +
        "for this name -- either it has never published, or it's a scoped/restricted package an " +
        "anonymous lookup can't see)",
    );
    return;
  }
  console.log(`check-publish-version: ok -- ${name}@${version} is unpublished`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  await main();
}
