#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Compares the live docs site with the site this repo builds, and the
 * manifest's description, homepage and keywords with the GitHub repo's.
 *
 *   node design/source/docs-kit/check-live.mjs [--config docs.config.mjs] --site _site [--url <origin>]
 *   node design/source/docs-kit/check-live.mjs [--config docs.config.mjs] --metadata
 *
 * `--site <dir>` is a directory written by `node source/docs-kit/build.mjs --out`.
 * Every page, the 404 page and every file under `assets/` is fetched from
 * `--url` (default: the config's `siteUrl`) and must equal the built file byte for byte, and each response
 * must carry every header the built `_headers` file asks for (exact value).
 * That catches what the build alone cannot: a deploy that never landed, and
 * a Cloudflare zone setting that rewrites a page or replaces a header (zone
 * HSTS, JavaScript detections injecting a script).
 *
 * A fresh deploy can take a moment to reach every edge, so a failing run is
 * repeated (`--attempts`, `--delay` seconds) before it is reported.
 *
 * `--metadata` reads the config's `manifest` and the GitHub API for the
 * config's `repo` (with `GITHUB_TOKEN` when set) and fails when `description`
 * or `homepage` differ, or `keywords` and `topics` when the manifest has
 * `keywords`.
 *
 * Exit codes: 0 all matched, 1 a mismatch or an unreachable site, 2 usage.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ConfigError, loadConfig } from "./lib/config.mjs";
import {
  HeadersParseError,
  diffHeaders,
  diffMetadata,
  expectedHeadersFor,
  firstDifference,
  pageUrlPath,
  parseHeadersFile,
} from "./lib/live-site.mjs";

const NOT_FOUND_PROBE = "/__m3l-live-parity-404__";
const USER_AGENT = "m3l-docs-kit-live-parity";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 60;
const MAX_DELAY_SECONDS = 600;

/** A bad command line: reported with the usage text, exit 2. */
class UsageError extends Error {}

/** An input the check cannot run on (not a build, no rules): reported, exit 1. */
class LiveSiteError extends Error {}

function usage(message) {
  console.error(`check-live-site: ${message}`);
  console.error(
    "usage: node source/docs-kit/check-live.mjs [--config <docs.config.mjs>] [--site <dir>] [--url <origin>] [--attempts <n>] [--delay <seconds>] [--metadata]",
  );
  process.exitCode = 2;
}

/** The value after `name`, undefined when the flag is absent; a missing value throws. */
function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  return value;
}

function boundedInteger(value, fallback, name, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new UsageError(
      `${name} must be a whole number from 1 to ${max}, got "${value}"`,
    );
  }
  return parsed;
}

/** Every file under `dir`, as posix paths relative to it, sorted. */
async function listFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    throw new LiveSiteError(
      `cannot read the site directory ${dir}: ${error.message}`,
    );
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

/**
 * The URLs to compare, and the `_headers` rules that must cover every one of
 * them. Refuses a directory that is not a `build-docs` output or whose rules
 * would let a header go unchecked, so a vacuous pass is impossible.
 */
async function loadPlan(siteDir) {
  const files = await listFiles(siteDir);
  for (const required of ["index.html", "404.html", "_headers"]) {
    if (!files.includes(required)) {
      throw new LiveSiteError(
        `${siteDir} is not a build-docs output: ${required} is missing`,
      );
    }
  }
  let blocks;
  try {
    blocks = parseHeadersFile(
      await readFile(path.join(siteDir, "_headers"), "utf8"),
    );
  } catch (error) {
    if (error instanceof HeadersParseError) {
      throw new LiveSiteError(`${siteDir}/_headers: ${error.message}`);
    }
    throw error;
  }
  const targets = files
    .filter((file) => file !== "_headers" && file !== "404.html")
    .map((file) => ({ file, urlPath: pageUrlPath(file), status: 200 }));
  targets.push({ file: "404.html", urlPath: NOT_FOUND_PROBE, status: 404 });

  const bare = targets.filter(
    ({ urlPath }) =>
      Object.keys(expectedHeadersFor(blocks, urlPath)).length === 0,
  );
  if (bare.length > 0) {
    throw new LiveSiteError(
      `${siteDir}/_headers asks for no header on: ${bare.map((t) => t.urlPath).join(", ")}`,
    );
  }
  return { blocks, targets };
}

