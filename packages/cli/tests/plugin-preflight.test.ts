// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * [this round, item 2] A directory sitting at ANY payload name (not just
 * `SKILL.md`) under the write destination must be detected BEFORE any file
 * is written or rewritten -- a true pre-flight check, not the existing
 * write-then-roll-back loop `copyCustomizeSkillFiles` (`../src/plugin.js`)
 * runs today. That loop only notices an obstacle when it reaches that
 * payload file's own turn to be written, so an obstacle at a MIDDLE or LAST
 * payload position still lets every EARLIER payload file be
 * removed-and-rewritten first (then rolled back by REMOVING it outright,
 * never restoring its prior content) before the obstacle is ever reached --
 * leaving any pre-existing (possibly stale) earlier file GONE, not
 * untouched. Only an obstacle at the FIRST payload position is already a
 * no-op under the current code, since nothing precedes it -- that case is
 * included below for completeness and is expected to already pass.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";
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

/** A pre-existing, differing `.claude/skills/customize/SKILL.md` -- forces `installCustomizeSkillGuarded` into its "groundwork" branch. */
function writeDifferingClaudeSkill(targetDir: string): void {
  mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
    recursive: true,
  });
  writeFileSync(
    join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
    "---\nname: customize\n---\n# a project-authored version\n",
  );
}

/** Replaces `destPath` with a non-empty directory, so a non-recursive `rmSync` throws `ERR_FS_EISDIR`. */
function plantNonEmptyDirectoryAt(destPath: string): void {
  mkdirSync(destPath, { recursive: true });
  writeFileSync(join(destPath, "blocks-the-rm.txt"), "occupied\n");
}

/** Pre-populates `.groundwork/customize/` with all five payload files holding `content`. */
function writeGroundworkSkillPayload(targetDir: string, content: string): void {
  const dir = join(targetDir, ".groundwork", "customize");
  mkdirSync(dir, { recursive: true });
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    writeFileSync(join(dir, name), content);
  }
}

const positions: ["first" | "middle" | "last", string][] = [
  ["first", "kind-facet-map.ts"],
  ["middle", "pack-map.ts"],
  ["last", "plugin-map.ts"],
];

describe.each(positions)(
  "a directory at the %s payload name (%s) under .groundwork/customize/ fails before touching any other file (item 2, adopt fallback)",
  (_position, name) => {
    let sourceDir: string;
    let targetDir: string;
    let destDir: string;

    beforeEach(() => {
      sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-gw-src-"));
      targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-gw-tgt-"));
      writeSourceFixture(sourceDir);
      // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
      writeDifferingClaudeSkill(targetDir);
      // A stale prior install already sits at the groundwork destination.
      writeGroundworkSkillPayload(targetDir, "OLD");
      destDir = join(targetDir, ".groundwork", "customize");
      rmSync(join(destDir, name), { force: true });
      plantNonEmptyDirectoryAt(join(destDir, name));
    });

    afterEach(() => {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    });

    it("throws naming the directory, and leaves every OTHER payload file exactly as it was (no earlier file rewritten or removed)", () => {
      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("could not install the /customize skill");
      expect(message).toContain(join(destDir, name));

      // The directory obstacle itself is untouched.
      expect(lstatSync(join(destDir, name)).isDirectory()).toBe(true);

      // Every OTHER *data* file is byte-for-byte the same stale "OLD"
      // content it held before this call -- never rewritten, never removed,
      // regardless of whether it comes before or after the obstacle in
      // write order. SKILL.md is excluded here: for the CLI-owned
      // .groundwork/customize/ destination, removeStaleSkillEntry
      // intentionally removes a pre-existing SKILL.md unconditionally,
      // before the data-file loop runs at all (item F's own, unrelated,
      // already-correct contract) -- that is not what this test exists to
      // catch.
      for (const otherName of CUSTOMIZE_SKILL_FILE_NAMES) {
        if (otherName === name || otherName === "SKILL.md") {
          continue;
        }
        expect(readFileSync(join(destDir, otherName), "utf8")).toBe("OLD");
      }

      // The project's own differing .claude/ SKILL.md is a separate
      // destination and is never touched.
      expect(
        readFileSync(
          join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
          "utf8",
        ),
      ).toContain("a project-authored version");
    });
  },
);

describe.each(positions)(
  "a directory at the %s payload name (%s) under .claude/skills/customize/ fails before touching any other file (item 2, fresh-mode re-run)",
  (_position, name) => {
    let sourceDir: string;
    let targetDir: string;
    let destDir: string;

    beforeEach(() => {
      sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-fresh-src-"));
      targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-fresh-tgt-"));
      writeSourceFixture(sourceDir);
      destDir = join(targetDir, ".claude", "skills", "customize");
      // A successful first install.
      const first = installCustomizeSkill(targetDir, sourceDir);
      expect(first.filesWritten).toHaveLength(5);
      rmSync(join(destDir, name), { force: true });
      plantNonEmptyDirectoryAt(join(destDir, name));
    });

    afterEach(() => {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    });

    it("throws naming the directory, and leaves every OTHER payload file exactly as the first install left it", () => {
      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("could not install the /customize skill");
      expect(message).toContain(join(destDir, name));
      expect(lstatSync(join(destDir, name)).isDirectory()).toBe(true);

      for (const otherName of CUSTOMIZE_SKILL_FILE_NAMES) {
        if (otherName === name) {
          continue;
        }
        // Still exactly the first install's own byte-identical content --
        // never rewritten or removed by the failed re-run.
        expect(existsSync(join(destDir, otherName))).toBe(true);
        expect(readFileSync(join(destDir, otherName), "utf8")).not.toBe("");
      }
    });
  },
);
