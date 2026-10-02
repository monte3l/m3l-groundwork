// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `classifyExistingSkill` (`../src/plugin.js`) treats a payload name it
 * cannot `lstat` and one it cannot READ differently, depending on which
 * policy is asking:
 *
 * - `unreadable: "not-current"` (fresh mode's `installCustomizeSkill`,
 *   `"overwrite"` policy): an existing `SKILL.md` that `lstat` already
 *   confirmed is a plain regular file, but cannot actually be read
 *   (`EACCES` and similar), is treated as "not current" -- the same as a
 *   byte-for-byte mismatch -- rather than refusing the install. Fresh mode
 *   proceeds to remove and rewrite it, same as any other stale copy, since
 *   "overwrite" already owns replacing whatever sits there.
 * - `unreadable: "refuse"` (adopt mode's `installCustomizeSkillGuarded`,
 *   `"additive"` policy): the same unreadable regular file instead refuses
 *   the whole install ("could not read ...", the raw error as `cause`,
 *   nothing removed or written) -- adopt mode never guesses at a project
 *   entry it cannot actually compare.
 *
 * An `lstat` failure against the same entry (its very nature unknown, not
 * just its content) is a separate concern and refuses the install under
 * EITHER policy -- see `plugin-rollback.test.ts`'s "a pre-flight lstat
 * failure refuses a replacing-policy install" suite, which this test does
 * not duplicate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";
import { CUSTOMIZE_SKILL_FILE_NAMES } from "../src/customize-paths.js";

/** A root process ignores file permission bits entirely, and Windows has no
 * POSIX chmod semantics -- neither can produce the EACCES these tests rely
 * on, so every test in this file skips rather than asserting a false
 * positive. */
const skipUnlessChmodWorks =
  process.getuid?.() === 0 || process.platform === "win32";

/** The same five-file payload fixture plugin.test.ts/plugin-install.test.ts use. */
function writeSourceFixture(sourceDir: string): void {
  mkdirSync(join(sourceDir, "skills", "customize"), { recursive: true });
  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(
    join(sourceDir, "skills", "customize", "SKILL.md"),
    "---\nname: customize\n---\n# customize\n",
  );
  writeFileSync(
    join(sourceDir, "src", "kind-facet-map.ts"),
    "export const x = 1;\n",
  );
  writeFileSync(
    join(sourceDir, "src", "domain-map.ts"),
    "export const y = 2;\n",
  );
  writeFileSync(join(sourceDir, "src", "pack-map.ts"), "export const z = 3;\n");
  writeFileSync(
    join(sourceDir, "src", "plugin-map.ts"),
    "export const w = 4;\n",
  );
}

describe("an unreadable existing SKILL.md at the fresh-mode destination is treated as not current, not refused", () => {
  let sourceDir: string;
  let targetDir: string;
  let skillMdDest: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-existing-unreadable-src-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-existing-unreadable-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    skillMdDest = join(destDir, "SKILL.md");
    writeFileSync(
      skillMdDest,
      "---\nname: customize\n---\n# stale, unreadable\n",
    );
  });

  afterEach(() => {
    // Restore read permission before cleanup for hygiene -- unlink itself
    // only needs permission on the parent directory, not the target file,
    // so this isn't strictly required for rmSync below to succeed, but a
    // left-behind 0o000 file is still bad practice on a shared temp dir.
    // Only if it's still there: a successful install removes and rewrites
    // it under a brand-new mode.
    if (existsSync(skillMdDest)) {
      chmodSync(skillMdDest, 0o644);
    }
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it.skipIf(skipUnlessChmodWorks)(
    "removes and rewrites it rather than refusing the whole install",
    () => {
      chmodSync(skillMdDest, 0o000);

      let thrown: unknown;
      let result: { filesWritten: string[] } | undefined;
      try {
        result = installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(result).toBeDefined();
      expect(result?.filesWritten.length).toBe(
        CUSTOMIZE_SKILL_FILE_NAMES.length,
      );

      const destDir = join(targetDir, ".claude", "skills", "customize");
      expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toBe(
        "---\nname: customize\n---\n# customize\n",
      );
      expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
        "export const x = 1;\n",
      );
    },
  );
});

describe("an unreadable existing SKILL.md at the adopt-mode destination refuses the install, not guesses", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;
  let skillMdDest: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-existing-unreadable-adopt-src-"),
    );
    targetDir = mkdtempSync(
      join(tmpdir(), "plugin-existing-unreadable-adopt-tgt-"),
    );
    writeSourceFixture(sourceDir);
    destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    skillMdDest = join(destDir, "SKILL.md");
    writeFileSync(
      skillMdDest,
      "---\nname: customize\n---\n# stale, unreadable\n",
    );
  });

  afterEach(() => {
    // Restore read permission before cleanup -- only if it's still there: a
    // refused install must leave it exactly as it was.
    if (existsSync(skillMdDest)) {
      chmodSync(skillMdDest, 0o644);
    }
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it.skipIf(skipUnlessChmodWorks)(
    "refuses with 'could not read ...' and a cause, writing and removing nothing",
    () => {
      chmodSync(skillMdDest, 0o000);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("could not read");
      expect(message).toContain(skillMdDest);
      expect((thrown as Error).cause).toBeInstanceOf(Error);

      // Nothing was written or removed: the directory holds exactly the one
      // (still unreadable) SKILL.md it started with, byte-for-byte.
      expect(readdirSync(destDir)).toEqual(["SKILL.md"]);
      chmodSync(skillMdDest, 0o644);
      expect(readFileSync(skillMdDest, "utf8")).toBe(
        "---\nname: customize\n---\n# stale, unreadable\n",
      );
      chmodSync(skillMdDest, 0o000);
    },
  );
});
