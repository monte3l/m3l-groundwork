// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 1: `emitTemplate` (`../src/emit.js`) currently writes through a
 * symlink -- `mkdirSync(targetPath, { recursive: true })` follows a
 * symlinked directory component out of `targetDir`, and the plain
 * `writeFileSync` for a text file follows a symlinked destination file and
 * overwrites whatever it points at. New contract: before ANYTHING is
 * written, every destination path the emit would touch (every directory
 * component below `targetDir`, and every destination file) is `lstat`-ed,
 * and the whole emit is refused -- naming the offending path -- if any of
 * them is a symlink or a non-directory where a directory is needed.
 * `targetDir` itself (and its own ancestors) is NOT guarded -- only
 * components strictly below it that the emit itself would create or write
 * through.
 *
 * Mirrors `plugin-symlink.test.ts`'s symlink-refusal conventions:
 * `assertNotSymlink`'s hallmark phrase ("refusing to write through a
 * symlink"), the offending path named verbatim, and -- since this is a
 * fresh-mode-only writer, like `installCustomizeSkill`'s `FRESH_DESTINATION`
 * -- the message must carry fresh mode's single retry instruction
 * ("--fresh --force", exactly once across the whole `cause` chain) and never
 * adopt mode's bare "re-run the CLI" marker, so a caller chaining its own
 * advice on top never doubles or contradicts it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTemplate } from "../src/emit.js";
import { templatesCoreDir } from "../src/main.js";

