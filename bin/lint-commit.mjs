#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Wraps `@commitlint/lint` + `@commitlint/load` directly (no `@commitlint/cli`
 * dependency needed) against this project's `commitlint.config.js`. Also
 * validates that no forbidden `Claude-*` trailer survived into the message
 * (a backstop -- `strip-claude-trailers.mjs` runs first in the `commit-msg`
 * hook and should have already removed any harness-injected one;
 * `Co-Authored-By:` is never forbidden).
 *
 * Usage: `lint-commit.mjs --edit <path-to-commit-msg-file>` (lefthook's
 * `commit-msg` hook contract) or `lint-commit.mjs <message>` directly.
 *
 * When the config enables `trailer-exists` as an error (severity 2), the
 * trailer, with a non-empty value, is also required on every message
 * commitlint's default ignores skip (merge, revert, `fixup!`, `squash!`,
 * `amend!`, semver release subjects): a local merge or revert needs
 * `git merge --signoff` / `git revert --signoff` too. This wrapper
 * deliberately does not honour commitlint's own `ignores`/`defaultIgnores`
 * config keys: the first lint uses commitlint's built-in default ignores,
 * and the trailer re-check always runs with them off.
 *
 * Any failure -- a rule violation, a thrown error from commitlint, or a
 * missing `git` (which `trailer-exists` shells out to) -- prints one `✗` line
 * to stderr and exits 1, never a stack trace.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import load from "@commitlint/load";
import lint from "@commitlint/lint";
import { paint } from "./lib/term.mjs";

const args = process.argv.slice(2);
const editIndex = args.indexOf("--edit");
const message =
  editIndex === -1 ? args.join(" ") : readFileSync(args[editIndex + 1], "utf8");

const FORBIDDEN_TRAILER = /^Claude-(?!Session:)[A-Za-z-]*:/m;

function validateForbiddenTrailers(text) {
  return !FORBIDDEN_TRAILER.test(text) && !/^Claude-Session:/m.test(text);
}

/**
 * Prints one `✗` line to stderr and exits 1.
 */
function fail(text) {
  console.error(paint(process.stderr, "danger", `✗ ${text}`));
  process.exit(1);
}

function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The loaded config's `trailer-exists` entry when it is an enforced
 * requirement (severity 2, not `never`), else `undefined`. Severity 1 is a
 * commitlint warning and never blocks a commit.
 */
function enforcedTrailerRule(rules) {
  const entry = rules?.["trailer-exists"];
  if (!Array.isArray(entry)) return undefined;
  const [severity, applicable] = entry;
  return severity === 2 && applicable !== "never" ? entry : undefined;
}

/**
 * The configured trailer name with any trailing `:` stripped, so
 * `Signed-off-by` and `Signed-off-by:` mean the same trailer. Empty when the
 * rule names no trailer.
 */
function trailerKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/:$/, "")
    .trim();
}

/**
 * Whether the message's trailer block (as `git interpret-trailers --parse`
 * reads it, the same parse commitlint's `trailer-exists` uses) holds a
 * `key:` trailer with a non-empty value. commitlint only checks the prefix,
 * so an empty `Signed-off-by:` would otherwise pass. Throws when `git` cannot
 * be run or exits non-zero; the caller reports that and exits 1.
 */
function hasNonEmptyTrailer(text, key) {
  const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
    input: text,
    encoding: "utf8",
  });
  if (parsed.error !== undefined) throw parsed.error;
  if (parsed.status !== 0) {
    throw new Error(
      parsed.stderr.trim() || `exited with status ${String(parsed.status)}`,
    );
  }
  const prefix = `${key}:`;
  return parsed.stdout
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith(prefix) && line.slice(prefix.length).trim() !== "",
    );
}

const IGNORED_KINDS =
  "merge, revert, fixup!, squash!, amend!, semver release subjects";

function missingTrailerText(key, qualifier) {
  const name = key === "" ? "a trailer" : `a ${qualifier}\`${key}:\` trailer`;
  const hint = /^signed-off-by$/i.test(key) ? ": use `-s`/`--signoff`" : "";
  return `message must have ${name}, including every message commitlint's default ignores skip (${IGNORED_KINDS})${hint}`;
}

const config = await load({}, { file: "commitlint.config.js" });
const parserOptions = config.parserPreset
  ? { parserOpts: config.parserPreset.parserOpts }
  : {};

let result;
try {
  result = await lint(message, config.rules, parserOptions);
} catch (error) {
  fail(
    `could not lint the commit message (commitlint's trailer-exists runs git interpret-trailers; is git on PATH?): ${reason(error)}`,
  );
}

if (!validateForbiddenTrailers(message)) {
  console.error(
    paint(
      process.stderr,
      "danger",
      "commit message carries a forbidden Claude-* trailer (only Co-Authored-By: is allowed)",
    ),
  );
  process.exit(1);
}

if (!result.valid) {
  for (const problem of result.errors) {
    console.error(paint(process.stderr, "danger", `✗ ${problem.message}`));
  }
  process.exit(1);
}

// commitlint's default ignores skip merge/revert/fixup!/squash!/amend! and
// semver release messages entirely, trailer-exists included. Re-run just that
// rule with the ignores off so an enforced trailer is required on every
// message. Only reached when the first lint passed, so a failure is never
// reported twice.
const trailerRule = enforcedTrailerRule(config.rules);
if (trailerRule !== undefined) {
  const key = trailerKey(trailerRule[2]);
  let trailerResult;
  try {
    trailerResult = await lint(
      message,
      { "trailer-exists": trailerRule },
      { defaultIgnores: false, ...parserOptions },
    );
  } catch (error) {
    fail(
      `could not read commit trailers (git interpret-trailers failed): ${reason(error)}`,
    );
  }
  if (!trailerResult.valid) fail(missingTrailerText(key, ""));
  // An empty configured value leaves the decision to commitlint's own rule.
  if (key !== "") {
    let present;
    try {
      present = hasNonEmptyTrailer(message, key);
    } catch (error) {
      fail(
        `could not read commit trailers (git interpret-trailers failed): ${reason(error)}`,
      );
    }
    if (!present) fail(missingTrailerText(key, "non-empty "));
  }
}

console.log(
  paint(
    process.stdout,
    "success",
    "✓ commit message is a valid Conventional Commit",
  ),
);
