// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `lock.ts`: the base record fresh mode writes (`.groundwork/groundwork.lock.json`)
 * so a later update has a three-way base. `buildLock` sorts, `serializeLock`
 * is line-per-field JSON, `parseLock` is strict, `readLock` is lenient and
 * never throws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_DIR,
  BASE_SUFFIX,
  LOCK_FILE,
  LOCK_SCHEMA_VERSION,
  buildLock,
  parseLock,
  readLock,
  serializeLock,
} from "../src/lock.js";
import type { Lock, LockFile } from "../src/lock.js";

const SHA_A = "a".repeat(64);
const SHA_B = "0123456789abcdef".repeat(4);

function entry(path: string, overrides: Partial<LockFile> = {}): LockFile {
  return {
    path,
    source: "core",
    baseSha256: SHA_A,
    status: "installed",
    ...overrides,
  };
}

function validLock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "m3l-groundwork/lock",
    baseVersion: "1.5.0",
    origin: "fresh",
    tokens: { PROJECT_NAME: "acme", YEAR: "2026" },
    via: "fresh",
    updatedAt: "2026-11-26T00:00:00.000Z",
    skip: ["README.md"],
    files: [entry("a.txt"), entry("b/c.txt", { source: "pack:quality" })],
    ...overrides,
  };
}

function parseValue(value: unknown): Lock {
  return parseLock(JSON.stringify(value));
}

describe("constants", () => {
  it("names the lock file, base directory, suffix and schema version", () => {
    expect(LOCK_FILE).toBe(".groundwork/groundwork.lock.json");
    expect(BASE_DIR).toBe(".groundwork/base");
    expect(BASE_SUFFIX).toBe(".base");
    expect(LOCK_SCHEMA_VERSION).toBe(1);
  });
});

describe("buildLock", () => {
  it("builds a schema-1 lock and sorts files by path", () => {
    const lock = buildLock({
      baseVersion: "1.5.0",
      origin: "fresh",
      tokens: { PROJECT_NAME: "acme" },
      via: "fresh",
      updatedAt: "2026-11-26T00:00:00.000Z",
      skip: ["README.md"],
      files: [entry("z.txt"), entry("a.txt"), entry("m/n.txt")],
    });
    expect(lock.schemaVersion).toBe(1);
    expect(lock.kind).toBe("m3l-groundwork/lock");
    expect(lock.baseVersion).toBe("1.5.0");
    expect(lock.origin).toBe("fresh");
    expect(lock.via).toBe("fresh");
    expect(lock.skip).toEqual(["README.md"]);
    expect(lock.files.map((f) => f.path)).toEqual([
      "a.txt",
      "m/n.txt",
      "z.txt",
    ]);
  });
});

describe("serializeLock", () => {
  const lock = parseValue(validLock());

  it("is JSON.stringify(lock, null, 2) plus a trailing newline", () => {
    expect(serializeLock(lock)).toBe(`${JSON.stringify(lock, null, 2)}\n`);
  });

  it("is deterministic and orders keys schemaVersion..files", () => {
    expect(serializeLock(lock)).toBe(serializeLock(lock));
    expect(Object.keys(JSON.parse(serializeLock(lock)) as object)).toEqual([
      "schemaVersion",
      "kind",
      "baseVersion",
      "origin",
      "tokens",
      "via",
      "updatedAt",
      "skip",
      "files",
    ]);
  });

  it("never puts a path and a 64-hex digest on one line (gitleaks)", () => {
    const text = serializeLock(lock);
    for (const line of text.split("\n")) {
      expect(line.includes('"path"') && /[0-9a-f]{64}/.test(line)).toBe(false);
    }
    expect(text).toContain(SHA_A);
  });
});

