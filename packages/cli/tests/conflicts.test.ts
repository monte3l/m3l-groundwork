// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import {
  SurveyReadError,
  unreadableNote,
} from "../src/survey/internal/read-guard.js";
import { chmodIneffective } from "./chmod-ineffective.js";

/**
 * `statSync`/`lstatSync` are mocked (`importOriginal`-preserving, same
 * pattern as `fs-guard.test.ts`) only to reach `blockedAbsentNote`'s race
 * fallback (a `stat` reporting ENOENT, then a RACED `lstat` on the same path
 * finding it present and not a symlink -- the tree changed between the two
 * calls). Every other describe below never overrides these mocks, so the
 * global `beforeEach` passthrough makes them behave exactly like the real
 * `node:fs` for the real-filesystem tests in this file.
 */
const { statSyncMock, lstatSyncMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
  lstatSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, statSync: statSyncMock, lstatSync: lstatSyncMock };
});

let actualStatSync: typeof FsModule.statSync;
let actualLstatSync: typeof FsModule.lstatSync;

beforeAll(async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs");
  actualStatSync = actual.statSync;
  actualLstatSync = actual.lstatSync;
});

beforeEach(() => {
  statSyncMock.mockReset();
  lstatSyncMock.mockReset();
  statSyncMock.mockImplementation(actualStatSync);
  lstatSyncMock.mockImplementation(actualLstatSync);
});

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

