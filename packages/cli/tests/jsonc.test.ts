import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc, readJsoncFile, stripJsoncNoise } from "../src/jsonc.js";

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
