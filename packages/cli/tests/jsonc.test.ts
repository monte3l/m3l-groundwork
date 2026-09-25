// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJsonc,
  readJsoncFile,
  stripJsComments,
  stripJsoncNoise,
} from "../src/jsonc.js";

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("strips line comments", () => {
    const result = parseJsonc('{\n  // a comment\n  "a": 1\n}');
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("strips block comments", () => {
    const result = parseJsonc('{ /* block */ "a": 1 }');
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("strips trailing commas in objects and arrays", () => {
    const result = parseJsonc('{"a": [1, 2,], "b": 3,}');
    expect(result).toEqual({ ok: true, value: { a: [1, 2], b: 3 } });
  });

  it("leaves a // inside a string literal untouched", () => {
    const result = parseJsonc('{"url": "https://example.com"}');
    expect(result).toEqual({ ok: true, value: { url: "https://example.com" } });
  });

  it("handles an escaped quote inside a string", () => {
    const result = parseJsonc('{"a": "quote: \\" done"}');
    expect(result).toEqual({ ok: true, value: { a: 'quote: " done' } });
  });

  it("reports a parse failure instead of throwing", () => {
    const result = parseJsonc("{not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });
});

describe("stripJsoncNoise", () => {
  it("removes comments without touching structure", () => {
    expect(stripJsoncNoise('{"a":1 // trailing\n}')).toBe('{"a":1 \n}');
  });

  it("[regression pin] keeps its documented JSON-only contract: // and block comments plus a trailing comma inside a double-quoted string are unaffected", () => {
    // Pins today's behavior for stripJsoncNoise's actual use case (tsconfig,
    // package.json) so a botched split into stripJsComments does not
    // silently change the JSON-only path.
    const input =
      '{\n  // a line comment\n  "a": /* inline */ 1,\n  "b": "no // comment here",\n}';
    const result = parseJsonc(input);
    expect(result).toEqual({
      ok: true,
      value: { a: 1, b: "no // comment here" },
    });
  });

  // Demonstrates the pre-existing bug stripJsComments must not repeat:
  // stripJsoncNoise only tracks `"` as a string delimiter, so a `//` inside a
  // single-quoted string is misread as a real comment. This assertion
  // currently PASSES -- it pins the bug, it does not prove a fix.
  it("[demonstrates the bug stripJsComments must not repeat] corrupts a single-quoted string containing //", () => {
    const input = "const x = 'https://example.com';";
    expect(stripJsoncNoise(input)).not.toBe(input);
    expect(stripJsoncNoise(input)).toBe("const x = 'https:");
  });
});

describe("stripJsComments", () => {
  it("leaves a single-quoted string containing // untouched", () => {
    const input = "const x = 'https://example.com';";
    expect(stripJsComments(input)).toBe(input);
  });

  it("leaves a single-quoted string containing /* untouched", () => {
    const input = "const ignore = ['dist/**', 'node_modules/**'];";
    expect(stripJsComments(input)).toBe(input);
  });

  it("strips a real // line comment outside any string", () => {
    const input = "const x = 1; // comment\nconst y = 2;";
    expect(stripJsComments(input)).toBe("const x = 1; \nconst y = 2;");
  });

  it("strips a real block comment outside any string", () => {
    const input = "const x = /* inline */ 1;";
    expect(stripJsComments(input)).toBe("const x =  1;");
  });

  it("leaves a double-quoted string containing // or /* untouched", () => {
    const input = 'const x = "https://example.com/*not-a-comment*/";';
    expect(stripJsComments(input)).toBe(input);
  });

  it("leaves a backtick template literal containing // untouched", () => {
    const input = "const url = `//example.com/${path}`;";
    expect(stripJsComments(input)).toBe(input);
  });

  it("does not strip a trailing comma -- that cleanup is JSON-only", () => {
    const input = "[1, 2, 3,]";
    expect(stripJsComments(input)).toBe(input);
  });
});

describe("readJsoncFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jsonc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses an existing file", () => {
    const path = join(dir, "tsconfig.json");
    writeFileSync(path, '{"compilerOptions": {"strict": true}}');
    expect(readJsoncFile(path)).toEqual({
      ok: true,
      value: { compilerOptions: { strict: true } },
    });
  });

  it("reports a missing file rather than throwing", () => {
    const result = readJsoncFile(join(dir, "missing.json"));
    expect(result.ok).toBe(false);
  });
});
