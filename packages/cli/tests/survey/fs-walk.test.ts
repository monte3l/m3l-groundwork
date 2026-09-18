import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkBounded } from "../../src/survey/fs-walk.js";

describe("walkBounded", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "walk-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists files and directories under the root", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export {};");
    writeFileSync(join(dir, "readme.md"), "hi");

    const entries = walkBounded(dir, 5);
    const relPaths = entries.map((e) => e.relPath).sort();

    expect(relPaths).toEqual(["readme.md", "src", "src/index.ts"]);
  });

  it("skips node_modules and other dependency/build directories", () => {
    mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "some-pkg", "index.js"), "");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.js"), "");
    writeFileSync(join(dir, "kept.ts"), "");

    const entries = walkBounded(dir, 5);
    const relPaths = entries.map((e) => e.relPath);

    expect(relPaths).toEqual(["kept.ts"]);
  });

  it("stops descending past maxDepth", () => {
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "deep.ts"), "");

    const entries = walkBounded(dir, 1);
    const relPaths = entries.map((e) => e.relPath).sort();

    // depth 0 = "a", depth 1 = "a/b" -- "a/b/c" is depth 2, excluded.
    expect(relPaths).toEqual(["a", "a/b"]);
  });

  it("skips an unreadable/missing directory rather than throwing", () => {
    const missing = join(dir, "does-not-exist");
    expect(walkBounded(missing, 3)).toEqual([]);
  });
});
