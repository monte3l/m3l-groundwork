#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): protects tool-owned artifacts.
 *
 *  - `dist/**` is tsc output and must never be hand-edited.
 *  - `coverage/**` is the vitest v8 coverage report and must never be
 *    hand-edited.
 *
 * Add another generated-output directory to PROTECTED_DIR_NAMES below if
 * this project introduces one (e.g. a bundler's own output dir).
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";

const PROTECTED_DIR_NAMES = ["dist", "coverage"];

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const filePath = input.tool_input?.file_path ?? "";

const hit = PROTECTED_DIR_NAMES.find((name) =>
  new RegExp(`(^|/)${name}/`).test(filePath),
);
if (hit) {
  process.stderr.write(
    `Blocked: \`${hit}/\` is generated output and must never be ` +
      `hand-edited. Change the source and rebuild/retest instead.\n`,
  );
  process.exit(2);
}

process.exit(0);
