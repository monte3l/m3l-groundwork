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
 *
 * When the config enables `trailer-exists` as an error (severity 2), the
 * trailer, with a non-empty value, is also required on messages commitlint's
 * default ignores skip (merge, revert, `fixup!`, `squash!`): a local merge or
 * revert needs `git merge --signoff` / `git revert --signoff` too.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import load from "@commitlint/load";
import lint from "@commitlint/lint";

const args = process.argv.slice(2);
const editIndex = args.indexOf("--edit");
const message =
  editIndex === -1 ? args.join(" ") : readFileSync(args[editIndex + 1], "utf8");

const FORBIDDEN_TRAILER = /^Claude-(?!Session:)[A-Za-z-]*:/m;

function validateForbiddenTrailers(text) {
  return !FORBIDDEN_TRAILER.test(text) && !/^Claude-Session:/m.test(text);
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
 * Whether the message's trailer block (as `git interpret-trailers --parse`
 * reads it, the same parse commitlint's `trailer-exists` uses) holds a
 * `prefix` trailer with a non-empty value. commitlint only checks the
 * prefix, so an empty `Signed-off-by:` would otherwise pass. A failed `git`
 * call counts as missing (fail closed).
 */
function hasNonEmptyTrailer(text, prefix) {
  const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
    input: text,
    encoding: "utf8",
  });
  if (parsed.error !== undefined || parsed.status !== 0) return false;
  return parsed.stdout
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith(prefix) && line.slice(prefix.length).trim() !== "",
    );
}

const config = await load({}, { file: "commitlint.config.js" });
const parserOptions = config.parserPreset
  ? { parserOpts: config.parserPreset.parserOpts }
  : {};
const result = await lint(message, config.rules, parserOptions);

if (!validateForbiddenTrailers(message)) {
  console.error(
    "commit message carries a forbidden Claude-* trailer (only Co-Authored-By: is allowed)",
  );
  process.exit(1);
}

if (!result.valid) {
  for (const problem of result.errors) {
    console.error(`✗ ${problem.message}`);
  }
  process.exit(1);
}

// commitlint's default ignores skip merge/revert/fixup!/squash! messages
// entirely, trailer-exists included. Re-run just that rule with the ignores
// off so an enforced trailer is required on every message. Only reached when
// the first lint passed, so a failure is never reported twice.
const trailerRule = enforcedTrailerRule(config.rules);
if (trailerRule !== undefined) {
  const trailerResult = await lint(
    message,
    { "trailer-exists": trailerRule },
    { defaultIgnores: false, ...parserOptions },
  );
  if (!trailerResult.valid) {
    for (const problem of trailerResult.errors) {
      console.error(
        `✗ ${problem.message} (merge, revert and fixup! messages too: use \`-s\`/\`--signoff\`)`,
      );
    }
    process.exit(1);
  }
  const trailerValue = String(trailerRule[2] ?? "");
  if (!hasNonEmptyTrailer(message, trailerValue)) {
    console.error(
      `✗ message must have a non-empty \`${trailerValue}\` trailer`,
    );
    process.exit(1);
  }
}

console.log("✓ commit message is a valid Conventional Commit");