describe("planConflicts: a dangling symlink at a baseline target path", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-dangling-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-dangling-target-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /**
   * A `stat` on a dangling symlink resolves the link and fails with `ENOENT`
   * -- the same errno a genuinely missing path raises -- so `probePath`
   * cannot tell "nothing here at all" apart from "a symlink here that
   * resolves to nothing" by errno alone. Reporting the latter `absent` would
   * have `/customize` (or any future direct-write path) write straight over
   * a real entry in the project's tree instead of surfacing the conflict.
   * RED today: `compareFile` reports `absent` (a clean add) for this case,
   * with nothing recorded.
   */
  it("is reported divergent (never absent/clean-add), with one note mentioning the dangling symlink", () => {
    mkdirSync(join(templateRoot, ".claude"), { recursive: true });
    writeFileSync(join(templateRoot, ".claude", "settings.json"), "{}");
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    const targetSettingsPath = join(targetDir, ".claude", "settings.json");
    symlinkSync(
      join(targetDir, ".claude", "does-not-exist-target"),
      targetSettingsPath,
    );

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: ReturnType<typeof planConflicts> | undefined;
    try {
      result = planConflicts(templateRoot, targetDir, {}, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    const entry = result?.find((r) => r.relPath === ".claude/settings.json");
    expect(entry?.status).toBe("divergent");
    expect(entry?.status).not.toBe("absent");
    expect(undetermined).toHaveLength(1);
    expect(
      undetermined.some(
        (note) =>
          note.includes(targetSettingsPath) &&
          note.toLowerCase().includes("dangling symlink"),
      ),
    ).toBe(true);
  });
});

describe("planConflicts: an enclosing path component is a regular file, not a directory (ENOTDIR on the stat)", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-entdir-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-entdir-target-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /**
   * `.claude` sitting as a plain FILE in the target makes a `stat` of any
   * baseline file nested under `.claude/` fail with `ENOTDIR`, the same
   * errno a genuinely absent nested path raises -- `probePath` folds both
   * into `absent` today (see `read-guard.ts`'s `ABSENT_CODES`, deliberately
   * shared with `guardedExists`/`walkBounded`, where that folding is
   * correct: there is nothing to read either way). For `planConflicts`
   * specifically that folding is wrong: a baseline file whose target
   * ancestor is a file, not a directory, cannot be written there without
   * first resolving that conflict, so it must never read as a silent clean
   * add. RED today: both baseline files under `.claude` report `absent`,
   * with nothing recorded.
   */
  it("reports every baseline file under the blocked ancestor as divergent, with one note naming the ancestor and ENOTDIR", () => {
    mkdirSync(join(templateRoot, ".claude"), { recursive: true });
    writeFileSync(join(templateRoot, ".claude", "settings.json"), "{}");
    writeFileSync(join(templateRoot, ".claude", "settings.local.json"), "{}");
    const blockedAncestor = join(targetDir, ".claude");
    writeFileSync(blockedAncestor, "not a directory");

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: ReturnType<typeof planConflicts> | undefined;
    try {
      result = planConflicts(templateRoot, targetDir, {}, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result).toHaveLength(2);
    for (const entry of result ?? []) {
      expect(entry.status).toBe("divergent");
      expect(entry.status).not.toBe("absent");
    }
    expect(undetermined).toEqual([unreadableNote(blockedAncestor, "ENOTDIR")]);
  });

  /**
   * The previous test's baseline file sits directly inside the blocked
   * ancestor, so `blockedAncestor`'s walk returns on its very first
   * iteration -- it never continues past one component. Nesting the
   * baseline file one level deeper forces the walk to climb past an
   * in-between path component (itself unreachable, same ENOTDIR, caught and
   * skipped) before reaching the real blocker two levels up.
   */
  it("walks past an in-between unreachable component to find the real blocking ancestor two levels up", () => {
    mkdirSync(join(templateRoot, ".claude", "sub"), { recursive: true });
    writeFileSync(join(templateRoot, ".claude", "sub", "settings.json"), "{}");
    const blockedAncestor = join(targetDir, ".claude");
    writeFileSync(blockedAncestor, "not a directory");

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: ReturnType<typeof planConflicts> | undefined;
    try {
      result = planConflicts(templateRoot, targetDir, {}, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.status).toBe("divergent");
    expect(result?.[0]?.status).not.toBe("absent");
    expect(undetermined).toEqual([unreadableNote(blockedAncestor, "ENOTDIR")]);
  });
});

describe("planConflicts: a target path's stat reports absent (ENOENT) but a raced lstat finds it present, not a symlink", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-race-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-race-target-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /**
   * `blockedAbsentNote` is only reached after `probePath`'s own `stat`
   * already reported the path absent (ENOENT). A genuinely missing path
   * answers ENOENT on `lstat` too, so the branch where `lstat` instead
   * succeeds and finds a non-symlink can only happen if the tree changed
   * between the two calls -- not reproducible with a real, single-threaded
   * filesystem, hence the mock naming only this one path.
   */
  it("records the path unreadable (ENOENT) and reports the entry divergent, rather than throwing on the mismatch", () => {
    mkdirSync(join(templateRoot, ".claude"), { recursive: true });
    writeFileSync(join(templateRoot, ".claude", "settings.json"), "{}");
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    const targetPath = join(targetDir, ".claude", "settings.json");

    statSyncMock.mockImplementation((path: unknown, ...args: unknown[]) => {
      if (path === targetPath) {
        throw Object.assign(new Error("simulated ENOENT (race)"), {
          code: "ENOENT",
        });
      }
      return actualStatSync(
        ...([path, ...args] as Parameters<typeof actualStatSync>),
      );
    });
    lstatSyncMock.mockImplementation((path: unknown, ...args: unknown[]) => {
      if (path === targetPath) {
        return { isSymbolicLink: () => false } as ReturnType<
          typeof actualLstatSync
        >;
      }
      return actualLstatSync(
        ...([path, ...args] as Parameters<typeof actualLstatSync>),
      );
    });

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: ReturnType<typeof planConflicts> | undefined;
    try {
      result = planConflicts(templateRoot, targetDir, {}, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    const entry = result?.find((r) => r.relPath === ".claude/settings.json");
    expect(entry?.status).toBe("divergent");
    expect(entry?.status).not.toBe("absent");
    expect(undetermined).toEqual([unreadableNote(targetPath, "ENOENT")]);
  });
});

describe("planConflicts: .claude itself is a symlink whose target does not exist (ancestor ENOENT on every nested baseline path)", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(
      join(tmpdir(), "conflicts-dangling-ancestor-template-"),
    );
    targetDir = mkdtempSync(
      join(tmpdir(), "conflicts-dangling-ancestor-target-"),
    );
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /**
   * `.claude` here is a symlink to a path that never existed, not a plain
   * file: resolving ANY nested path through it (`stat` or `lstat`) fails
   * with `ENOENT`, not `ENOTDIR` -- there is no file blocking the way, the
   * component itself just never resolves. `blockedAbsentNote`'s catch only
   * discriminates `ENOTDIR` (walking via `statSync` to find the blocking
   * file); it never walks ancestors with `lstat` to find a dangling symlink
   * one or more levels up, so both baseline files land `absent` with
   * nothing recorded instead of `divergent` naming `.claude`.
   */
  it("reports every baseline file under the dangling ancestor as divergent, with one note naming the symlink ancestor", () => {
    mkdirSync(join(templateRoot, ".claude"), { recursive: true });
    writeFileSync(join(templateRoot, ".claude", "settings.json"), "{}");
    writeFileSync(join(templateRoot, ".claude", "settings.local.json"), "{}");
    const danglingAncestor = join(targetDir, ".claude");
    symlinkSync(
      join(targetDir, "does-not-exist-claude-target"),
      danglingAncestor,
    );

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: ReturnType<typeof planConflicts> | undefined;
    try {
      result = planConflicts(templateRoot, targetDir, {}, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result).toHaveLength(2);
    for (const entry of result ?? []) {
      expect(entry.status).toBe("divergent");
      expect(entry.status).not.toBe("absent");
    }
    expect(undetermined).toHaveLength(1);
    expect(undetermined[0]).toContain(danglingAncestor);
    expect(undetermined[0]?.toLowerCase()).toContain("dangling symlink");
  });
});

describe("planConflicts: blockedAbsentNote's lstat fails with an errno other than ENOENT/ENOTDIR", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-lstat-eio-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-lstat-eio-target-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /**
   * `blockedAbsentNote`'s catch block treats every errno other than
   * `ENOTDIR` identically -- including one that says something about the
   * machine (`EIO`), not the project's tree. Today it silently returns
   * `undefined`, which `compareFile` reads as a genuine, clean "absent"; it
   * must instead throw, the same way `probePath`/`guardedRead` throw a
   * `SurveyReadError` naming the path with the original chained as `cause`
   * for any non-recorded errno.
   */
  it("throws a SurveyReadError chaining the lstat failure as cause, rather than reporting absent", () => {
    mkdirSync(join(templateRoot, ".claude"), { recursive: true });
    writeFileSync(join(templateRoot, ".claude", "settings.json"), "{}");
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    const targetPath = join(targetDir, ".claude", "settings.json");
    const lstatFailure = Object.assign(new Error("simulated EIO on lstat"), {
      code: "EIO",
    });

    statSyncMock.mockImplementation((path: unknown, ...args: unknown[]) => {
      if (path === targetPath) {
        throw Object.assign(new Error("simulated ENOENT"), {
          code: "ENOENT",
        });
      }
      return actualStatSync(
        ...([path, ...args] as Parameters<typeof actualStatSync>),
      );
    });
    lstatSyncMock.mockImplementation((path: unknown, ...args: unknown[]) => {
      if (path === targetPath) {
        throw lstatFailure;
      }
      return actualLstatSync(
        ...([path, ...args] as Parameters<typeof actualLstatSync>),
      );
    });

    let thrown: unknown;
    try {
      planConflicts(templateRoot, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SurveyReadError);
    expect((thrown as SurveyReadError).cause).toBe(lstatFailure);
  });

  // The default, un-raced case: a genuinely missing target path with no
  // symlink ancestor anywhere stays "absent", never divergent -- already
  // exercised by "reports absent for a file the target doesn't have" above;
  // restated here as a sibling fact to the two error-path tests in this
  // file, not a duplicate of its assertions.
  it("stays absent (never divergent) for a genuinely missing path with no symlink ancestor", () => {
    writeFileSync(join(templateRoot, "CLAUDE.md"), "# hi\n");
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result).toEqual([
      { relPath: "CLAUDE.md", status: "absent", keyDiffs: undefined },
    ]);
  });
});
