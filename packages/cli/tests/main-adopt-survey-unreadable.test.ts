// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2, adopt-level: `main()` must complete (exit 0, no throw) against a
 * project holding an unreadable (`chmod 000`) `.claude/` file -- the survey
 * must record it in `undetermined` (both `.groundwork/inventory.json`'s
 * `survey.undetermined` and the matching bullet under
 * `adoption-report.md`'s "## Could not be determined") and move on, never
 * abort the run. Nothing under the project (`.claude/` included) may be
 * modified.
 *
 * The primary scenario -- `.claude/skills/customize/SKILL.md` unreadable --
 * overlaps two independent mechanisms on the SAME file: `installCustomizeSkillGuarded`
 * (`plugin.ts`) already classifies an unreadable existing entry as FOREIGN
 * and falls back to `.groundwork/customize/` for the whole payload (proven
 * by `plugin-existing-unreadable.test.ts`/`main-adopt-unreadable-entry.test.ts`,
 * NOT re-proven here); `surveyHarness`'s own independent read of the same
 * file (every skill under `.claude/skills/` is surveyed, "customize" owned
 * by the project included) is the part this file exists to prove, since
 * today that read is unguarded and throws before either `.groundwork/`
 * output is ever written.
 *
 * The follow-on cases cover each other unreadable file kind the survey
 * reads: an agent `.md`, a rule `.md`, and `settings.json` -- the last one a
 * baseline file `conflicts.ts`'s `planConflicts` reads (`templates/core`
 * ships `.claude/settings.json`), so an unreadable copy is recorded in
 * `undetermined` with EACCES the same as the other two, not exempted from
 * it. Deliberately avoids any file name that collides with one
 * `templates/core` itself ships elsewhere (CLAUDE.md, the baseline's own
 * agent/rule names), since `planConflicts` independently reads a project's
 * copy of any file matching a baseline name -- a separate, out-of-scope
 * concern this file does not exercise beyond this one settings.json case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { main } from "../src/main.js";
import {
  CUSTOMIZE_SKILL_ENTRY_FILE,
  CUSTOMIZE_SKILL_FILE_NAMES,
} from "../src/customize-paths.js";
import { chmodIneffective } from "./chmod-ineffective.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The real plugin payload this repo ships -- not a synthetic fixture. */
const pluginSrcDir = join(here, "..", "..", "plugin");

/** This CLI's current bytes for one payload file, read from the real source tree. */
function realPayloadBytes(name: string): Buffer {
  const from =
    name === CUSTOMIZE_SKILL_ENTRY_FILE
      ? join(pluginSrcDir, "skills", "customize", name)
      : join(pluginSrcDir, "src", name);
  return readFileSync(from);
}

/** One file's content hash, POSIX mode and mtime -- "unreadable" in place of a hash when the entry cannot be read. */
function fingerprint(path: string): string {
  const stat = statSync(path);
  let hash: string;
  try {
    hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    hash = "unreadable";
  }
  return `${hash}:${String(stat.mode)}:${String(stat.mtimeMs)}`;
}

/** Every file under `root`, EXCLUDING `.groundwork/`, fingerprinted relative to `root`. */
function snapshotExcludingGroundwork(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        if (rel === ".groundwork") continue;
        visit(abs);
        continue;
      }
      snapshot.set(rel, fingerprint(abs));
    }
  };
  visit(root);
  return snapshot;
}

function readInventoryUndetermined(groundworkDir: string): string[] {
  const inventory = JSON.parse(
    readFileSync(join(groundworkDir, "inventory.json"), "utf8"),
  ) as { survey: { undetermined: string[] } };
  return inventory.survey.undetermined;
}

function readReportText(groundworkDir: string): string {
  return readFileSync(join(groundworkDir, "adoption-report.md"), "utf8");
}

