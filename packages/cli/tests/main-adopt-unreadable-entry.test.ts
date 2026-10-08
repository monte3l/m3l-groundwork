// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Adopt-mode, end-to-end, against the REAL `/customize` skill payload --
 * `../src/plugin.js`, `../src/git.js` and every other collaborator are
 * unmocked, same pattern as `plugin-symlink.test.ts`'s "adopt mode (main())
 * and a symlinked .claude" describe (adopt mode never calls `gitInit`/
 * `runInstall`, so there is nothing to mock there).
 *
 * The fixture project's `.claude/skills/customize/` already holds a
 * near-complete, project-owned copy of this CLI's current payload:
 * `SKILL.md` plus three of its four data files, all byte-identical to what
 * `packages/plugin` actually ships today -- except the fourth data file
 * (`pack-map.ts`), which exists but cannot be read (`chmod 000`).
 * `classifyExistingSkill` (`../src/plugin.js`) treats that single unreadable
 * entry as FOREIGN, the same as any other project-owned entry it cannot
 * reconcile with the payload, so `installCustomizeSkillGuarded` falls back
 * to `.groundwork/customize/` for the WHOLE payload rather than refusing
 * the run or guessing that the unreadable file is current.
 *
 * This asserts `main()` completes top to bottom against that fixture: it
 * does not throw, it installs the skill into `.groundwork/customize/` (all
 * five files), its console output carries the "entry" fallback's next-step
 * text and the fallback reason (including the read failure's errno code),
 * `.groundwork/adoption-report.md` and `inventory.json` both exist -- and,
 * the guarantee this file exists to prove, NOTHING under the project
 * (`.claude/` included) is modified: same bytes, same mode, same mtime,
 * before and after.
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
  CUSTOMIZE_SKILL_STEP_FILE_NAMES,
} from "../src/customize-paths.js";
import { chmodIneffective } from "./chmod-ineffective.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The real plugin payload this repo ships -- not a synthetic fixture. */
const pluginSrcDir = join(here, "..", "..", "plugin");

/** This CLI's current bytes for one payload file, read from the real source tree. */
function realPayloadBytes(name: string): Buffer {
  const from =
    name === CUSTOMIZE_SKILL_ENTRY_FILE ||
    (CUSTOMIZE_SKILL_STEP_FILE_NAMES as readonly string[]).includes(name)
      ? join(pluginSrcDir, "skills", "customize", name)
      : join(pluginSrcDir, "src", name);
  return readFileSync(from);
}

const UNREADABLE_DATA_FILE = "pack-map.ts";
const BYTE_IDENTICAL_NAMES = CUSTOMIZE_SKILL_FILE_NAMES.filter(
  (name) => name !== UNREADABLE_DATA_FILE,
);

/** One file's content hash, POSIX mode and mtime -- "unreadable" in place of a hash when the entry cannot be read, so comparing two snapshots of an untouched unreadable file still reports equal. */
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

/** Every file under `root`, EXCLUDING `.groundwork/` (adopt mode's own output directory), fingerprinted relative to `root`. */
function snapshotExcludingGroundwork(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        if (rel === ".groundwork") {
          continue;
        }
        visit(abs);
        continue;
      }
      snapshot.set(rel, fingerprint(abs));
    }
  };
  visit(root);
  return snapshot;
}

describe("adopt mode (main()): an unreadable project-owned data file falls back whole, touching nothing under .claude/", () => {
  let workDir: string;
  let projectDir: string;
  let destDir: string;
  let packMapDest: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "adopt-unreadable-entry-"));
    projectDir = join(workDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }, null, 2),
    );

    destDir = join(projectDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    for (const name of BYTE_IDENTICAL_NAMES) {
      writeFileSync(join(destDir, name), realPayloadBytes(name));
    }
    packMapDest = join(destDir, UNREADABLE_DATA_FILE);
    writeFileSync(packMapDest, realPayloadBytes(UNREADABLE_DATA_FILE));
    chmodSync(packMapDest, 0o000);
  });

  afterEach(() => {
    // Restore read permission for cleanup -- never load-bearing for the
    // assertions above it, which compare against a snapshot taken while the
    // file was already unreadable.
    if (existsSync(packMapDest)) {
      chmodSync(packMapDest, 0o644);
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "completes the run, installs the whole payload into .groundwork/customize/, and leaves every project file exactly as it was",
    () => {
      const before = snapshotExcludingGroundwork(projectDir);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let thrown: unknown;
      let output: string;
      try {
        main([projectDir]);
      } catch (error) {
        thrown = error;
      } finally {
        // Read the calls BEFORE mockRestore(): mockRestore() also resets
        // the mock's call history, which would make output empty.
        output = logSpy.mock.calls
          .map((call) => call.map((arg) => String(arg)).join(" "))
          .join("\n");
        logSpy.mockRestore();
      }

      expect(thrown).toBeUndefined();

      const groundworkCustomizeDir = join(
        projectDir,
        ".groundwork",
        "customize",
      );
      expect(readdirSync(groundworkCustomizeDir).toSorted()).toEqual(
        [...CUSTOMIZE_SKILL_FILE_NAMES].toSorted(),
      );

      // The "entry" fallback's next step is console-only -- the adoption
      // report does not carry it (asserted as "exists", not its contents).
      expect(output).toContain("staged at .groundwork/customize/");
      expect(output).toContain(
        "replace the project-local .claude/skills/customize/ copy",
      );
      // fallbackReason names the read failure's errno code -- see this
      // file's header comment and plugin-existing-unreadable.test.ts.
      expect(output).toContain("EACCES");

      expect(
        existsSync(join(projectDir, ".groundwork", "adoption-report.md")),
      ).toBe(true);
      expect(
        existsSync(join(projectDir, ".groundwork", "inventory.json")),
      ).toBe(true);

      const after = snapshotExcludingGroundwork(projectDir);
      expect(after).toEqual(before);
    },
  );
});
