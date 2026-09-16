#!/usr/bin/env node
/**
 * `commit-msg`: strips any harness-injected `Claude-*` trailer line from the
 * commit message file in place before `lint-commit.mjs` validates it.
 * `Co-Authored-By:` is never touched -- it is the one trailer this repo
 * wants to keep.
 */
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("strip-claude-trailers: expected a commit-message file path");
  process.exit(1);
}

const text = readFileSync(path, "utf8");
const stripped = text
  .split("\n")
  .filter((line) => !/^Claude-[A-Za-z-]*:/.test(line))
  .join("\n");

if (stripped !== text) {
  writeFileSync(path, stripped);
}
