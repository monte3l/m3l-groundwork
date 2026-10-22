#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Stages a packed tarball on npm through trusted publishing (GitHub OIDC), for
 * `release.yml`'s `publish` job. Replaces `npm stage publish`.
 *
 * ## Why not the npm CLI
 *
 * Every vulnerable package behind this repo's Dependabot alerts (undici,
 * ip-address, brace-expansion, http-cache-semantics, postcss-selector-parser)
 * was bundled inside the npm tarball, where neither `overrides` nor
 * `npm audit fix` can reach it, and no npm release patched them. npm's own
 * publish library, `libnpmpublish`, is an ordinary dependency tree and
 * resolves clean (see docs/security-review.md).
 *
 * ## What it does
 *
 * 1. Gets a GitHub OIDC id token for `npm:<registry host>`.
 * 2. Exchanges it at `/-/npm/v1/oidc/token/exchange/package/<name>` for a
 *    short-lived npm token scoped to this package (ported from npm's
 *    `lib/utils/oidc.js`).
 * 3. Calls `libnpmpublish.publish(..., { stage: true, provenance: true })`.
 *
 * Unlike the npm CLI, whose OIDC step silently falls back to "no auth" on any
 * failure, every failure here exits non-zero with the reason. Tokens are never
 * printed.
 *
 * ## Inputs
 *
 * `RELEASE_TOOLS_DIR` names the directory holding the `npm ci`-installed
 * libnpmpublish and npm-registry-fetch (the release-tools lockfile).
 * `STAGED_IDS_FILE`, when set, receives one `<name>@<version> <stage id>` line per
 * staged version, so the workflow can print the id to approve after this step.
 * `NPM_CONFIG_REGISTRY` overrides the registry (as in npm; the tests point it at a
 * local server; default npmjs.org).
 */
import process from "node:process";
import { readFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parsePublishArgs } from "./lib/npm-publish-args.mjs";
import {
  readTarballManifest,
  readTarballReadme,
} from "./lib/read-tarball-manifest.mjs";

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`npm-stage-publish: ${message}`);
  process.exit(1);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} registry
 * @returns {Promise<string>} the GitHub OIDC id token
 */
async function githubIdToken(env, registry) {
  if (env.NPM_ID_TOKEN) return env.NPM_ID_TOKEN;
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    fail(
      "no GitHub OIDC token available: the job needs `permissions: id-token: write`",
    );
  }
  let json;
  try {
    const url = new URL(requestUrl);
    url.searchParams.append("audience", `npm:${new URL(registry).hostname}`);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requestToken}`,
      },
    });
    if (!response.ok) {
      fail(`GitHub refused the OIDC token request (HTTP ${response.status})`);
    }
    json = await response.json();
  } catch (error) {
    fail(
      `GitHub OIDC token request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof json?.value !== "string" || json.value === "") {
    fail("GitHub's OIDC response carried no token");
  }
  return json.value;
}

const args = process.argv.slice(2);
let parsed;
try {
  parsed = parsePublishArgs(args);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const toolsDir = process.env.RELEASE_TOOLS_DIR;
if (!toolsDir) fail("RELEASE_TOOLS_DIR is not set");
const requireTools = createRequire(join(toolsDir, "package.json"));
let publish;
let npmFetch;
try {
  ({ publish } = requireTools("libnpmpublish"));
  npmFetch = requireTools("npm-registry-fetch");
} catch (error) {
  fail(
    `cannot load libnpmpublish from ${toolsDir} (run npm ci --ignore-scripts --prefix there first): ${error instanceof Error ? error.message : String(error)}`,
  );
}

const registry =
  process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org/";
const registryUrl = new URL(registry);
const authKey = `//${registryUrl.host}${registryUrl.pathname}:_authToken`;

let manifest;
let tarball;
try {
  tarball = readFileSync(parsed.tarball);
  manifest = readTarballManifest(tarball);
  // npm's own publish adds the README to the version metadata; libnpmpublish
  // does not, so do it here or the package page shows none.
  const readme = readTarballReadme(tarball);
  if (readme !== undefined && manifest.readme === undefined) {
    manifest.readme = readme.content;
    manifest.readmeFilename = readme.filename;
  }
} catch (error) {
  fail(
    `cannot read ${parsed.tarball}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (
  typeof manifest?.name !== "string" ||
  typeof manifest?.version !== "string"
) {
  fail(`${parsed.tarball}: package.json has no name and version`);
}

// npm refuses a prerelease published without an explicit dist-tag, because it
// would otherwise land on `latest`. Refuse here too, before any token is used.
if (/^\d+\.\d+\.\d+-/.test(manifest.version) && parsed.tag === undefined) {
  fail(
    `${manifest.name}@${manifest.version} is a prerelease: pass --tag so it does not land on latest`,
  );
}

const idToken = await githubIdToken(process.env, registry);

let npmToken;
try {
  const exchange = await npmFetch.json(
    new URL(
      `/-/npm/v1/oidc/token/exchange/package/${manifest.name.replace(/\//g, "%2f")}`,
      registry,
    ),
    { registry, method: "POST", [authKey]: idToken },
  );
  npmToken = exchange?.token;
} catch (error) {
  fail(
    `npm refused the OIDC token exchange for ${manifest.name} (check the trusted publisher config): ${error?.body?.message ?? (error?.statusCode ? `HTTP ${error.statusCode}` : undefined) ?? (error instanceof Error ? error.message : String(error))}`,
  );
}
if (typeof npmToken !== "string" || npmToken === "") {
  fail("npm's token exchange response carried no token");
}

let result;
try {
  result = await publish(manifest, tarball, {
    registry,
    [authKey]: npmToken,
    stage: true,
    provenance: true,
    // publishConfig in the manifest is not merged as npm does: the caller
    // passes --access/--tag explicitly and provenance is always on.
    access: parsed.access ?? null,
    defaultTag: parsed.tag ?? "latest",
    ...(parsed.otp === undefined ? {} : { otp: parsed.otp }),
  });
} catch (error) {
  fail(
    `staging ${manifest.name}@${manifest.version} failed (the registry may still hold a staged version -- run npm stage list before re-running): ${error instanceof Error ? error.message : String(error)}`,
  );
}

const stageId = result?.stageId;
if (typeof stageId !== "string" || stageId === "") {
  fail(`staging ${manifest.name}@${manifest.version} returned no stage id`);
}
const id = `${manifest.name}@${manifest.version}`;
console.log(`+ ${id} (staged with id ${stageId})`);
console.log(`approve with: npm stage approve ${stageId}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  // Best effort: the version is already staged, so a summary write failure
  // must not turn this run red and leave the release without its evidence.
  try {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Staged ${id}\n\nApprove with 2FA: \`npm stage approve ${stageId}\`\n`,
    );
  } catch (error) {
    console.error(
      `npm-stage-publish: staged ${id} (${stageId}) but could not write the step summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
if (process.env.STAGED_IDS_FILE) {
  // Leave the id in a file the workflow prints in a later step, with an
  // annotation on the run page.
  // Best effort, like the summary: the version is already staged.
  try {
    appendFileSync(process.env.STAGED_IDS_FILE, `${id} ${stageId}\n`);
  } catch (error) {
    console.error(
      `npm-stage-publish: staged ${id} (${stageId}) but could not record it in ${process.env.STAGED_IDS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
