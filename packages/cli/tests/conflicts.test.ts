// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import { unreadableNote } from "../src/survey/internal/read-guard.js";
import { chmodIneffective } from "./chmod-ineffective.js";

describe("planConflicts", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-target-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("reports absent for a file the target doesn't have", () => {
    writeFileSync(join(templateRoot, "CLAUDE.md"), "# __PROJECT_NAME__\n");
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result).toEqual([
      { relPath: "CLAUDE.md", status: "absent", keyDiffs: undefined },
    ]);
  });

  it("reports identical for a whole-file match after token substitution", () => {
    writeFileSync(join(templateRoot, "README.md"), "# __PROJECT_NAME__\n");
    writeFileSync(join(targetDir, "README.md"), "# acme\n");
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result).toEqual([
      { relPath: "README.md", status: "identical", keyDiffs: undefined },
    ]);
  });

  it("reports divergent for a whole-file mismatch", () => {
    writeFileSync(join(templateRoot, "README.md"), "# __PROJECT_NAME__\n");
    writeFileSync(join(targetDir, "README.md"), "# something else\n");
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result[0]?.status).toBe("divergent");
  });

  it("compares package.json at the key level", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({
        name: "__PROJECT_NAME__",
        type: "module",
        scripts: { build: "tsc" },
      }),
    );
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify({
        name: "acme",
        type: "commonjs",
        scripts: { build: "tsc" },
      }),
    );
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result[0]?.status).toBe("divergent");
    expect(result[0]?.keyDiffs).toEqual(["type"]);
  });

  it("reports package.json identical when every key matches after substitution", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "__PROJECT_NAME__" }),
    );
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify({ name: "acme" }),
    );
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result[0]).toEqual({
      relPath: "package.json",
      status: "identical",
      keyDiffs: [],
    });
  });

  it("compares a nested tsconfig*.json at the key level too", () => {
    writeFileSync(
      join(templateRoot, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(
      join(targetDir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result[0]?.keyDiffs).toEqual(["compilerOptions"]);
  });

  it("falls back to a whole-file compare when the target's JSON fails to parse", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    writeFileSync(join(targetDir, "package.json"), "{not json");
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result[0]?.status).toBe("divergent");
    expect(result[0]?.keyDiffs).toBeUndefined();
  });

  it("walks nested directories and substitutes tokens in path segments", () => {
    mkdirSync(join(templateRoot, "__PROJECT_NAME__", "nested"), {
      recursive: true,
    });
    writeFileSync(
      join(templateRoot, "__PROJECT_NAME__", "nested", "file.ts"),
      "export {};",
    );
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result).toEqual([
      { relPath: "acme/nested/file.ts", status: "absent", keyDiffs: undefined },
    ]);
  });

  it("falls back to a whole-file compare rather than crashing when the target's JSON parses to a non-object (null)", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    // "null" is valid JSON (parseJsonc succeeds) but parses to the value
    // `null`, not an object -- compareJsonKeys must not blindly cast this to
    // Record<string, unknown> and call Object.keys() on it.
    writeFileSync(join(targetDir, "package.json"), "null");

    expect(() => planConflicts(templateRoot, targetDir, {})).not.toThrow();

    const result = planConflicts(templateRoot, targetDir, {});
    expect(result[0]?.keyDiffs).toBeUndefined();
    expect(result[0]?.status).toBe("divergent");
  });

  it("compares a vendored _gitignore against the project's real .gitignore", () => {
    writeFileSync(join(templateRoot, "_gitignore"), "node_modules/\n");
    writeFileSync(join(targetDir, ".gitignore"), "node_modules/\n");
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result).toEqual([
      { relPath: ".gitignore", status: "identical", keyDiffs: undefined },
    ]);
  });

  describe("a project file matching a baseline name that exists but cannot be read (EACCES/EPERM)", () => {
    afterEach(() => {
      // Restore read permission before the outer afterEach's rmSync -- an
      // unlink doesn't need it, but this mirrors every other unreadable-file
      // suite's teardown so a leftover chmod 000 entry never survives a
      // failed assertion into the next test.
      for (const name of ["README.md", "package.json"]) {
        const path = join(targetDir, name);
        if (existsSync(path)) {
          try {
            chmodSync(path, 0o644);
          } catch {
            // already gone.
          }
        }
      }
    });

    it.skipIf(chmodIneffective)(
      "reports divergent with keyDiffs undefined for an unreadable whole-file target, never identical and never thrown -- it cannot be shown identical, and adopt never overwrites",
      () => {
        writeFileSync(join(templateRoot, "README.md"), "# __PROJECT_NAME__\n");
        writeFileSync(join(targetDir, "README.md"), "# acme\n");
        chmodSync(join(targetDir, "README.md"), 0o000);

        let thrown: unknown;
        let result: ReturnType<typeof planConflicts> | undefined;
        try {
          result = planConflicts(templateRoot, targetDir, {
            PROJECT_NAME: "acme",
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeUndefined();
        expect(result).toEqual([
          { relPath: "README.md", status: "divergent", keyDiffs: undefined },
        ]);
      },
    );

    it.skipIf(chmodIneffective)(
      "reports divergent with keyDiffs undefined for an unreadable key-level JSON target (package.json), not a key-level compare",
      () => {
        writeFileSync(
          join(templateRoot, "package.json"),
          JSON.stringify({ name: "__PROJECT_NAME__" }),
        );
        writeFileSync(
          join(targetDir, "package.json"),
          JSON.stringify({ name: "acme" }),
        );
        chmodSync(join(targetDir, "package.json"), 0o000);

        let thrown: unknown;
        let result: ReturnType<typeof planConflicts> | undefined;
        try {
          result = planConflicts(templateRoot, targetDir, {
            PROJECT_NAME: "acme",
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeUndefined();
        expect(result).toEqual([
          {
            relPath: "package.json",
            status: "divergent",
            keyDiffs: undefined,
          },
        ]);
      },
    );
  });

  /**
   * GAP: `compareFile`'s existence probe is a raw `existsSync(targetPath)`
   * -- `existsSync` swallows EVERY `stat` failure, including an ancestor
   * directory's search permission denied, and answers `false` identically
   * to a genuine miss. A file that actually exists under a `chmod 000`
   * directory is therefore reported `status: "absent"` today -- adopt
   * mode's report would then call it a "clean add" and `/customize` would
   * try to write straight over a file it never saw. This describe's RED
   * state: today's status is `"absent"`, with nothing recorded anywhere
   * naming the real reason.
   *
   * `planConflicts` is called with a 4th, optional `undetermined: string[]`
   * argument below -- the same convention every other survey/compare
   * collector in this package already uses (`guardedExists`, `walkBounded`)
   * -- so adopt mode can thread the SAME array `inventory.survey.undetermined`
   * already surfaces in the report (`report.ts`), rather than inventing a
   * new `ConflictStatus` value that the rest of the report doesn't know how
   * to render.
   */
  describe("a target file that exists under a directory this process cannot search (ancestor chmod 000)", () => {
    let lockedDir: string;

    beforeEach(() => {
      lockedDir = join(targetDir, "locked");
      mkdirSync(lockedDir);
      writeFileSync(join(lockedDir, "a.ts"), "# acme\n");
      mkdirSync(join(templateRoot, "locked"));
      writeFileSync(
        join(templateRoot, "locked", "a.ts"),
        "# __PROJECT_NAME__\n",
      );
    });

    afterEach(() => {
      chmodSync(lockedDir, 0o755);
    });

    it.skipIf(chmodIneffective)(
      "never reports 'absent' for a file that genuinely exists, and records the real EACCES reason",
      () => {
        chmodSync(lockedDir, 0o000);
        const undetermined: string[] = [];
        let thrown: unknown;
        let result: ReturnType<typeof planConflicts> | undefined;
        try {
          result = (
            planConflicts as unknown as (
              root: string,
              target: string,
              tokens: Record<string, string>,
              undetermined: string[],
            ) => ReturnType<typeof planConflicts>
          )(templateRoot, targetDir, { PROJECT_NAME: "acme" }, undetermined);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(lockedDir, 0o755);
        }

        expect(thrown).toBeUndefined();
        const entry = result?.find((r) => r.relPath === "locked/a.ts");
        expect(entry?.status).not.toBe("absent");
        expect(
          undetermined.some(
            (note) => note.includes(lockedDir) && note.includes("EACCES"),
          ),
        ).toBe(true);
      },
    );
  });

  describe("an emptied baseline subdirectory in target that is itself permission-locked, holding no existing files at all (ancestor chmod 000)", () => {
    let lockedDir: string;

    beforeEach(() => {
      lockedDir = join(targetDir, "bin");
      mkdirSync(lockedDir);
      mkdirSync(join(templateRoot, "bin"));
      // Two baseline files that map under the locked target directory: today
      // `compareFile`'s unresolvable branch names the probed FILE path
      // (`unreadableNote(targetPath, code)`), not the enclosing directory
      // like `guardedExists` does -- so each of these produces its OWN
      // distinct note, rather than the single enclosing-directory note this
      // test expects.
      writeFileSync(join(templateRoot, "bin", "a.ts"), "export {};");
      writeFileSync(join(templateRoot, "bin", "b.ts"), "export {};");
    });

    afterEach(() => {
      chmodSync(lockedDir, 0o755);
    });

    it.skipIf(chmodIneffective)(
      "names the enclosing directory once in undetermined, with no note per nonexistent baseline file under it",
      () => {
        chmodSync(lockedDir, 0o000);
        const undetermined: string[] = [];
        let thrown: unknown;
        let result: ReturnType<typeof planConflicts> | undefined;
        try {
          result = planConflicts(templateRoot, targetDir, {}, undetermined);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(lockedDir, 0o755);
        }

        expect(thrown).toBeUndefined();
        expect(result).toHaveLength(2);
        expect(undetermined).toEqual([unreadableNote(lockedDir, "EACCES")]);
      },
    );
  });

  describe("a baseline file that exists in target but is itself unreadable (EACCES on the read, not on the stat)", () => {
    const targetPath = () => join(targetDir, ".prettierignore");

    afterEach(() => {
      if (existsSync(targetPath())) {
        try {
          chmodSync(targetPath(), 0o644);
        } catch {
          // already gone.
        }
      }
    });

    it.skipIf(chmodIneffective)(
      "records the path in undetermined with EACCES (deduped, one entry) instead of silently reporting divergent with nothing recorded",
      () => {
        writeFileSync(join(templateRoot, ".prettierignore"), "dist\n");
        writeFileSync(targetPath(), "dist\n");
        chmodSync(targetPath(), 0o000);

        const undetermined: string[] = [];
        let thrown: unknown;
        let result: ReturnType<typeof planConflicts> | undefined;
        try {
          result = planConflicts(templateRoot, targetDir, {}, undetermined);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(targetPath(), 0o644);
        }

        expect(thrown).toBeUndefined();
        expect(result?.[0]?.status).toBe("divergent");
        expect(undetermined).toEqual([unreadableNote(targetPath(), "EACCES")]);
      },
    );
  });
});