describe("adopt mode (main()): .claude/skills/customize/SKILL.md unreadable -- survey records it, run still completes", () => {
  let workDir: string;
  let projectDir: string;
  let destDir: string;
  let skillMdDest: string;
  let groundworkDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "adopt-survey-unreadable-"));
    projectDir = join(workDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }, null, 2),
    );

    destDir = join(projectDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      if (name === CUSTOMIZE_SKILL_ENTRY_FILE) continue;
      writeFileSync(join(destDir, name), realPayloadBytes(name));
    }
    skillMdDest = join(destDir, CUSTOMIZE_SKILL_ENTRY_FILE);
    writeFileSync(skillMdDest, realPayloadBytes(CUSTOMIZE_SKILL_ENTRY_FILE));
    chmodSync(skillMdDest, 0o000);

    groundworkDir = join(projectDir, ".groundwork");
  });

  afterEach(() => {
    if (existsSync(skillMdDest)) {
      chmodSync(skillMdDest, 0o644);
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "completes the run, records SKILL.md's path and EACCES in both inventory.json and the adoption report, installs the whole payload to .groundwork/customize/, and leaves every project file exactly as it was",
    () => {
      const before = snapshotExcludingGroundwork(projectDir);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let thrown: unknown;
      let printedLines: string[];
      try {
        main([projectDir]);
        printedLines = logSpy.mock.calls.map((call) => String(call[0]));
      } catch (error) {
        thrown = error;
        // Captured BEFORE mockRestore(), which (like mockReset()) clears
        // mock.calls -- reading it after restore would always see [].
        printedLines = logSpy.mock.calls.map((call) => String(call[0]));
      } finally {
        logSpy.mockRestore();
      }

      expect(thrown).toBeUndefined();

      // The console output itself (not just the two .groundwork/ artifacts)
      // must surface the SAME fact: a maintainer watching the run scroll by,
      // never opening the report, should still see which file was unreadable
      // and why. `installGuarded`'s own fallback-reason line (`plugin.ts`,
      // printed by `main.ts` right after "installed the /customize skill
      // into ...") already names the path and errno -- this asserts that
      // printed line actually reaches console.log for this exact scenario,
      // not just that the lower-level plugin.ts unit tests cover the text.
      expect(
        printedLines.some(
          (line) => line.includes(skillMdDest) && line.includes("EACCES"),
        ),
      ).toBe(true);

      const groundworkCustomizeDir = join(groundworkDir, "customize");
      expect(readdirSync(groundworkCustomizeDir).toSorted()).toEqual(
        [...CUSTOMIZE_SKILL_FILE_NAMES].toSorted(),
      );

      const undetermined = readInventoryUndetermined(groundworkDir);
      expect(
        undetermined.some(
          (entry) => entry.includes(skillMdDest) && entry.includes("EACCES"),
        ),
      ).toBe(true);

      const reportText = readReportText(groundworkDir);
      expect(reportText).toContain("## Could not be determined");
      expect(reportText).toContain(skillMdDest);
      expect(reportText).toContain("EACCES");

      const after = snapshotExcludingGroundwork(projectDir);
      expect(after).toEqual(before);
    },
  );
});

describe.each([
  {
    label: "an unreadable project-owned agent .md",
    relPath: join(".claude", "agents", "reviewer.md"),
    content: "---\nmodel: sonnet\n---\n# reviewer\n",
    expectUndetermined: true,
  },
  {
    label: "an unreadable project-owned rule .md",
    relPath: join(".claude", "rules", "scoped-custom.md"),
    content: '---\npaths: "src/**"\n---\nbody\n',
    expectUndetermined: true,
  },
  {
    label:
      "an unreadable settings.json (a baseline file planConflicts reads: recorded in undetermined with EACCES)",
    relPath: join(".claude", "settings.json"),
    content: "{}",
    expectUndetermined: true,
  },
])(
  "adopt mode (main()): $label",
  ({ relPath, content, expectUndetermined }) => {
    let workDir: string;
    let projectDir: string;
    let targetPath: string;
    let groundworkDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "adopt-survey-kind-"));
      projectDir = join(workDir, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "acme", type: "module" }, null, 2),
      );
      targetPath = join(projectDir, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content);
      chmodSync(targetPath, 0o000);
      groundworkDir = join(projectDir, ".groundwork");
    });

    afterEach(() => {
      if (existsSync(targetPath)) {
        chmodSync(targetPath, 0o644);
      }
      rmSync(workDir, { recursive: true, force: true });
    });

    it.skipIf(chmodIneffective)(
      "completes the run without throwing, and records (or correctly omits) the path in undetermined as expected",
      () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        let thrown: unknown;
        try {
          main([projectDir]);
        } catch (error) {
          thrown = error;
        } finally {
          logSpy.mockRestore();
        }

        expect(thrown).toBeUndefined();
        expect(existsSync(join(groundworkDir, "inventory.json"))).toBe(true);

        const undetermined = readInventoryUndetermined(groundworkDir);
        const found = undetermined.some((entry) => entry.includes(targetPath));
        expect(found).toBe(expectUndetermined);
      },
    );
  },
);
