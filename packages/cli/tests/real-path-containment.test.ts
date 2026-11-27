// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Containment is decided on real paths, not only on strings: a symlinked
 * directory below the root must not carry a destination out of it, and a
 * root reached through a symlink (macOS `/tmp`) must still work.
 */
import { AssertionError } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPathContained } from "../src/emit.js";
import { resolveRealPath } from "../src/fs-guard.js";
import { assertAdoptWriteScope } from "../src/write-scope.js";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "real-containment-")));
  root = join(base, "app");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveRealPath", () => {
  it("resolves a missing path from its longest existing prefix", () => {
    expect(resolveRealPath(join(root, "a", "b", "c.txt"))).toBe(
      join(root, "a", "b", "c.txt"),
    );
  });

  it("follows a symlinked directory and appends the missing remainder", () => {
    symlinkSync(outside, join(root, "link"));
    expect(resolveRealPath(join(root, "link", "new", "f"))).toBe(
      join(outside, "new", "f"),
    );
  });

  it("answers undefined for a dangling symlink", () => {
    symlinkSync(join(outside, "nope"), join(root, "dangling"));
    expect(resolveRealPath(join(root, "dangling"))).toBeUndefined();
    expect(resolveRealPath(join(root, "dangling", "x"))).toBeUndefined();
  });

  it("answers undefined for a symlink loop", () => {
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(resolveRealPath(join(root, "a", "x"))).toBeUndefined();
  });
});

describe("isPathContained", () => {
  it("accepts a path inside the root, existing or not", () => {
    writeFileSync(join(root, "f"), "x");
    expect(isPathContained(join(root, "f"), root)).toBe(true);
    expect(isPathContained(join(root, "new", "f"), root)).toBe(true);
    expect(isPathContained(root, root)).toBe(true);
  });

  it("accepts a symlink that stays inside the root", () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    expect(isPathContained(join(root, "alias", "f"), root)).toBe(true);
  });

  it("refuses a path under a symlinked directory that leaves the root", () => {
    symlinkSync(outside, join(root, "link"));
    expect(isPathContained(join(root, "link", "f"), root)).toBe(false);
    expect(isPathContained(join(root, "link"), root)).toBe(false);
  });

  it("refuses a file symlink to an outside file", () => {
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(root, "f"));
    expect(isPathContained(join(root, "f"), root)).toBe(false);
  });

  it("refuses a dangling symlink, which a write would create at its target", () => {
    symlinkSync(join(outside, "not-yet"), join(root, "f"));
    expect(isPathContained(join(root, "f"), root)).toBe(false);
  });

  it("still refuses the lexical escapes it always refused", () => {
    expect(isPathContained(join(root, "..", "outside", "f"), root)).toBe(false);
    expect(isPathContained(`${root}-evil/f`, root)).toBe(false);
  });
});

describe("assertAdoptWriteScope on a real tree", () => {
  it("accepts a destination under real .groundwork and .claude/skills/customize", () => {
    mkdirSync(join(root, ".groundwork"));
    expect(() => {
      assertAdoptWriteScope(root, [
        ".groundwork/inventory.json",
        ".claude/skills/customize/SKILL.md",
      ]);
    }).not.toThrow();
  });

  it("accepts a target directory reached through a symlink", () => {
    const alias = join(base, "alias");
    symlinkSync(root, alias);
    expect(() => {
      assertAdoptWriteScope(alias, [".groundwork/inventory.json"]);
    }).not.toThrow();
  });

  it("refuses a .groundwork that is a symlink out of the project", () => {
    symlinkSync(outside, join(root, ".groundwork"));
    expect(() => {
      assertAdoptWriteScope(root, [".groundwork/inventory.json"]);
    }).toThrow(AssertionError);
  });

  it("refuses a .claude/skills that is a symlink out of the project", () => {
    mkdirSync(join(root, ".claude"));
    symlinkSync(outside, join(root, ".claude", "skills"));
    expect(() => {
      assertAdoptWriteScope(root, [".claude/skills/customize/SKILL.md"]);
    }).toThrow(AssertionError);
  });

  it("refuses a destination that is a dangling symlink", () => {
    mkdirSync(join(root, ".groundwork"));
    symlinkSync(
      join(outside, "x"),
      join(root, ".groundwork", "inventory.json"),
    );
    expect(() => {
      assertAdoptWriteScope(root, [".groundwork/inventory.json"]);
    }).toThrow(AssertionError);
  });
});
