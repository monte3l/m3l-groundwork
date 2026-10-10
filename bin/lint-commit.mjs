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
 * When the config enables `trailer-exists`, the trailer is also required on
 * messages commitlint's default ignores skip (merge, revert, `fixup!`,
 * `squash!`): a local merge or revert needs `git merge --signoff` /
 * `git revert --signoff` too.
 */
import process from "node:process";
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
 * The trailer `trailer-exists` requires, or `undefined` when the loaded
 * config does not enable it. A rule entry is `[severity, applicable, value]`
 * or a (possibly async) function resolving to one.
 */
async function requiredTrailer(rules) {
  let entry = rules?.["trailer-exists"];
  if (typeof entry === "function") entry = await entry();
  if (!Array.isArray(entry)) return undefined;
  const [severity, applicable, value] = entry;
  if (typeof severity !== "number" || severity <= 0) return undefined;
  if (applicable === "never") return undefined;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : "Signed-off-by:";
}

function hasTrailer(text, trailer) {
  const escaped = trailer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}[ \\t]*\\S`, "m").test(text);
}

const config = await load({}, { file: "commitlint.config.js" });
const result = await lint(
  message,
  config.rules,
  config.parserPreset ? { parserOpts: config.parserPreset.parserOpts } : {},
);

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

const trailer = await requiredTrailer(config.rules);
if (trailer !== undefined && !hasTrailer(message, trailer)) {
  console.error(
    paint(
      process.stderr,
      "danger",
      `✗ commit message must have a non-empty \`${trailer}\` trailer (use \`git commit -s\`, \`git merge --signoff\` or \`git revert --signoff\`)`,
    ),
  );
  process.exit(1);
}

console.log(
  paint(
    process.stdout,
    "success",
    "✓ commit message is a valid Conventional Commit",
  ),
);
