// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkBounded } from "../../src/survey/fs-walk.js";
import { chmodIneffective } from "../chmod-ineffective.js";

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

  it("skips exactly .claude/worktrees", () => {
    // A background agent's `.claude/worktrees/<name>/` is a full second
    // checkout with its own src/tests trees -- the survey must not walk into
    // it any more than it walks into node_modules or dist. The skip is
    // scoped to this exact relative path, not a bare directory name -- see
    // the next two tests for why that distinction is load-bearing.
    mkdirSync(join(dir, ".claude", "worktrees", "x"), { recursive: true });
    writeFileSync(join(dir, ".claude", "worktrees", "x", "index.ts"), "");
    writeFileSync(join(dir, "kept.ts"), "");

    const entries = walkBounded(dir, 5);
    const relPaths = entries.map((e) => e.relPath).sort();

    // `.claude` itself is a real, non-skipped directory and stays listed;
    // nothing under (or at) `.claude/worktrees` appears at all.
    expect(relPaths).toEqual([".claude", "kept.ts"]);
  });

  // The skip is scoped by exact relative PATH (`.claude/worktrees`), not by
  // bare directory name -- a directory that merely happens to be named
  // "worktrees" elsewhere in the tree is an ordinary directory and must be
  // walked like any other. This guards against a legitimate
  // `src/worktrees/`/`worktrees/` directory in an adopted project silently
  // disappearing from every adopt-mode survey and the harness/toolchain
  // graders.
  it("does NOT skip a directory literally named worktrees outside .claude/", () => {
    mkdirSync(join(dir, "worktrees", "x"), { recursive: true });
    writeFileSync(join(dir, "worktrees", "x", "index.ts"), "");
    mkdirSync(join(dir, "src", "worktrees"), { recursive: true });
    writeFileSync(join(dir, "src", "worktrees", "y.ts"), "");

    const entries = walkBounded(dir, 5);
    const relPaths = entries.map((e) => e.relPath);

    expect(relPaths).toContain("worktrees");
    expect(relPaths).toContain("worktrees/x");
    expect(relPaths).toContain("worktrees/x/index.ts");
    expect(relPaths).toContain("src");
    expect(relPaths).toContain("src/worktrees");
    expect(relPaths).toContain("src/worktrees/y.ts");
  });

  // Same path-scoping guarantee as above, exercised against a plausible
  // real skill name nested under `.claude/skills/` -- only the exact
  // `.claude/worktrees` relative path is skipped, so a skill that happens
  // to be named "worktrees" is walked normally.
  it("does NOT skip .claude/skills/worktrees (a plausible real skill name)", () => {
    mkdirSync(join(dir, ".claude", "skills", "worktrees"), {
      recursive: true,
    });
    writeFileSync(join(dir, ".claude", "skills", "worktrees", "SKILL.md"), "");

    const entries = walkBounded(dir, 5);
    const relPaths = entries.map((e) => e.relPath);

    expect(relPaths).toContain(".claude/skills/worktrees");
    expect(relPaths).toContain(".claude/skills/worktrees/SKILL.md");
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

  // GAP 2: a chmod 000 subdirectory (EACCES, as opposed to simply missing)
  // must not abort the whole walk either -- it is skipped the same way a
  // missing directory is, but unlike a missing directory it is recorded in
  // the caller's `undetermined` array (the entry itself, not just "skipped
  // silently"), since the directory genuinely exists and the caller needs to
  // know its contents could not be indexed.
  it.skipIf(chmodIneffective)(
    "records an unreadable (EACCES) subdirectory in undetermined and keeps walking the rest of the tree",
    () => {
      const locked = join(dir, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "secret.md"), "# secret\n");
      writeFileSync(join(dir, "kept.ts"), "");
      chmodSync(locked, 0o000);

      const undetermined: string[] = [];
      let thrown: unknown;
      let entries: ReturnType<typeof walkBounded> = [];
      try {
        entries = walkBounded(dir, 3, undetermined);
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(locked, 0o755);
      }

      expect(thrown).toBeUndefined();
      const relPaths = entries.map((e) => e.relPath);
      expect(relPaths).toContain("kept.ts");
      expect(relPaths).not.toContain("locked/secret.md");
      expect(
        undetermined.some(
          (entry) => entry.includes(locked) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );
});
