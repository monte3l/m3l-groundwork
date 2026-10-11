#!/usr/bin/env node
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
 * An empty message (direct mode with no arguments) is accepted by commitlint
 * itself, so it passes here unless an enforced `trailer-exists` rule rejects
 * it. git runs the `commit-msg` hook before it rejects an empty message, and
 * `--allow-empty-message` lets one through, so `--edit` mode can see one too.
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
 * Every failure -- an unreadable or missing `--edit` file, a missing or
 * unparseable `commitlint.config.js` or one that defines no rules, a
 * forbidden trailer, a rule violation,
 * a thrown error from commitlint, or a missing `git` (which `trailer-exists`
 * shells out to) -- prints `✗`-prefixed line(s) to stderr (one per problem)
 * and exits 1, never a stack trace.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import load from "@commitlint/load";
import lint from "@commitlint/lint";

const args = process.argv.slice(2);
const editIndex = args.indexOf("--edit");

const FORBIDDEN_TRAILER = /^Claude-(?!Session:)[A-Za-z-]*:/m;

function validateForbiddenTrailers(text) {
  return !FORBIDDEN_TRAILER.test(text) && !/^Claude-Session:/m.test(text);
}

/**
 * Prints one `✗` line to stderr and exits 1.
 */
function fail(text) {
  console.error(`✗ ${text}`);
  process.exit(1);
}

/**
 * The first non-empty line of an error's message, so one failure prints as
 * one `✗` line even when commitlint throws a multi-line message.
 */
function reason(error) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? text
  );
}

/**
 * Whether a thrown error is a failure to run `git` (which commitlint's
 * `trailer-exists` shells out to), as opposed to a config or rule error.
 * commitlint does not check its spawn result, so a missing `git` surfaces as
 * an unrelated `TypeError`; probing `git --version` settles it directly.
 */
function isGitFailure(error) {
  const code =
    typeof error === "object" && error !== null ? error.code : undefined;
  if (code === "ENOENT") return true;
  if (/\bgit\b/.test(error instanceof Error ? error.message : String(error))) {
    return true;
  }
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  return probe.error !== undefined || probe.status !== 0;
}

/**
 * The failure text for an error thrown by commitlint's `lint`: the git hint
 * only when `git` itself could not run, else the plain reason.
 */
function lintFailureText(error, gitContext) {
  return isGitFailure(error)
    ? `${gitContext}: ${reason(error)}`
    : `could not lint the commit message: ${reason(error)}`;
}

/**
 * The commit message: the `--edit` file's content, else the joined args.
 * A missing path or an unreadable file is reported through `fail`.
 */
function readMessage() {
  if (editIndex === -1) return args.join(" ");
  const path = args[editIndex + 1];
  // fail() exits the process; it never returns.
  if (path === undefined) fail("--edit needs a path");
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`could not read the commit message file ${path}: ${reason(error)}`);
  }
}

const message = readMessage();

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

let config;
try {
  config = await load({}, { file: "commitlint.config.js" });
} catch (error) {
  fail(`could not load commitlint.config.js: ${reason(error)}`);
}
// @commitlint/cli rejects an empty rule set the same way: a config whose
// `extends` resolved to nothing would otherwise pass every message.
if (Object.keys(config.rules ?? {}).length === 0) {
  fail(
    "commitlint.config.js loaded but defines no rules (check its `extends`)",
  );
}
const parserOptions = config.parserPreset
  ? { parserOpts: config.parserPreset.parserOpts }
  : {};

let result;
try {
  result = await lint(message, config.rules, parserOptions);
} catch (error) {
  fail(
    lintFailureText(
      error,
      "could not lint the commit message (commitlint's trailer-exists runs git interpret-trailers; is git on PATH?)",
    ),
  );
}

if (!validateForbiddenTrailers(message)) {
  fail(
    "commit message carries a forbidden Claude-* trailer (only Co-Authored-By: is allowed)",
  );
}

if (!result.valid) {
  for (const problem of result.errors) {
    console.error(`✗ ${problem.message}`);
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
      lintFailureText(
        error,
        "could not read commit trailers (git interpret-trailers failed)",
      ),
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

console.log("✓ commit message is a valid Conventional Commit");
