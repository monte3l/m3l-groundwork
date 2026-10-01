// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `classifyExistingSkill` (`../src/plugin.js`) currently treats a payload
 * name it cannot READ the exact same way it treats one it cannot even
 * `lstat`: both abort the whole install ("could not inspect"/"could not
 * read ...", the raw error as `cause`). That is right for an `lstat`
 * failure -- the entry's very nature is unknown, so removing it would be a
 * guess -- but wrong for a READ failure against an entry `lstat` already
 * confirmed is a plain regular file: its nature IS known, it simply cannot
 * be compared byte-for-byte to the current payload. The contract this suite
 * is written against: an existing `SKILL.md` that exists but cannot be read
 * is treated as "not current" (the same as a byte-for-byte mismatch) rather
 * than refusing the install -- `installCustomizeSkill` (fresh mode's
 * "overwrite" policy) proceeds to remove and rewrite it, same as any other
 * stale copy. An `lstat` failure against the same entry is a separate
 * concern and keeps refusing the install unchanged -- see
 * `plugin-rollback.test.ts`'s "a pre-flight lstat failure refuses a
 * replacing-policy install" suite, which this test does not duplicate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCustomizeSkill } from "../src/plugin.js";
import { CUSTOMIZE_SKILL_FILE_NAMES } from "../src/customize-paths.js";

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

  it("removes and rewrites it rather than refusing the whole install", () => {
    // A root process ignores file permission bits entirely, and Windows has
    // no POSIX chmod semantics -- neither can produce the EACCES this test
    // relies on.
    if (process.getuid?.() === 0 || process.platform === "win32") {
      return;
    }
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
    expect(result?.filesWritten.length).toBe(CUSTOMIZE_SKILL_FILE_NAMES.length);

    const destDir = join(targetDir, ".claude", "skills", "customize");
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toBe(
      "---\nname: customize\n---\n# customize\n",
    );
    expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
  });
});
