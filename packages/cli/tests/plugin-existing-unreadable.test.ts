// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `classifyExistingSkill` (`../src/plugin.js`) treats a payload name it
 * cannot `lstat` and one it cannot READ differently, and the READ case
 * itself differs by which policy is asking:
 *
 * - Fresh mode (`installCustomizeSkill`, `"overwrite"` policy): an existing
 *   `SKILL.md` that `lstat` already confirmed is a plain regular file, but
 *   cannot actually be read (`EACCES` and similar), is replaced anyway --
 *   only a byte-identical "current" result skips the write, and an
 *   unreadable file can never produce one. Fresh mode proceeds to remove
 *   and rewrite it, same as any other stale copy, since "overwrite" already
 *   owns replacing whatever sits there.
 * - Adopt mode (`installCustomizeSkillGuarded`, `"additive"` policy, via
 *   `regularFileMatches`): the same unreadable regular file is classified
 *   FOREIGN, same as any other project-owned entry `classifyExistingSkill`
 *   cannot reconcile with the payload -- it does NOT throw.
 *   `installCustomizeSkillGuarded` falls back to
 *   `.groundwork/customize/` the same way it does for any other foreign
 *   entry: the result's `location` is `"groundwork"`, `fallbackCause` is
 *   `"entry"`, and `fallbackReason` names the unreadable path. Nothing
 *   under `.claude/skills/customize/` is written, removed, or modified --
 *   the directory's entries, and the unreadable file's own bytes and mode,
 *   are exactly as they were before the call. Adopt mode never guesses at a
 *   project entry it cannot actually compare, but it also never refuses the
 *   whole install over one it can safely leave alone and route around.
 *   Covered for both the entry file (`SKILL.md`) and a data file
 *   (`pack-map.ts`), since `classifyExistingSkill` walks the payload in
 *   write order and returns on the first non-matching entry it finds.
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
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";
import { CUSTOMIZE_SKILL_FILE_NAMES } from "../src/customize-paths.js";
import { chmodIneffective } from "./chmod-ineffective.js";

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

  it.skipIf(chmodIneffective)(
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

describe("an unreadable existing payload entry at the adopt-mode destination is FOREIGN, not refused: falls back to .groundwork/customize/", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;
  let groundworkDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-existing-unreadable-adopt-src-"),
    );
    targetDir = mkdtempSync(
      join(tmpdir(), "plugin-existing-unreadable-adopt-tgt-"),
    );
    writeSourceFixture(sourceDir);
    destDir = join(targetDir, ".claude", "skills", "customize");
    groundworkDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    // Restore read permission on any still-unreadable entry before cleanup,
    // for hygiene -- a refused OR foreign-fallback install must leave the
    // project's own entry exactly as it was, so this must never be load
    // bearing for the assertions above it.
    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      const entry = join(destDir, name);
      if (existsSync(entry)) {
        chmodSync(entry, 0o644);
      }
    }
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "an unreadable SKILL.md (no data files installed yet) falls back with fallbackCause 'entry', leaving .claude untouched",
    () => {
      const skillMdDest = join(destDir, "SKILL.md");
      writeFileSync(
        skillMdDest,
        "---\nname: customize\n---\n# stale, unreadable\n",
      );
      chmodSync(skillMdDest, 0o000);

      const entriesBefore = readdirSync(destDir).toSorted();
      const modeBefore = statSync(skillMdDest).mode;

      const result = installCustomizeSkillGuarded(targetDir, sourceDir);

      expect(result.location).toBe("groundwork");
      expect(result.fallbackCause).toBe("entry");
      const { fallbackReason } = result;
      if (fallbackReason === undefined) {
        throw new Error("expected a fallbackReason naming the unreadable path");
      }
      expect(fallbackReason).toContain(skillMdDest);
      expect(result.filesWritten.toSorted()).toEqual(
        CUSTOMIZE_SKILL_FILE_NAMES.map((name) =>
          join(".groundwork", "customize", name),
        ).toSorted(),
      );

      // Nothing under .claude/skills/customize/ was written, removed, or
      // modified: same entries, same mode, same bytes once readable again.
      expect(readdirSync(destDir).toSorted()).toEqual(entriesBefore);
      expect(statSync(skillMdDest).mode).toBe(modeBefore);
      chmodSync(skillMdDest, 0o644);
      expect(readFileSync(skillMdDest, "utf8")).toBe(
        "---\nname: customize\n---\n# stale, unreadable\n",
      );
      chmodSync(skillMdDest, 0o000);

      // .groundwork/customize/ holds this CLI's five current files.
      expect(readdirSync(groundworkDir).toSorted()).toEqual(
        [...CUSTOMIZE_SKILL_FILE_NAMES].toSorted(),
      );
      expect(readFileSync(join(groundworkDir, "SKILL.md"), "utf8")).toBe(
        "---\nname: customize\n---\n# customize\n",
      );
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable data file (pack-map.ts) among otherwise-current entries falls back with fallbackCause 'entry', leaving .claude untouched",
    () => {
      writeFileSync(
        join(destDir, "kind-facet-map.ts"),
        "export const x = 1;\n",
      );
      writeFileSync(join(destDir, "domain-map.ts"), "export const y = 2;\n");
      const packMapDest = join(destDir, "pack-map.ts");
      writeFileSync(packMapDest, "export const z = 3;\n");
      writeFileSync(join(destDir, "plugin-map.ts"), "export const w = 4;\n");
      writeFileSync(
        join(destDir, "SKILL.md"),
        "---\nname: customize\n---\n# customize\n",
      );
      chmodSync(packMapDest, 0o000);

      const entriesBefore = readdirSync(destDir).toSorted();
      const modeBefore = statSync(packMapDest).mode;

      const result = installCustomizeSkillGuarded(targetDir, sourceDir);

      expect(result.location).toBe("groundwork");
      expect(result.fallbackCause).toBe("entry");
      const { fallbackReason } = result;
      if (fallbackReason === undefined) {
        throw new Error("expected a fallbackReason naming the unreadable path");
      }
      expect(fallbackReason).toContain(packMapDest);

      expect(readdirSync(destDir).toSorted()).toEqual(entriesBefore);
      expect(statSync(packMapDest).mode).toBe(modeBefore);
      chmodSync(packMapDest, 0o644);
      expect(readFileSync(packMapDest, "utf8")).toBe("export const z = 3;\n");
      chmodSync(packMapDest, 0o000);

      expect(readdirSync(groundworkDir).toSorted()).toEqual(
        [...CUSTOMIZE_SKILL_FILE_NAMES].toSorted(),
      );
    },
  );

  // `classifyExistingSkill`'s "unreadable" verdict (above) and
  // `installToGroundwork`'s own combining wrap each append ", so ..." to a
  // reason that may already end in one -- the combined text carries the
  // read failure's errno code (e.g. "could not be read (EACCES)") and uses
  // "so" exactly once.
  it.skipIf(chmodIneffective)(
    "the fallbackReason for an unreadable SKILL.md names the errno code and uses 'so' at most once (no doubled 'so ... so')",
    () => {
      const skillMdDest = join(destDir, "SKILL.md");
      writeFileSync(
        skillMdDest,
        "---\nname: customize\n---\n# stale, unreadable\n",
      );
      chmodSync(skillMdDest, 0o000);

      const result = installCustomizeSkillGuarded(targetDir, sourceDir);

      expect(result.location).toBe("groundwork");
      expect(result.fallbackCause).toBe("entry");
      const { fallbackReason } = result;
      if (fallbackReason === undefined) {
        throw new Error("expected a fallbackReason naming the unreadable path");
      }
      expect(fallbackReason).toContain("EACCES");
      const soOccurrences = fallbackReason.match(/\bso\b/g) ?? [];
      expect(soOccurrences.length).toBeLessThanOrEqual(1);
    },
  );

  // Same errno + single-"so" contract, but on the OTHER combined text:
  // installToGroundwork's catch clause, reached when the
  // `.groundwork/customize/` fallback install ITSELF fails. Its wrapping
  // embeds the same `reason` ahead of its own ", so it fell back to
  // .groundwork/customize/, and that install failed too" -- this text
  // independently carries the errno code and uses "so" exactly once.
  it.skipIf(chmodIneffective)(
    "the error thrown when the .groundwork/customize/ fallback install itself fails still names the errno code and uses 'so' at most once",
    () => {
      const skillMdDest = join(destDir, "SKILL.md");
      writeFileSync(
        skillMdDest,
        "---\nname: customize\n---\n# stale, unreadable\n",
      );
      chmodSync(skillMdDest, 0o000);
      // Make the fallback destination's own install fail: a directory
      // sitting at one of the payload names there is refused -- before
      // anything is removed or written -- by assertNoDirectoryAtPayloadNames.
      mkdirSync(join(groundworkDir, "SKILL.md"), { recursive: true });

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("EACCES");
      const soOccurrences = message.match(/\bso\b/g) ?? [];
      expect(soOccurrences.length).toBeLessThanOrEqual(1);

      // Cleanup: the directory stand-in for SKILL.md at the fallback
      // destination isn't covered by this describe's afterEach (which only
      // restores read permission under .claude/skills/customize/).
      rmSync(join(groundworkDir, "SKILL.md"), { recursive: true, force: true });
    },
  );
});