/** One request; a network failure or timeout is a reported problem, not a crash. */
async function fetchLive(origin, urlPath) {
  const response = await fetch(origin + urlPath, {
    headers: { "user-agent": USER_AGENT, "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

/** One pass over the whole site; returns the mismatches found. */
async function compareSite({ siteDir, origin, blocks, targets }) {
  const problems = [];
  let headerChecks = 0;
  for (const { file, urlPath, status } of targets) {
    let live;
    try {
      live = await fetchLive(origin, urlPath);
    } catch (error) {
      problems.push(
        `${urlPath}: request failed: ${error.cause?.message ?? error.message}`,
      );
      continue;
    }
    const { response, body } = live;
    if (response.status !== status) {
      const hint =
        response.status === 403
          ? " (Cloudflare is blocking the request: check Security > Bots and any WAF rule)"
          : "";
      problems.push(
        `${urlPath}: expected HTTP ${status}, got ${response.status}${hint}`,
      );
      continue;
    }
    const finalPath = new URL(response.url).pathname;
    if (finalPath !== urlPath) {
      problems.push(`${urlPath}: redirected to ${finalPath}`);
      continue;
    }
    const built = await readFile(path.join(siteDir, file));
    if (Buffer.compare(built, body) !== 0) {
      const difference = file.endsWith(".html")
        ? firstDifference(built.toString("utf8"), body.toString("utf8"))
        : null;
      problems.push(
        difference
          ? `${urlPath}: body differs at line ${difference.line}\n    built: ${difference.expected}\n    live:  ${difference.actual}`
          : `${urlPath}: content differs (${built.length} bytes built, ${body.length} live)`,
      );
    }
    const expected = expectedHeadersFor(blocks, urlPath);
    headerChecks += Object.keys(expected).length;
    for (const mismatch of diffHeaders(expected, response.headers)) {
      problems.push(`${urlPath}: header ${mismatch}`);
    }
  }
  return { problems, checked: targets.length, headerChecks };
}

async function checkSite(args, config) {
  const siteDir = option(args, "--site");
  const origin = (option(args, "--url") ?? config.siteUrl).replace(/\/+$/, "");
  const attempts = boundedInteger(
    option(args, "--attempts"),
    6,
    "--attempts",
    MAX_ATTEMPTS,
  );
  const delay = boundedInteger(
    option(args, "--delay"),
    10,
    "--delay",
    MAX_DELAY_SECONDS,
  );
  const plan = await loadPlan(siteDir);

  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await compareSite({ siteDir, origin, ...plan });
    if (result.problems.length === 0) {
      console.log(
        `  ok  ${origin} matches the build (${result.checked} URLs, ${result.headerChecks} header values)`,
      );
      return true;
    }
    if (attempt < attempts) {
      console.error(
        `  attempt ${attempt}/${attempts}: ${result.problems.length} mismatch(es), first: ${result.problems[0].split("\n")[0]}; retrying in ${delay}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
  console.error(`  FAIL  ${origin} does not match the build:`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  return false;
}

async function checkMetadata(config) {
  if (!config.manifest) {
    throw new LiveSiteError(
      `${config.configPath} has no "manifest", so there is nothing to compare`,
    );
  }
  const REPO_API = `https://api.github.com/repos/${new URL(config.repo).pathname.slice(1)}`;
  let pkg;
  try {
    pkg = JSON.parse(
      await readFile(path.join(config.root, config.manifest), "utf8"),
    );
  } catch (error) {
    throw new LiveSiteError(`cannot read ${config.manifest}: ${error.message}`);
  }
  const headers = {
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
  };
  const authenticated = Boolean(process.env.GITHUB_TOKEN);
  if (authenticated)
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(REPO_API, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new LiveSiteError(
      `${REPO_API} returned HTTP ${response.status} (${authenticated ? "with" : "without"} GITHUB_TOKEN, rate limit remaining ${remaining ?? "unknown"}): ${text.slice(0, 200)}`,
    );
  }
  let repo;
  try {
    repo = JSON.parse(text);
  } catch (error) {
    throw new LiveSiteError(
      `${REPO_API} did not return JSON: ${error.message}`,
    );
  }
  const stringOrNull = (value) => value === null || typeof value === "string";
  if (
    !repo ||
    !Array.isArray(repo.topics) ||
    !stringOrNull(repo.description) ||
    !stringOrNull(repo.homepage)
  ) {
    throw new LiveSiteError(
      `${REPO_API} did not return a repository (no topics array, description or homepage)`,
    );
  }
  const problems = diffMetadata(pkg, repo, config.manifest);
  if (problems.length === 0) {
    console.log(
      `  ok  ${config.manifest} and the GitHub repo agree on description, homepage and keywords`,
    );
    return true;
  }
  console.error(`  FAIL  ${config.manifest} and the GitHub repo disagree:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  return false;
}

/** Runs one check; its own failure is reported without hiding the other. */
async function run(name, check) {
  try {
    return await check();
  } catch (error) {
    if (error instanceof UsageError) throw error;
    console.error(`  FAIL  ${name}: ${error.cause?.message ?? error.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  try {
    const config = await loadConfig(option(args, "--config") ?? "docs.config.mjs");
    const wantsSite = args.includes("--site");
    const wantsMetadata = args.includes("--metadata");
    if (!wantsSite && !wantsMetadata) {
      throw new UsageError("pass --site <dir>, --metadata, or both");
    }
    // Validate every value before any request goes out.
    if (wantsSite) {
      option(args, "--site");
      option(args, "--url");
      boundedInteger(option(args, "--attempts"), 6, "--attempts", MAX_ATTEMPTS);
      boundedInteger(option(args, "--delay"), 10, "--delay", MAX_DELAY_SECONDS);
    }
    const results = [];
    if (wantsSite) results.push(await run("live site", () => checkSite(args, config)));
    if (wantsMetadata) results.push(await run("metadata", () => checkMetadata(config)));
    if (!results.every(Boolean)) process.exitCode = 1;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      usage(error.message);
      return;
    }
    throw error;
  }
}

await main();
