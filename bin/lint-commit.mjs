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
 */
import process from "node:process";
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

const config = await load({}, { file: "commitlint.config.js" });
const result = await lint(
  message,
  config.rules,
  config.parserPreset ? { parserOpts: config.parserPreset.parserOpts } : {},
);

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

console.log("✓ commit message is a valid Conventional Commit");
