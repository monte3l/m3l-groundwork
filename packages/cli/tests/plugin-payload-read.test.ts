// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * [this round, item 4] `readCustomizeSkillPayload` (`../src/plugin.js`)
 * treats every source payload file the same way regardless of WHY it
 * couldn't be read: a genuinely ABSENT file (checked via `existsSync`) is
 * reported as "the /customize skill's source file is missing", but a file
 * that EXISTS and is merely unreadable (no read permission) falls through to
 * the ordinary `readFileSync` call inside `wrapFs`, which preserves the raw
 * errno (`EACCES`) in both the thrown error's message and its `cause` -- it
 * must never be misreported as "missing" just because it couldn't be read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";

/** A root process ignores file permission bits entirely, and Windows has no
 * POSIX chmod semantics -- neither can produce the EACCES these tests rely
 * on. */
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

describe("a source payload file that exists but is unreadable keeps its real errno, never 'missing' (item 4)", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-unreadable-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-unreadable-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    // Restore read permission before cleanup, or the recursive rmSync below
    // can itself be refused on some platforms -- but only if the file is
    // still there (the regression-guard test below removes it itself).
    const skillMdPath = join(sourceDir, "skills", "customize", "SKILL.md");
    if (existsSync(skillMdPath)) {
      chmodSync(skillMdPath, 0o644);
    }
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it.skipIf(skipUnlessChmodWorks)(
    "keeps EACCES in the message and cause, rather than reporting the file as missing",
    () => {
      const skillMdPath = join(sourceDir, "skills", "customize", "SKILL.md");
      chmodSync(skillMdPath, 0o000);

      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("could not install the /customize skill");
      expect(message).not.toContain("is missing");
      expect(message).toContain(skillMdPath);
      expect((thrown as Error).cause).toBeInstanceOf(Error);
      expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe(
        "EACCES",
      );
    },
  );

  // [item 3] Fresh mode's own remediation must read "re-run the same
  // command with --fresh --force added" (so it agrees with main.ts
  // runFresh's outer message, which tells the caller exactly that) rather
  // than the generic "fix the cause and re-run the CLI" every other
  // install failure gets -- and the advice must appear exactly once, not
  // both phrasings stacked on top of each other.
  it.skipIf(skipUnlessChmodWorks)(
    "[item 3] a fresh-mode (installCustomizeSkill) failure's remediation says to re-run with --fresh --force, not the generic 'fix the cause and re-run the CLI'",
    () => {
      const skillMdPath = join(sourceDir, "skills", "customize", "SKILL.md");
      chmodSync(skillMdPath, 0o000);

      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(
        "re-run the same command with --fresh --force added",
      );
      expect(message).not.toContain("fix the cause and re-run the CLI");
    },
  );

  // [item 3] The same failure through installCustomizeSkillGuarded (adopt
  // mode) keeps the OLD, generic remediation -- it has no "--fresh --force"
  // flag to point at.
  it.skipIf(skipUnlessChmodWorks)(
    "[item 3] the same failure through installCustomizeSkillGuarded (adopt mode) keeps 'fix the cause and re-run the CLI', never '--fresh --force'",
    () => {
      const skillMdPath = join(sourceDir, "skills", "customize", "SKILL.md");
      chmodSync(skillMdPath, 0o000);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("fix the cause and re-run the CLI");
      expect(message).not.toContain("--fresh --force");
    },
  );

  it("[regression guard] a truly MISSING source file still says 'missing'", () => {
    rmSync(join(sourceDir, "skills", "customize", "SKILL.md"), {
      force: true,
    });

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("is missing");
  });
});
