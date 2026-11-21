// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// CodeQL reports a `stat` (or `existsSync`) followed by a read of the same path
// as a file-system race (js/file-system-race), and every bootstrapped project
// inherits the alert from the emitted twin. A race cannot be reproduced from a
// test, so this pins the property that caused it: the emitted `readJsonc`
// reads the file and lets the read report the errno, with no check before it.
// Behaviour for a missing, unreadable or unsearchable path is already pinned
// by toolchain-parity.test.ts, which runs both twins over the same fixtures.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const emitted = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "core",
  "bin",
  "lib",
  "toolchain-rules.mjs",
);

/** The source of `function name(...) { ... }`, up to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(`function ${name} not found`);
  }
  const end = source.indexOf("\n}\n", start);
  if (end === -1) {
    throw new Error(`function ${name} has no closing brace at column 0`);
  }
  return source.slice(start, end + 2);
}

/** The code of a function body without its comments, so prose cannot trip a check. */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the emitted toolchain rules' readJsonc", () => {
  const source = readFileSync(emitted, "utf8");
  const code = withoutComments(functionBody(source, "readJsonc"));

  it("reads the file", () => {
    expect(code).toContain("readFileSync(");
  });

  it.each(["statSync(", "lstatSync(", "existsSync(", "accessSync("])(
    "does not call %s before it reads",
    (call) => {
      expect(code).not.toContain(call);
    },
  );
});
