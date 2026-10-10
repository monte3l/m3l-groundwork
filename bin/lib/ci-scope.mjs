// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Decides whether a pull request changes documentation and nothing else, so
 * `ci.yml`'s three heavy jobs (`e2e`, `e2e-macos`, `node-current`) can skip
 * their work. Every question here resolves toward "run everything": a wrong
 * `false` only costs minutes, a wrong `true` skips the only proof that the
 * emitted baseline works.
 */

// A full-length object id, never anything that could read as a git option.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** True for a path that only documents the repo: `docs/**` or a root `*.md`. */
function isDocsPath(path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) {
    return false;
  }
  if (path.split("/").includes("..")) return false;
  if (path.startsWith("docs/")) return path.length > "docs/".length;
  return !path.includes("/") && path.endsWith(".md");
}

/** True when the list is non-empty and every path is a documentation path. */
export function isDocsOnly(paths) {
  return paths.length > 0 && paths.every(isDocsPath);
}

/**
 * Lists what a pull request changes and classifies it. `git(args)` returns
 * stdout and may throw; any failure, or anything but a pull request with a
 * well-formed base commit, is `false`. `--no-renames` lists both sides of a
 * rename, so moving code into `docs/` cannot hide the deletion of the code.
 * `log(reason)` is told why the answer is what it is, so a skip that quietly
 * stopped working shows up in the run log instead of just costing minutes.
 */
export function docsOnlyFor({ eventName, baseSha, git, log = () => {} }) {
  if (eventName !== "pull_request") {
    log(`not a pull request (event: ${eventName})`);
    return false;
  }
  if (typeof baseSha !== "string" || !SHA.test(baseSha)) {
    log("no well-formed base commit");
    return false;
  }
  try {
    git(["fetch", "--no-tags", "--depth=1", "origin", baseSha]);
    const out = git([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseSha,
      "HEAD",
    ]);
    const paths = out.split("\0");
    if (paths.at(-1) === "") paths.pop();
    if (paths.length === 0) {
      log("empty diff");
      return false;
    }
    const other = paths.find((path) => !isDocsPath(path));
    if (other !== undefined) {
      log(`changes more than documentation (e.g. ${JSON.stringify(other)})`);
      return false;
    }
    log(`documentation only (${paths.length} path(s))`);
    return true;
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    log(`could not list the changes: ${text.split("\n")[0]}`);
    return false;
  }
}