/** Every message in `thrown`'s own `cause` chain, outermost first, as long as each link is itself an `Error`. */
function errorChainMessages(thrown: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/**
 * Asserts `thrown` is an `Error` naming a refusal at exactly
 * `offendingPath`, carrying fresh mode's ONE consistent retry instruction
 * (the `--fresh --force` marker, exactly once across the whole chain) and
 * never adopt mode's bare "re-run the CLI" -- the same end-anchored,
 * mode-specific convention `plugin-symlink.test.ts`'s
 * `expectSymlinkRefusal` pins for `installCustomizeSkill`.
 */
function expectFreshModeRefusal(thrown: unknown, offendingPath: string): void {
  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain(offendingPath);

  const chain = errorChainMessages(thrown);
  const occurrences = chain.reduce(
    (total, chainMessage) =>
      total + (chainMessage.match(/--fresh --force/g)?.length ?? 0),
    0,
  );
  expect(occurrences).toBe(1);
  for (const chainMessage of chain) {
    expect(chainMessage).not.toMatch(/\bre-run the CLI\b/);
  }
}

describe("emitTemplate symlink/non-directory guard (GAP 1)", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "emit-guard-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "emit-guard-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "emit-guard-outside-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses when a top-level destination directory component is a symlink, writing nothing and leaving the symlink and its outside target untouched", () => {
    mkdirSync(join(sourceDir, ".claude"), { recursive: true });
    writeFileSync(join(sourceDir, ".claude", "settings.json"), "{}");
    writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch\n");
    const symlinkPath = join(targetDir, ".claude");
    symlinkSync(outsideDir, symlinkPath, "dir");

    let thrown: unknown;
    try {
      emitTemplate(sourceDir, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expectFreshModeRefusal(thrown, symlinkPath);
    expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
      "do not touch\n",
    );
    expect(readdirSync(outsideDir).sort()).toEqual(["sentinel.txt"]);
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  });

  it("refuses when a nested (one level deeper) destination directory component is a symlink", () => {
    mkdirSync(join(sourceDir, ".claude", "skills"), { recursive: true });
    writeFileSync(
      join(sourceDir, ".claude", "skills", "SKILL.md"),
      "# skill\n",
    );
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch\n");
    const symlinkPath = join(targetDir, ".claude", "skills");
    symlinkSync(outsideDir, symlinkPath, "dir");

    let thrown: unknown;
    try {
      emitTemplate(sourceDir, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expectFreshModeRefusal(thrown, symlinkPath);
    expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
      "do not touch\n",
    );
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  });

  it("refuses when a deeply-nested destination directory component mirroring a real templates/core path (.claude/skills/typescript-guidance/references) is a symlink, using the real baseline as source", () => {
    writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch\n");
    mkdirSync(join(targetDir, ".claude", "skills", "typescript-guidance"), {
      recursive: true,
    });
    const symlinkPath = join(
      targetDir,
      ".claude",
      "skills",
      "typescript-guidance",
      "references",
    );
    symlinkSync(outsideDir, symlinkPath, "dir");

    let thrown: unknown;
    try {
      emitTemplate(templatesCoreDir(), targetDir, { PROJECT_NAME: "acme" });
    } catch (error) {
      thrown = error;
    }

    expectFreshModeRefusal(thrown, symlinkPath);
    expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
      "do not touch\n",
    );
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    // Nothing from the (large) real baseline was written -- not even an
    // unrelated root-level file the walk would reach well before this path.
    expect(existsSync(join(targetDir, "package.json"))).toBe(false);
  });

  it("refuses when a destination FILE is a symlink to an outside sentinel, leaving the symlink and the sentinel's bytes untouched", () => {
    writeFileSync(join(sourceDir, "config.json"), '{"ok":true}');
    const outsideFile = join(outsideDir, "sentinel.json");
    writeFileSync(outsideFile, "SENTINEL - do not touch\n");
    const destPath = join(targetDir, "config.json");
    symlinkSync(outsideFile, destPath);

    let thrown: unknown;
    try {
      emitTemplate(sourceDir, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expectFreshModeRefusal(thrown, destPath);
    expect(readFileSync(outsideFile, "utf8")).toBe("SENTINEL - do not touch\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(true);
  });

  it("refuses when a destination FILE is a dangling symlink (its target does not exist)", () => {
    writeFileSync(join(sourceDir, "config.json"), '{"ok":true}');
    const destPath = join(targetDir, "config.json");
    symlinkSync(join(outsideDir, "does-not-exist.json"), destPath);

    let thrown: unknown;
    try {
      emitTemplate(sourceDir, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expectFreshModeRefusal(thrown, destPath);
    expect(lstatSync(destPath).isSymbolicLink()).toBe(true);
  });

  it("refuses when a non-directory sits where a destination directory is needed, writing nothing -- including a sibling ordered before it in the source tree", () => {
    // "aaa-safe.txt" sorts (and so would be walked) before "nested" under a
    // naive depth-first copy-as-you-go -- proving the guard precomputes and
    // checks the FULL destination list before the first write, not just the
    // one path a per-entry mkdirSync happens to reach and fail on.
    writeFileSync(join(sourceDir, "aaa-safe.txt"), "safe\n");
    mkdirSync(join(sourceDir, "nested"), { recursive: true });
    writeFileSync(join(sourceDir, "nested", "file.txt"), "hi\n");
    // A plain file, not a directory, already occupies the "nested" path.
    const conflictPath = join(targetDir, "nested");
    writeFileSync(conflictPath, "i am a file, not a directory\n");

    let thrown: unknown;
    try {
      emitTemplate(sourceDir, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(conflictPath);
    expect(readFileSync(conflictPath, "utf8")).toBe(
      "i am a file, not a directory\n",
    );
    expect(existsSync(join(targetDir, "aaa-safe.txt"))).toBe(false);
  });

  it("validates every destination path up front: a sibling file ordered before the offending path in the source tree is still never written, and the symlinked destination is never written through", () => {
    // "aaa-safe.txt" sorts (and so would be walked) before the symlinked
    // "zzz-conflict.txt" under a naive depth-first copy-as-you-go -- proving
    // the guard precomputes and checks the FULL destination list before the
    // first write, not just the one path it happens to reach. Without the
    // guard, emitTemplate writes "aaa-safe.txt" first, then silently writes
    // THROUGH the symlink (no throw at all) and corrupts the outside
    // sentinel -- see this test's RED run.
    writeFileSync(join(sourceDir, "aaa-safe.txt"), "safe\n");
    writeFileSync(join(sourceDir, "zzz-conflict.txt"), "conflict\n");
    writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch\n");
    const destPath = join(targetDir, "zzz-conflict.txt");
    symlinkSync(join(outsideDir, "sentinel.txt"), destPath);

    expect(() => emitTemplate(sourceDir, targetDir, {})).toThrow();

    expect(existsSync(join(targetDir, "aaa-safe.txt"))).toBe(false);
    expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
      "do not touch\n",
    );
    expect(lstatSync(destPath).isSymbolicLink()).toBe(true);
  });

  it("does not guard targetDir itself: a symlinked targetDir still succeeds, writing through to its real location", () => {
    writeFileSync(join(sourceDir, "package.json"), '{"name":"acme"}');
    const realTarget = mkdtempSync(join(tmpdir(), "emit-guard-real-target-"));
    const symlinkedTarget = join(targetDir, "project-link");
    symlinkSync(realTarget, symlinkedTarget, "dir");

    try {
      const result = emitTemplate(sourceDir, symlinkedTarget, {});

      expect(result.filesWritten).toEqual(["package.json"]);
      expect(readFileSync(join(realTarget, "package.json"), "utf8")).toBe(
        '{"name":"acme"}',
      );
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
    }
  });
});
