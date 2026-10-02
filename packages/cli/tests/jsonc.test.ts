// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodIneffective } from "./chmod-ineffective.js";
import {
  parseJsonc,
  readJsoncFile,
  stripJsComments,
  stripJsoncNoise,
} from "../src/jsonc.js";

// Hoisted to the top level (vitest requires it): defaults to a real
// passthrough so every describe block in this file except the one EIO test
// below exercises the genuine syscall, matching read-guard.test.ts's own
// isolation pattern for the same primitive.
const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, statSync: statSyncMock };
});

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

  /**
   * GAP: `readJsoncFile`'s own existence gate (`if (!existsSync(path))`)
   * runs BEFORE the read it already discriminates EACCES/EPERM against --
   * `existsSync` swallows every `stat` failure (including an ancestor
   * directory's search permission denied) and answers `false` the same as
   * a genuinely missing path. A file that exists but sits under a `chmod
   * 000` directory is therefore reported `"<path> does not exist"` today,
   * identical to a real miss -- the same bug `guardedExists`
   * (`survey/internal/read-guard.ts`) already exists to fix for every other
   * collector. This describe's RED state: today's message says "does not
   * exist"; it must instead name the real reason (EACCES), never claim
   * absence for a path that is actually there.
   */
  describe("a file that exists under a directory this process cannot search (ancestor chmod 000)", () => {
    let lockedDir: string;
    let path: string;

    beforeEach(() => {
      lockedDir = join(dir, "locked");
      mkdirSync(lockedDir);
      path = join(lockedDir, "tsconfig.json");
      writeFileSync(path, '{"compilerOptions": {"strict": true}}');
    });

    afterEach(() => {
      chmodSync(lockedDir, 0o755);
    });

    it.skipIf(chmodIneffective)(
      "never reports 'does not exist' for a file that genuinely exists -- it names the real EACCES reason instead",
      () => {
        chmodSync(lockedDir, 0o000);
        let thrown: unknown;
        let result: ReturnType<typeof readJsoncFile> | undefined;
        try {
          result = readJsoncFile(path);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(lockedDir, 0o755);
        }

        expect(thrown).toBeUndefined();
        expect(result?.ok).toBe(false);
        const message = result?.ok === false ? result.error : "";
        expect(message).not.toContain("does not exist");
        expect(message).toContain("EACCES");
      },
    );
  });

  /**
   * GAP (other half): once the existence gate above is fixed by routing
   * through a guarded check, a non-permission failure on that check (`EIO`)
   * must throw with the path named and the original chained as `cause` --
   * the same contract `readJsoncFile`'s own TSDoc already promises for a
   * `readFileSync` failure. `statSync` is mocked (the primitive the shared
   * `guardedExists` helper uses) rather than `existsSync` -- Node's
   * `existsSync` does not call the exported `statSync` internally, so only
   * mocking the latter is how this reaches the guarded seam once the fix
   * routes through it; until then, this proves the gap by NOT throwing.
   */
  describe("a non-permission failure on the existence check (EIO, mocked)", () => {
    afterEach(() => {
      statSyncMock.mockReset();
    });

    it("throws an Error naming the path, with the original EIO failure chained as cause, rather than reporting ok:false", () => {
      const failure = Object.assign(new Error("simulated EIO"), {
        code: "EIO",
      });
      statSyncMock.mockImplementation(() => {
        throw failure;
      });
      const path = join(dir, "tsconfig.json");
      writeFileSync(path, "{}");

      let thrown: unknown;
      try {
        readJsoncFile(path);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBe(failure);
      expect((thrown as Error).message).toContain(path);
      expect((thrown as Error).cause).toBe(failure);
    });
  });
});