describe("parseLock", () => {
  it("round-trips a valid lock, including null digests and every status", () => {
    const value = validLock({
      files: [
        entry("a", { status: "kept" }),
        entry("b", { baseSha256: null, status: "removed" }),
        entry("c", { source: "skill", status: "declined" }),
        entry("d", { baseSha256: SHA_B }),
      ],
    });
    const lock = parseValue(value);
    expect(lock).toEqual(value);
    expect(parseLock(serializeLock(lock))).toEqual(lock);
  });

  it("throws an Error (not a SyntaxError-less crash) on invalid JSON", () => {
    expect(() => parseLock("{nope")).toThrow(Error);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "lock"],
    ["a number", 1],
  ])("rejects a non-object top level (%s)", (_l, value) => {
    expect(() => parseValue(value)).toThrow(Error);
  });

  it.each([
    ["wrong kind", { kind: "other" }],
    ["missing kind", { kind: undefined }],
    ["schemaVersion 0", { schemaVersion: 0 }],
    ["a higher schemaVersion", { schemaVersion: 2 }],
    ["a string schemaVersion", { schemaVersion: "1" }],
    ["a bad origin", { origin: "bogus" }],
    ["non-string baseVersion", { baseVersion: 1 }],
    ["non-string via", { via: 1 }],
    ["non-string updatedAt", { updatedAt: 1 }],
    ["tokens that are an array", { tokens: [] }],
    ["a non-string token value", { tokens: { YEAR: 2026 } }],
    ["files that is not an array", { files: {} }],
    ["skip that is not an array", { skip: "README.md" }],
    ["a non-string skip entry", { skip: [1] }],
    ["an absolute skip path", { skip: ["/etc/passwd"] }],
    ["a skip path with ..", { skip: ["a/../b"] }],
  ])("rejects %s", (_l, overrides) => {
    expect(() => parseValue(validLock(overrides))).toThrow(Error);
  });

  it.each([
    ["null", null],
    ["a string", "a.txt"],
    ["an array", []],
    ["a number", 1],
  ])("rejects a files entry that is %s", (_l, item) => {
    expect(() => parseValue(validLock({ files: [item as never] }))).toThrow(
      /files\[0\] must be an object/,
    );
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["empty", ""],
    ["dot", "."],
    ["parent", ".."],
    ["a .. segment", "a/../b"],
    ["a leading ..", "../x"],
    ["a backslash", "a\\b"],
    ["a colon", "C:x"],
  ])("rejects a file path that is %s", (_l, path) => {
    expect(() => parseValue(validLock({ files: [entry(path)] }))).toThrow(
      Error,
    );
  });

  it("rejects duplicate file paths", () => {
    expect(() =>
      parseValue(validLock({ files: [entry("a"), entry("a")] })),
    ).toThrow(Error);
  });

  it.each([
    "other",
    "pack:",
    "pack:a/b",
    "pack:..",
    "pack:A B",
    "Core",
    "pack",
  ])("rejects the unknown source %j", (source) => {
    expect(() =>
      parseValue(validLock({ files: [entry("a", { source })] })),
    ).toThrow(Error);
  });

  it.each(["core", "skill", "pack:quality", "pack:claude-github"])(
    "accepts the source %s",
    (source) => {
      expect(() =>
        parseValue(validLock({ files: [entry("a", { source })] })),
      ).not.toThrow();
    },
  );

  it("rejects an unknown status", () => {
    expect(() =>
      parseValue(
        validLock({ files: [entry("a", { status: "weird" as never })] }),
      ),
    ).toThrow(Error);
  });

  it.each([
    ["uppercase hex", "A".repeat(64)],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
    ["a number", 5],
    ["an empty string", ""],
  ])("rejects a baseSha256 that is %s", (_l, baseSha256) => {
    expect(() =>
      parseValue(
        validLock({ files: [entry("a", { baseSha256: baseSha256 as never })] }),
      ),
    ).toThrow(Error);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects a prototype-sensitive key %s anywhere",
    (key) => {
      const base = JSON.stringify(validLock());
      const top = base.replace(/^\{/, `{${JSON.stringify(key)}:1,`);
      expect(() => parseLock(top)).toThrow(Error);
      const inTokens = JSON.stringify(validLock()).replace(
        '"tokens":{',
        `"tokens":{${JSON.stringify(key)}:"x",`,
      );
      expect(() => parseLock(inTokens)).toThrow(Error);
      const inFile = JSON.stringify(validLock()).replace(
        '"files":[{',
        `"files":[{${JSON.stringify(key)}:1,`,
      );
      expect(() => parseLock(inFile)).toThrow(Error);
    },
  );
});

describe("readLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lock-read-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLockFile(text: string): void {
    mkdirSync(join(dir, ".groundwork"), { recursive: true });
    writeFileSync(join(dir, LOCK_FILE), text);
  }

  it("returns { absent: true } when there is no lock (or no .groundwork)", () => {
    expect(readLock(dir)).toEqual({ absent: true });
    mkdirSync(join(dir, ".groundwork"));
    expect(readLock(dir)).toEqual({ absent: true });
  });

  it("returns the parsed lock", () => {
    const lock = parseValue(validLock());
    writeLockFile(serializeLock(lock));
    expect(readLock(dir)).toEqual({ lock });
  });

  it("returns a note naming the relative path for invalid content, without throwing", () => {
    writeLockFile("{nope");
    const result = readLock(dir);
    expect(result).toHaveProperty("note");
    expect((result as { note: string }).note).toContain(LOCK_FILE);
  });

  it("returns a note for a higher schemaVersion", () => {
    writeLockFile(JSON.stringify(validLock({ schemaVersion: 2 })));
    expect(readLock(dir)).toHaveProperty("note");
  });

  it("returns a note for a symlinked lock file", () => {
    mkdirSync(join(dir, ".groundwork"));
    const real = join(dir, "real.json");
    writeFileSync(real, serializeLock(parseValue(validLock())));
    symlinkSync(real, join(dir, LOCK_FILE));
    const result = readLock(dir);
    expect(result).toHaveProperty("note");
    expect((result as { note: string }).note).toContain(LOCK_FILE);
  });

  it("returns a note for a symlinked .groundwork directory", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(
      join(elsewhere, "groundwork.lock.json"),
      serializeLock(parseValue(validLock())),
    );
    symlinkSync(elsewhere, join(dir, ".groundwork"));
    expect(readLock(dir)).toHaveProperty("note");
  });

  it("returns a note when the lock path is a directory", () => {
    mkdirSync(join(dir, LOCK_FILE), { recursive: true });
    expect(readLock(dir)).toHaveProperty("note");
  });
});

describe("parseLock on invalid JSON", () => {
  const text = '{"secret-marker-123": nope';

  function capture(): Error {
    try {
      parseLock(text);
    } catch (error) {
      return error as Error;
    }
    throw new Error("parseLock did not throw");
  }

  it("does not chain the raw JSON parser error", () => {
    expect(capture().cause).not.toBeInstanceOf(SyntaxError);
  });

  it("never echoes the invalid text in its message", () => {
    expect(capture().message).not.toContain("secret-marker-123");
  });
});
