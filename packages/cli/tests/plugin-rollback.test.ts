// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Coverage for two `../src/plugin.js` branches `plugin-install.test.ts` and
 * `plugin-symlink.test.ts` cannot reach with a real filesystem alone:
 *
 * - `rollBack`'s own `catch` (its `rmSync` call failing while undoing a
 *   write failure) -- the "could not remove: <path>" clause appended to the
 *   wrapper message, and the file genuinely left behind on disk.
 * - `installError`'s non-`Error` `cause` arm (`String(cause)` rather than
 *   `cause.message`) -- real `fs` calls only ever throw `Error` subclasses,
 *   so this needs a collaborator that deliberately throws something else.
 *
 * Both need a seam `rmSync`/`writeFileSync` cannot provide while behaving
 * like real `fs`, so this file mocks `node:fs` (the same `vi.hoisted`
 * partial-mock pattern `git.test.ts` uses for `node:child_process`),
 * preserving every real implementation except the two functions under test
 * -- which, by default, delegate to the real implementation too, and only
 * misbehave for the one path/call each test targets.
 *
 * Every import of `rmSync`/`writeFileSync` from "node:fs" in THIS file
 * resolves to the mock (vi.mock replaces the whole module for every
 * importer, including this file's own top-level import) -- so the "real"
 * fallback a passthrough needs is captured once, inside the mock factory,
 * from `importOriginal`, never re-imported by name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import { CUSTOMIZE_SKILL_FILE_NAMES } from "../src/customize-paths.js";

// vi.mock(...) is hoisted above every other statement in this file,
// including a plain top-level `let` -- so the real implementations this
// file's "passthrough" default needs are captured into a vi.hoisted() ref
// object instead, mutated once from inside the mock factory below.
const { rmSyncMock, writeFileSyncMock, lstatSyncMock, readFileSyncMock, real } =
  vi.hoisted(() => ({
    rmSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    lstatSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    real: {} as {
      rmSync: typeof NodeFs.rmSync;
      writeFileSync: typeof NodeFs.writeFileSync;
      lstatSync: typeof NodeFs.lstatSync;
      readFileSync: typeof NodeFs.readFileSync;
    },
  }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  real.rmSync = actual.rmSync;
  real.writeFileSync = actual.writeFileSync;
  real.lstatSync = actual.lstatSync;
  real.readFileSync = actual.readFileSync;
  return {
    ...actual,
    rmSync: rmSyncMock,
    writeFileSync: writeFileSyncMock,
    lstatSync: lstatSyncMock,
    readFileSync: readFileSyncMock,
  };
});

const { installCustomizeSkill, installCustomizeSkillGuarded } =
  await import("../src/plugin.js");

// File-level default for lstatSyncMock/readFileSyncMock: every test in this
// file delegates to the real implementation unless it layers its own
// mockImplementation on top for one specific path -- the same
// passthrough-by-default pattern each describe below already uses for
// rmSyncMock/writeFileSyncMock. Registered at file scope (not inside any one
// describe's own beforeEach) so it runs for every test regardless of which
// describe it lives in.
beforeEach(() => {
  lstatSyncMock.mockImplementation(
    (...args: Parameters<typeof NodeFs.lstatSync>) => real.lstatSync(...args),
  );
  readFileSyncMock.mockImplementation(
    (...args: Parameters<typeof NodeFs.readFileSync>) =>
      real.readFileSync(...args),
  );
});

afterEach(() => {
  lstatSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

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

/** Builds the same five-file payload fixture `plugin-symlink.test.ts` uses. */
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
  for (const stepName of ["step-0-reconcile.md", "step-3-round-1.md"]) {
    writeFileSync(
      join(sourceDir, "skills", "customize", stepName),
      `# ${stepName}\n`,
    );
  }
}

/**
 * Pre-populates `.groundwork/customize/` with all five payload files holding
 * `content` -- simulating a stale prior fallback install this run re-visits.
 */
function writeGroundworkSkillPayload(targetDir: string, content: string): void {
  const dir = join(targetDir, ".groundwork", "customize");
  mkdirSync(dir, { recursive: true });
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    writeFileSync(join(dir, name), content);
  }
}

describe("installCustomizeSkill rollback and error-normalization edge cases", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;

  beforeEach(() => {
    // Default: delegate to the real implementation. Only a test that layers
    // its own mockImplementation on top changes behavior, and only for the
    // path(s)/call(s) it names.
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );

    sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-target-"));
    writeSourceFixture(sourceDir);
    destDir = join(targetDir, ".claude", "skills", "customize");
  });

  afterEach(() => {
    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
    // A plain vi.fn() created inside a top-level vi.mock(...)/vi.hoisted(...)
    // factory is not cleared by vi.restoreAllMocks() (that only undoes
    // vi.spyOn spies) -- reset call history and any per-test
    // mockImplementation explicitly.
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("[rollback can't-remove] names a file rollback itself failed to remove, which is genuinely left behind, while the other rolled-back files are removed", () => {
    const kindFacetDest = join(destDir, "kind-facet-map.ts");
    const domainMapDest = join(destDir, "domain-map.ts");
    const packMapDest = join(destDir, "pack-map.ts");
    const pluginMapDest = join(destDir, "plugin-map.ts");

    // plugin-map.ts (the 4th file in write order) fails to write: its own
    // pre-write `rmSync(dest, { force: true })` throws -- a plain injected
    // failure via the fs-mock seam (not a real directory planted at its
    // destination: `assertNoDirectoryAtPayloadNames`, ../src/plugin.js, now
    // refuses a directory at any payload name before anything is removed or
    // written, so that injection can no longer reach this mid-loop failure
    // at all -- see plugin-preflight.test.ts). This is the natural failure
    // that triggers a rollback of the three files written before it.
    //
    // domain-map.ts's rmSync is called twice: once as part of its own
    // pre-write cleanup (must succeed, so the real write proceeds and the
    // file is added to `written`), and once during rollback after
    // plugin-map.ts's write fails (made to fail here). Count per-path calls
    // so only the SECOND call against this exact path misbehaves.
    const callCounts = new Map<string, number>();
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.rmSync>): void => {
        const [target] = args;
        const key = String(target);
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (key === pluginMapDest && count === 1) {
          const failure = new Error(
            "EBUSY: resource busy or locked, unlink (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EBUSY";
          throw failure;
        }
        if (key === domainMapDest && count === 2) {
          // A real errno-bearing fs error, the same shape Node itself
          // throws (an Error with a `.code` property) -- not a plain
          // message string -- since item 6 requires the errno code to be
          // threaded through per path, not just embedded in free text.
          const failure = new Error(
            "EACCES: permission denied, unlink (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        real.rmSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(pluginMapDest);
    expect(message).toContain("removed the 2 file(s) written by this run");
    // [item 6] the could-not-remove list must include the errno code
    // alongside the path, not just the bare path.
    expect(message).toContain(domainMapDest);
    expect(message).toContain("EACCES");
    expect((thrown as Error).cause).toBeInstanceOf(Error);

    // Rolled back successfully: removed by this run's own rollback.
    expect(existsSync(kindFacetDest)).toBe(false);
    expect(existsSync(packMapDest)).toBe(false);
    // Rollback's own rmSync failed for this one: genuinely left behind.
    expect(existsSync(domainMapDest)).toBe(true);
  });

  // The intentional non-Error throw below exercises installError's
  // `cause instanceof Error ? cause.message : String(cause)` fallback arm --
  // real `fs` calls never throw a non-Error, so only a deliberately
  // misbehaving collaborator reaches it.
  it("[non-Error cause] normalizes a non-Error thrown value via String(cause), and preserves the raw value as cause", () => {
    const kindFacetDest = join(destDir, "kind-facet-map.ts");
    mkdirSync(destDir, { recursive: true });

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>): void => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to verify installError's String(cause) normalization
          throw "disk full (simulated)";
        }
        real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(kindFacetDest);
    // The non-Error cause was stringified into the wrapper's own message...
    expect(message).toContain("disk full (simulated)");
    // ...but preserved RAW (not re-wrapped) as the Error's `cause`.
    expect((thrown as Error).cause).toBe("disk full (simulated)");
    // kind-facet-map.ts is the first file written; nothing had been written
    // yet when it failed, so the rollback had nothing to do.
    expect(message).toContain("removed the 0 file(s) written by this run");
  });
});

/**
 * Item 1: today, a payload file is only added to the rollback candidate
 * list AFTER its write call returns successfully (see `written.push(dest)`
 * in `copyCustomizeSkillFiles`). A `"wx"` write that physically CREATES the
 * file (the open succeeds) but then fails partway through writing its
 * content -- e.g. `ENOSPC` after the first chunk -- throws before that
 * push ever runs, so the half-written file it already created is never
 * handed to `rollBack` and is left behind on disk: a genuine partial-write
 * leak the "all-or-nothing" contract promises can't happen. The fix this
 * suite is written against: a file this call's own write physically
 * created must be rolled back even when the write call itself is the one
 * that failed, for a data file and for SKILL.md, in both install
 * locations.
 */
describe('a failed "wx" write that created the file leaves nothing behind (item 1)', () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  /**
   * Makes the mocked `writeFileSync` behave like a real `"wx"` write that
   * successfully creates `targetPath` (so it genuinely exists on disk)
   * before failing partway through -- simulating e.g. `ENOSPC` reached
   * after the file was already opened and partially written.
   */
  function mockPartialWriteFailure(targetPath: string): void {
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === targetPath) {
          real.writeFileSync(target, "PARTIAL CONTENT", { flag: "wx" });
          throw new Error("ENOSPC: no space left on device (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );
  }

  it("[data file, .claude] rolls back the partially-created kind-facet-map.ts (1st file), and a re-run after the cause is fixed installs cleanly", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1a-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1a-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const dest = join(destDir, "kind-facet-map.ts");
    mockPartialWriteFailure(dest);

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "removed the 1 file(s) written by this run",
    );
    // The partially-created file was rolled back -- nothing left behind.
    expect(existsSync(dest)).toBe(false);

    // Fix the cause (restore a real passthrough) and re-run: installs
    // cleanly over the same, now-empty destination.
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
    const result = installCustomizeSkill(targetDir, sourceDir);
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(dest, "utf8")).toBe("export const x = 1;\n");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[SKILL.md, .claude] rolls back the partially-created SKILL.md (last file) along with every file already written before it", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1b-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1b-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const dest = join(destDir, "SKILL.md");
    mockPartialWriteFailure(dest);

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Every non-SKILL.md payload file written before SKILL.md, plus the partially
    // created SKILL.md itself: the whole payload.
    expect((thrown as Error).message).toContain(
      `removed the ${String(CUSTOMIZE_SKILL_FILE_NAMES.length)} file(s) written by this run`,
    );
    expect(existsSync(dest)).toBe(false);
    for (const name of [
      "kind-facet-map.ts",
      "domain-map.ts",
      "pack-map.ts",
      "plugin-map.ts",
    ]) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[data file, .groundwork] rolls back the partially-created domain-map.ts (2nd file) at the .groundwork destination", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1c-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1c-tgt-"));
    writeSourceFixture(sourceDir);
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const dest = join(destDir, "domain-map.ts");
    mockPartialWriteFailure(dest);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // kind-facet-map.ts (1st) already written, plus the partially-created
    // domain-map.ts itself: 2 total.
    expect((thrown as Error).message).toContain(
      "removed the 2 file(s) written by this run",
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(destDir, "kind-facet-map.ts"))).toBe(false);
    // The project's own, untouched .claude/ SKILL.md is unaffected.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[SKILL.md, .groundwork] rolls back the partially-created SKILL.md (last file) at the .groundwork destination", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1d-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i1d-tgt-"));
    writeSourceFixture(sourceDir);
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const dest = join(destDir, "SKILL.md");
    mockPartialWriteFailure(dest);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      `removed the ${String(CUSTOMIZE_SKILL_FILE_NAMES.length)} file(s) written by this run`,
    );
    expect(existsSync(dest)).toBe(false);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 3: `copyCustomizeSkillFiles` writes every destination via
 * `rmSync(dest, { force: true })` immediately followed by
 * `writeFileSync(dest, content, { flag: "wx" })` -- today, for BOTH install
 * locations alike. For the strictly-additive `.claude/skills/customize/`
 * destination (reached only when the top-level presence probe found
 * NOTHING there), that unconditional pre-`rmSync` is itself a hazard: if a
 * project entry is created at that exact path in the narrow window between
 * the presence probe and this file's own write (a real TOCTOU race, not
 * hypothetical -- nothing serializes the two), the pre-`rmSync` silently
 * deletes that raced-in entry and writes through it with no error at all.
 * The fix this suite is written against: the `.claude` destination must
 * drop the pre-`rmSync` and rely on `"wx"` alone, so a raced-in entry makes
 * the write fail `EEXIST` (caught and rolled back, like any other write
 * failure) instead of being silently clobbered. `.groundwork/customize/`
 * is the CLI's own destination (never a project's), so it keeps
 * remove-then-`"wx"` unchanged.
 */
describe('.claude path does not pre-rmSync before "wx" (item 3)', () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  /**
   * Plants `raceContent` at `racePath` the first time EITHER mocked
   * function (`rmSync` or `writeFileSync`) is called against it -- whichever
   * one the implementation touches first for that destination. This
   * reproduces "an entry appears between the presence check and the
   * write" regardless of whether the implementation still runs a
   * pre-`rmSync` for it: under the OLD (pre-fix) code, the pre-`rmSync`
   * call is what's intercepted first, and delegating it to the real
   * `rmSync` promptly deletes the very entry just planted -- silently
   * destroying it before the write ever runs. Under the fix, the first (and
   * only) touch is the real `"wx"` write itself, which then fails `EEXIST`
   * against the entry this helper planted.
   */
  function raceInAnEntryBeforeFirstTouch(
    racePath: string,
    raceContent: string,
  ): void {
    let planted = false;
    const plantOnce = (target: string): void => {
      if (!planted && target === racePath) {
        planted = true;
        real.writeFileSync(racePath, raceContent);
      }
    };
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.rmSync>) => {
        const [target] = args;
        plantOnce(String(target));
        return real.rmSync(...args);
      },
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        plantOnce(String(target));
        return real.writeFileSync(...args);
      },
    );
  }

  it("a project entry that appears mid-install at the .claude destination survives untouched; the write fails EEXIST and rolls back, naming the race", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i3a-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i3a-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const raceDest = join(destDir, "domain-map.ts");
    const raceContent =
      "// RACED-IN PROJECT CONTENT, not created by this call\n";
    raceInAnEntryBeforeFirstTouch(raceDest, raceContent);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("appeared during the install");
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe(
      "EEXIST",
    );
    // Never removed: this call did not create it.
    expect(readFileSync(raceDest, "utf8")).toBe(raceContent);
    // The file written before the race (kind-facet-map.ts) was rolled back.
    expect(existsSync(join(destDir, "kind-facet-map.ts"))).toBe(false);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[.groundwork keeps remove-then-wx, regression guard] the same race at the .groundwork destination is still silently replaced (unchanged), since that destination is CLI-owned, never a project's", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i3b-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-i3b-tgt-"));
    writeSourceFixture(sourceDir);
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const raceDest = join(destDir, "domain-map.ts");
    raceInAnEntryBeforeFirstTouch(raceDest, "// stale groundwork content\n");

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(raceDest, "utf8")).toBe("export const y = 2;\n");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 6 (missing-source wrapping): `copyCustomizeSkillFiles` reads every
 * payload file from `sourceDir` before writing anything, and today throws a
 * bare, unwrapped `Error` ("the /customize skill's source file is
 * missing: ...") when one is absent -- every OTHER failure path in this
 * module is normalized through `installError`'s "could not install the
 * /customize skill: ..." wrapper, but this one escapes it.
 */
describe("a missing source payload file is wrapped the same way as every other failure (item 6)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("wraps the missing-source error as 'could not install the /customize skill ...'", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-missing-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-missing-tgt-"),
    );
    writeSourceFixture(sourceDir);
    // Remove one source payload file after the fixture was written.
    real.rmSync(join(sourceDir, "src", "pack-map.ts"), { force: true });

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("is missing");
    expect(message).toContain(join(sourceDir, "src", "pack-map.ts"));

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Moved from plugin-install.test.ts's "interrupted-install repair" suite: a
 * directory planted at SKILL.md can no longer inject this failure, since
 * classifyExistingSkill now diverts ANY non-regular entry under SKILL.md's
 * name to .groundwork/customize/ before a repair write is ever attempted
 * (see plugin-install.test.ts's "classifyExistingSkill diverts ANY
 * non-regular entry..." suite). This uses the fs-mock seam instead, so the
 * four data files genuinely are byte-identical regular files (the
 * "interrupted install, only SKILL.md missing" repair state) and only the
 * SKILL.md write itself fails.
 */
describe("interrupted-install repair: the SKILL.md write itself fails (item 4, fs-mock injection)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("rolls back the same way as any other write failure if the SKILL.md repair write itself fails", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-repair-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-repair-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    // The four data files are already current -- the "interrupted install,
    // only SKILL.md missing" repair state -- so classifyExistingSkill
    // reaches "installable" and installCustomizeSkillGuarded attempts to
    // repair in place, writing only the missing SKILL.md.
    writeFileSync(join(destDir, "kind-facet-map.ts"), "export const x = 1;\n");
    writeFileSync(join(destDir, "domain-map.ts"), "export const y = 2;\n");
    writeFileSync(join(destDir, "pack-map.ts"), "export const z = 3;\n");
    writeFileSync(join(destDir, "plugin-map.ts"), "export const w = 4;\n");

    const skillMdDest = join(destDir, "SKILL.md");
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "could not install the /customize skill",
    );
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe(
      "EACCES",
    );
    // [item 3] Adopt mode (installCustomizeSkillGuarded) keeps the generic
    // "fix the cause and re-run the CLI" remediation -- it has no
    // "--fresh --force" flag to point at, unlike fresh mode's own
    // installCustomizeSkill.
    expect((thrown as Error).message).toContain(
      "fix the cause and re-run the CLI",
    );
    expect((thrown as Error).message).not.toContain("--fresh --force");
    // The four already-correct data files are untouched by the failed
    // repair attempt -- still exactly their original content.
    expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(destDir, "domain-map.ts"), "utf8")).toBe(
      "export const y = 2;\n",
    );
    expect(readFileSync(join(destDir, "pack-map.ts"), "utf8")).toBe(
      "export const z = 3;\n",
    );
    expect(readFileSync(join(destDir, "plugin-map.ts"), "utf8")).toBe(
      "export const w = 4;\n",
    );
    // The write never created SKILL.md -- nothing to roll back there.
    expect(existsSync(skillMdDest)).toBe(false);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * The second half of fresh mode's `--force` re-install coverage (the first,
 * real-fs half lives in `plugin-install.test.ts`): a re-run over an
 * ALREADY-installed `.claude/skills/customize/` whose own write fails
 * mid-way (not via an `EISDIR` obstacle, but a plain injected write failure)
 * must still never leave the PREVIOUS run's `SKILL.md` sitting there
 * loadable beside missing/stale data.
 */
describe("fresh-mode --force over an existing install removes the old SKILL.md first, even when the re-run's own write fails mid-way", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("leaves no SKILL.md when the re-run's write to domain-map.ts (2nd file) fails mid-way", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-force-reinstall-mock-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-force-reinstall-mock-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const kindFacetDest = join(destDir, "kind-facet-map.ts");

    // First run: a plain, successful install via the real passthrough -- a
    // genuinely WORKING install, every payload file already correct.
    const first = installCustomizeSkill(targetDir, sourceDir);
    expect(first.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(true);

    // Make kind-facet-map.ts (1st file) genuinely differ before the re-run:
    // the overwrite policy's classify-first no-op contract (a byte-identical
    // re-run writes nothing at all) would otherwise make this re-run touch
    // NOTHING, and the domain-map.ts write-failure mock below would never
    // fire. This forces classifyExistingSkill to see something other than
    // "current", so the re-run actually proceeds to remove-and-rewrite.
    real.writeFileSync(kindFacetDest, "DIFFERENT\n");

    // Re-run (as --force would, in fresh mode); this time domain-map.ts's
    // write throws mid-way.
    const domainMapDest = join(destDir, "domain-map.ts");
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          throw new Error("EACCES: permission denied, write (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    // The PREVIOUS run's SKILL.md must not survive this failed re-run.
    expect(
      lstatSync(join(destDir, "SKILL.md"), { throwIfNoEntry: false }),
    ).toBeUndefined();

    // [item 1] The failure also erased the PREVIOUS WORKING install's own
    // content, not just this run's own write: the stale SKILL.md was
    // unconditionally removed before the data loop even started (as
    // documented), and kind-facet-map.ts (written successfully, then rolled
    // back by `rollBack`) is also gone -- the working copy it held before
    // this re-run is NOT restored. The message must say so, naming each
    // entry, rather than only reporting this run's own rollback count. The
    // overwrite policy's wording calls SKILL.md "the existing SKILL.md"
    // (not "stale") -- the "stale" phrasing is reserved for the
    // .groundwork cli-owned destination.
    expect(message).toContain("the existing SKILL.md");
    expect(message).toContain(kindFacetDest);
    expect(message).toContain(
      "removed and NOT restored -- the skill is not loadable until a successful re-run",
    );
    // The existing rollback-count clause must still be present alongside
    // the new one.
    expect(message).toContain("removed the 1 file(s) written by this run");
    // [item 3, revised for S3] Fresh mode's own remediation still names
    // --fresh --force, never the generic "fix the cause and re-run the CLI"
    // every other install failure gets -- but it must not ADD a second "re-
    // run" mention of its own: this message already legitimately says "a
    // successful re-run" (the overwrite policy's own "not loadable" clause,
    // unrelated to the remediation suffix), and main.ts's outer wrap is the
    // one place that states the full re-run instruction when this error is
    // reached through runFresh (see plugin-payload-read.test.ts's "[item 3]"
    // test and main-run.test.ts for the rest of this contract). So the total
    // count of "re-run" anywhere in this message must stay at exactly the
    // ONE pre-existing mention, not grow to two.
    expect(message).toContain("--fresh --force");
    expect(message).not.toContain("fix the cause and re-run the CLI");
    const reRunOccurrences = (message.match(/re-run/gi) ?? []).length;
    expect(reRunOccurrences).toBe(1);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 3: `installCustomizeSkill` (fresh mode's "overwrite" policy) today
 * never classifies what is already at the destination before writing --
 * every re-run unconditionally removes and rewrites every payload file, even
 * when the destination is already byte-for-byte identical to what this run
 * would write (a plain re-run of the CLI over its own output, with no
 * `--force`-driven change at all). The fix this suite is written against:
 * classify first (the same byte-for-byte comparison
 * `installCustomizeSkillGuarded`'s `classifyExistingSkill` already performs
 * for adopt mode), and when every payload file is already current, return
 * without removing or rewriting anything -- mirroring the adopt-mode
 * `"already-present"` result's own `filesWritten: []` convention for "we
 * verified it, we touched nothing".
 *
 * `plugin-symlink.test.ts`'s "plain run (no symlinks) is unchanged by the
 * guard" suite's second-run test was updated alongside this one (renamed to
 * "...is a no-op") to assert `filesWritten: []` on a second, byte-identical
 * run rather than the full five-name list again -- the two suites agree on
 * this contract.
 */
describe("installCustomizeSkill classifies before writing: a byte-identical re-run is a no-op (item 3)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("removes and rewrites nothing on a second install over an already byte-identical .claude/skills/customize/", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-noop-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-noop-tgt-"));
    writeSourceFixture(sourceDir);

    const first = installCustomizeSkill(targetDir, sourceDir);
    expect(first.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);

    const destDir = join(targetDir, ".claude", "skills", "customize");
    const skillMdPath = join(destDir, "SKILL.md");
    const mtimeBefore = statSync(skillMdPath).mtimeMs;

    rmSyncMock.mockClear();
    writeFileSyncMock.mockClear();

    const second = installCustomizeSkill(targetDir, sourceDir);

    expect(second.filesWritten).toEqual([]);
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(statSync(skillMdPath).mtimeMs).toBe(mtimeBefore);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 4: `assertNoDirectoryAtPayloadNames` (`../src/plugin.js`) today
 * silently swallows ANY `lstat` failure against a payload name (not just a
 * missing entry) and leaves the obstacle "to its own remove/write" -- for a
 * policy that REPLACES existing entries (`"overwrite"`, `"cli-owned"`), that
 * means a transient `lstat` failure (e.g. a permissions race, an `EIO`) is
 * never reported as a pre-flight refusal at all; the run proceeds to
 * remove-then-rewrite past an obstacle it never actually judged. The fix
 * this suite is written against: under a replacing policy, a pre-flight
 * `lstat` failure refuses the whole install up front ("could not inspect
 * <path>; nothing was removed or written", the raw error as `cause`),
 * before anything is removed or written. The purely-additive policy keeps
 * today's behavior unchanged (continues, left to the real write).
 *
 * NOTE for the hub: the exact call-site this fix lands in may also be
 * touched by item 3's classify-first change for the "overwrite" policy --
 * if a future unified classify+preflight pass calls `lstat` more than once
 * per payload name before any write is attempted, the single unconditional
 * failure this test injects would surface during whichever call reaches it
 * first. The assertions below are intentionally about the OUTER contract
 * (the wrapper message's wording, the cause, nothing written) rather than
 * which internal call produced it, so they should hold either way; flagging
 * the coupling here rather than guessing at an implementation it doesn't
 * own.
 */
describe("a pre-flight lstat failure refuses a replacing-policy install, and nothing is touched (item 4)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("[overwrite, fresh mode] refuses the whole install, naming the path and leaving nothing written", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-io-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-io-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const kindFacetDest = join(destDir, "kind-facet-map.ts");

    const probeFailure = new Error(
      "EIO: some I/O error (simulated)",
    ) as NodeJS.ErrnoException;
    probeFailure.code = "EIO";
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          throw probeFailure;
        }
        return real.lstatSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(`could not inspect ${kindFacetDest}`);
    expect(message).toContain("nothing was removed or written");
    expect((thrown as Error).cause).toBe(probeFailure);

    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[cli-owned, .groundwork fallback] refuses the whole install the same way", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-gw-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-gw-tgt-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const kindFacetDest = join(destDir, "kind-facet-map.ts");

    const probeFailure = new Error(
      "EIO: some I/O error (simulated)",
    ) as NodeJS.ErrnoException;
    probeFailure.code = "EIO";
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          throw probeFailure;
        }
        return real.lstatSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(`could not inspect ${kindFacetDest}`);
    expect(message).toContain("nothing was removed or written");
    expect((thrown as Error).cause).toBe(probeFailure);

    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    // The project's own differing .claude/ SKILL.md is untouched.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  // [regression guard] the additive policy must keep today's behavior: a
  // pre-flight lstat failure is left to the real write, not refused. This
  // already passes under today's code (assertNoDirectoryAtPayloadNames
  // swallows every policy's lstat failure); item 4 must not change that for
  // "additive".
  it("[additive, first-time adopt install] still continues past its own lstat failure, leaving the failure to the real write", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-add-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-add-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const domainMapDest = join(destDir, "domain-map.ts");

    // The first lstat call against this path is classifyExistingSkill's own
    // probe (must succeed -- the file genuinely does not exist yet); the
    // second is assertNoDirectoryAtPayloadNames's own probe for the SAME
    // name, since "installable" classification over a brand-new install
    // leaves `alreadyCurrent` empty.
    let calls = 0;
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          calls += 1;
          if (calls >= 2) {
            throw new Error("EIO: preflight probe failure (simulated)");
          }
        }
        return real.lstatSync(...args);
      },
    );

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("claude");
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(domainMapDest, "utf8")).toBe("export const y = 2;\n");
    expect(calls).toBeGreaterThanOrEqual(2);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 5: when a write failure's own rollback ALSO fails to remove SKILL.md
 * -- the one file whose presence makes Claude Code load the skill at all --
 * today's generic "(could not remove: <path> (<code>))" clause gives no
 * sense of how serious that specific leftover is. The fix this suite is
 * written against: a left-behind SKILL.md gets its own, specific warning
 * telling the operator to delete it by hand, and why (Claude Code will load
 * a truncated skill otherwise).
 */
describe("a left-behind SKILL.md after a failed rollback gets its own warning (item 5)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("says to delete it by hand since Claude Code will load a truncated skill", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-item5-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-item5-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const skillMdDest = join(destDir, "SKILL.md");

    // SKILL.md's own "wx" write physically creates it, then fails mid-way.
    // Tracked via a flag (not an unconditional throw) so the PRE-write
    // cleanup rmSync (writePayloadFile's own remove-then-"wx", a harmless
    // no-op here since nothing exists yet) is left alone -- only the
    // ROLLBACK's later rmSync against this same path must fail.
    let writeAttempted = false;
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          writeAttempted = true;
          real.writeFileSync(target, "PARTIAL CONTENT", { flag: "wx" });
          throw new Error("ENOSPC: no space left on device (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );
    // Rollback's own removal of SKILL.md fails too -- genuinely left behind.
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.rmSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest && writeAttempted) {
          const failure = new Error(
            "EBUSY: resource busy or locked, unlink (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EBUSY";
          throw failure;
        }
        return real.rmSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(skillMdDest);
    expect(message).toContain("delete it by hand");
    expect(message).toContain("Claude Code will load a truncated skill");
    // Genuinely left behind: rollback's own removal failed.
    expect(existsSync(skillMdDest)).toBe(true);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 6 (part a): `installToGroundwork`'s own `catch` (`../src/plugin.js`,
 * around the `.groundwork/customize/` fallback) re-wraps whatever
 * `copyCustomizeSkillFiles` throws -- which, for every failure that function
 * can produce, is ALREADY an `installError`-wrapped `Error` whose own
 * message starts with "could not install the /customize skill: ...". The
 * outer re-wrap prepends that exact same prefix a second time around the
 * inner message, so the final thrown message contains it twice. The fix
 * this suite is written against: the prefix must appear exactly once,
 * while the fallback's own reason clause survives untouched.
 */
describe("the fallback-install re-wrap does not duplicate the 'could not install the /customize skill:' prefix (item 6a)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("names the wrapper prefix exactly once and still carries the fallback's own reason", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-item6a-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-item6a-tgt-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const domainMapDest = join(destDir, "domain-map.ts");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    const prefix = "could not install the /customize skill:";
    const occurrences = message.split(prefix).length - 1;
    expect(occurrences).toBe(1);
    expect(message).toContain("fell back to .groundwork/customize/");
    expect(message).toContain("and that install failed too");
    // [item 3] The fallback path is still adopt mode (installCustomizeSkillGuarded):
    // it keeps the generic "fix the cause and re-run the CLI" remediation,
    // never fresh mode's "--fresh --force" advice.
    expect(message).toContain("fix the cause and re-run the CLI");
    expect(message).not.toContain("--fresh --force");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * `createdByFailedWrite` (`../src/plugin.js`) silently treats its OWN
 * `lstat` call failing as "not created" -- a write failure whose
 * `createdByFailedWrite` probe itself throws is indistinguishable, in
 * today's rollback message, from a write that genuinely created nothing.
 * The fix this test is written against: that genuine uncertainty must be
 * surfaced in the thrown error's own message, naming the path and saying
 * plainly that whether it was created is unknown, rather than silently
 * asserting "not created".
 */
describe("createdByFailedWrite surfaces its own lstat failure instead of silently assuming 'not created'", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("names the path and says 'was left in place; whether this run created it is unknown' rather than silently treating it as not created (item 4: no parenthetical)", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-lstat-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-lstat-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const domainMapDest = join(destDir, "domain-map.ts");

    // A write failure with no .code/.syscall -- reaches
    // createdByFailedWrite's own lstat check (not short-circuited by the
    // EEXIST/"open" fast paths).
    let writeAttempted = false;
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          writeAttempted = true;
          throw new Error("EIO: some I/O error (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );
    // createdByFailedWrite's own lstat(dest) call fails outright -- but only
    // AFTER the write was attempted. [item 4] a replacing policy now refuses
    // up front on a pre-flight lstat failure, so this mock must not also
    // misfire during assertNoDirectoryAtPayloadNames's own, earlier probe of
    // this same path -- that one must still succeed, same as it does on a
    // real filesystem where nothing is wrong yet.
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest && writeAttempted) {
          throw new Error("EIO: lstat itself failed (simulated)");
        }
        return real.lstatSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(domainMapDest);
    // [item 4] no "(unknown whether created)" parenthetical -- the clause
    // reads as one plain sentence instead.
    expect(message).not.toContain("(unknown whether created)");
    expect(message).toContain(
      `${domainMapDest} was left in place; whether this run created it is unknown`,
    );
    // An "unknown whether created" entry gets its own clause -- "left in
    // place; whether this run created it is unknown" -- rather than being
    // folded into the "(could not remove: ...)" list alongside entries that
    // genuinely failed removal. This is the ONLY leftBehind-like entry in
    // this scenario, so the generic "could not remove:" clause must not
    // appear at all.
    expect(message).toContain(
      "left in place; whether this run created it is unknown",
    );
    expect(message).not.toContain("could not remove:");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item A: rollback positions, moved from plugin-install.test.ts.
 * `assertNoDirectoryAtPayloadNames` (`../src/plugin.js`) now refuses a
 * directory at any payload name before anything is removed or written (see
 * `plugin-preflight.test.ts`), so the real-fs technique these four tests
 * used to inject a mid-loop write failure (planting a non-empty directory at
 * the failing payload name) can no longer reach that failure at all -- the
 * install is refused up front instead. Each test below injects the same
 * failure position via the fs-mock seam (`writeFileSyncMock`) instead,
 * preserving the original rollback-position/count/cause/location
 * assertions.
 */
describe("item A: rollback positions, moved from plugin-install.test.ts (preflight now refuses a directory obstacle before anything is touched)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("rolls back after the 2nd payload file (domain-map.ts) fails to write -- .claude destination", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-c2-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-c2-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    // An unrelated, pre-existing project file in the same directory.
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const domainMapDest = join(destDir, "domain-map.ts");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 1 file(s) written by this run");
    expect((thrown as Error).cause).toBeDefined();

    // kind-facet-map.ts (written first) was rolled back.
    expect(existsSync(join(destDir, "kind-facet-map.ts"))).toBe(false);
    // domain-map.ts's own write never succeeded.
    expect(existsSync(domainMapDest)).toBe(false);
    // SKILL.md, written last, was never reached.
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
    // pack-map.ts/plugin-map.ts were never attempted.
    expect(existsSync(join(destDir, "pack-map.ts"))).toBe(false);
    expect(existsSync(join(destDir, "plugin-map.ts"))).toBe(false);
    // The pre-existing project file survives untouched.
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    // After the cause is fixed, a re-run installs cleanly.
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
    const result = installCustomizeSkill(targetDir, sourceDir);
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toContain(
      "name: customize",
    );
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("rolls back after the LAST payload file (SKILL.md) fails to write -- .claude destination", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-cl-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-cl-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const skillMdDest = join(destDir, "SKILL.md");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(
      `removed the ${String(CUSTOMIZE_SKILL_FILE_NAMES.length - 1)} file(s) written by this run`,
    );
    expect((thrown as Error).cause).toBeDefined();

    for (const name of [
      "kind-facet-map.ts",
      "domain-map.ts",
      "pack-map.ts",
      "plugin-map.ts",
    ]) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    expect(existsSync(skillMdDest)).toBe(false);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
    const result = installCustomizeSkill(targetDir, sourceDir);
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("rolls back after the 2nd payload file (domain-map.ts) fails to write -- .groundwork destination", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-g2-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-g2-tgt-"),
    );
    writeSourceFixture(sourceDir);
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const domainMapDest = join(destDir, "domain-map.ts");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 1 file(s) written by this run");
    expect((thrown as Error).cause).toBeDefined();

    expect(existsSync(join(destDir, "kind-facet-map.ts"))).toBe(false);
    expect(existsSync(domainMapDest)).toBe(false);
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(destDir, "pack-map.ts"))).toBe(false);
    expect(existsSync(join(destDir, "plugin-map.ts"))).toBe(false);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );
    // The project's own (differing) skill under .claude/ is untouched too.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("rolls back after the LAST payload file (SKILL.md) fails to write -- .groundwork destination", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-gl-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-itemA-gl-tgt-"),
    );
    writeSourceFixture(sourceDir);
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const skillMdDest = join(destDir, "SKILL.md");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(
      `removed the ${String(CUSTOMIZE_SKILL_FILE_NAMES.length - 1)} file(s) written by this run`,
    );
    expect((thrown as Error).cause).toBeDefined();

    for (const name of [
      "kind-facet-map.ts",
      "domain-map.ts",
      "pack-map.ts",
      "plugin-map.ts",
    ]) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    expect(existsSync(skillMdDest)).toBe(false);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item F: stale SKILL.md removed before data rewrite, moved from
 * plugin-install.test.ts. The real-fs version planted a non-empty directory
 * at domain-map.ts to force a mid-loop write failure; `
 * assertNoDirectoryAtPayloadNames` now refuses that up front, so this
 * injects the same failure position via the fs-mock seam instead.
 */
describe("item F: stale SKILL.md removed before data rewrite, moved from plugin-install.test.ts", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("removes the stale SKILL.md before rewriting data, so a failure on the 2nd data file (domain-map.ts) never leaves it loadable beside stale/missing data", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-itemF-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-itemF-tgt-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    // A stale prior install already sits at the groundwork destination.
    writeGroundworkSkillPayload(targetDir, "OLD");
    const destDir = join(targetDir, ".groundwork", "customize");
    const domainMapDest = join(destDir, "domain-map.ts");
    const staleSkillMdPath = join(destDir, "SKILL.md");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    // [item 6] the exact clause naming the stale SKILL.md as also removed --
    // not just a loose "contains removed" check, since that substring alone
    // can't discriminate it from the unrelated "removed the N file(s)
    // written by this run" clause that's always present.
    expect(message).toContain(
      `; the stale ${staleSkillMdPath} was removed before any data file was rewritten`,
    );
    expect(message).toContain("removed the 1 file(s) written by this run");
    expect((thrown as Error).cause).toBeDefined();

    // The stale SKILL.md must be gone -- never left loadable beside
    // missing/stale data after a partial failure. Checked by lstat (not
    // existsSync) so any leftover entry, not just a regular file, fails
    // this assertion.
    expect(
      lstatSync(staleSkillMdPath, { throwIfNoEntry: false }),
    ).toBeUndefined();

    // domain-map.ts's stale "OLD" content was removed by the pre-write
    // cleanup, and the write that should have replaced it failed.
    expect(existsSync(domainMapDest)).toBe(false);

    // The pre-existing, differing .claude/ SKILL.md is a wholly separate
    // destination and is never touched by the groundwork-branch failure.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Moved from plugin-symlink.test.ts: a non-empty directory planted at
 * SKILL.md can no longer inject this failure, since
 * `assertNoDirectoryAtPayloadNames` now refuses a directory at any payload
 * name before anything is removed or written. Uses the fs-mock seam instead.
 */
describe("copyCustomizeSkillFiles wraps a remove-then-wx write failure, moved from plugin-symlink.test.ts", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  // [round-two review, item A] the wrapper message leads with "could not
  // install the /customize skill" (not "could not write <path>") and names
  // how many of THIS call's own files were rolled back, since a write
  // failure is all-or-nothing rather than per-file. SKILL.md is written
  // last, so failing its write means every one of the other four payload
  // files was written first and must be rolled back.
  it("installCustomizeSkill (fresh mode) wraps the fs error in a message naming the destination and the rollback, with the original error as cause", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-symlinkmove-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-symlinkmove-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const destPath = join(destDir, "SKILL.md");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === destPath) {
          const failure = new Error(
            "EISDIR: illegal operation on a directory, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EISDIR";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(destPath);
    expect(message).toContain(
      `removed the ${String(CUSTOMIZE_SKILL_FILE_NAMES.length - 1)} file(s) written by this run`,
    );
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    // The raw fs error's own message is distinct from the wrapper's -- this
    // is what a missing catch (letting the raw error propagate unwrapped)
    // would fail: the raw SystemError never mentions the wrapper's own
    // phrasing, only the underlying EISDIR fact.
    expect(((thrown as Error).cause as Error).message).not.toContain(
      "could not install the /customize skill",
    );
    // The four files written before SKILL.md was attempted were rolled back.
    for (const name of [
      "kind-facet-map.ts",
      "domain-map.ts",
      "pack-map.ts",
      "plugin-map.ts",
    ]) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Coverage: item 5's warning (a left-behind `SKILL.md` after a failed
 * rollback) words its "delete it by hand" remediation differently per
 * policy -- `failureClauses` (`../src/plugin.js`) says "it is a truncated
 * copy" for the CLI-owned `.groundwork/customize/` destination, and "Claude
 * Code will load a truncated skill" for fresh mode's `.claude/` destination.
 * The `describe("a left-behind SKILL.md after a failed rollback gets its own
 * warning (item 5)")` suite above only exercises the fresh-mode ("overwrite")
 * wording; this covers the cli-owned arm.
 */
describe("coverage: a left-behind SKILL.md at the cli-owned .groundwork/customize/ says 'it is a truncated copy'", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("uses the cli-owned wording, not fresh mode's 'Claude Code will load a truncated skill'", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-item5-gw-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-item5-gw-tgt-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const skillMdDest = join(destDir, "SKILL.md");

    // SKILL.md's own "wx" write physically creates it, then fails mid-way;
    // rollback's later removal of it also fails -- genuinely left behind.
    let writeAttempted = false;
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          writeAttempted = true;
          real.writeFileSync(target, "PARTIAL CONTENT", { flag: "wx" });
          throw new Error("ENOSPC: no space left on device (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.rmSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest && writeAttempted) {
          const failure = new Error(
            "EBUSY: resource busy or locked, unlink (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EBUSY";
          throw failure;
        }
        return real.rmSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(skillMdDest);
    expect(message).toContain("delete it by hand");
    expect(message).toContain("it is a truncated copy");
    expect(message).not.toContain("Claude Code will load a truncated skill");
    // Genuinely left behind: rollback's own removal failed.
    expect(existsSync(skillMdDest)).toBe(true);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Coverage: the cli-owned "previous ... removed and NOT restored" clause
 * (`replacedClause`'s `"cli-owned"` arm, `../src/plugin.js`) with exactly ONE
 * stale data file replaced before the failure -- the singular "was" wording
 * (`replaced.length === 1 ? "was" : "were"`), alongside the stale `SKILL.md`
 * clause. The existing item F suite above always replaces two files (the
 * failing file is not the first), which only exercises the plural "were"
 * arm; this exercises the singular one by failing on the very FIRST payload
 * file's own write (which still counts as "replaced", since its pre-write
 * `rmSync` of the stale entry succeeds before the write itself fails).
 */
describe("coverage: the cli-owned replaced-entries clause, singular wording (exactly one file replaced)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("says 'the previous <path> was removed and NOT restored', singular, alongside the stale SKILL.md clause", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-singular-gw-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-singular-gw-tgt-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    // A stale prior install already sits at the groundwork destination.
    writeGroundworkSkillPayload(targetDir, "OLD");
    const destDir = join(targetDir, ".groundwork", "customize");
    const kindFacetDest = join(destDir, "kind-facet-map.ts");
    const staleSkillMdPath = join(destDir, "SKILL.md");

    // kind-facet-map.ts is the FIRST payload file: its own pre-write rmSync
    // of the stale entry succeeds (marking it "replaced"), then its "wx"
    // write itself fails -- so exactly one file ends up in the "replaced"
    // list, and none in "written" (nothing to roll back).
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          throw new Error("EACCES: permission denied, write (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 0 file(s) written by this run");
    expect(message).toContain(
      `; the stale ${staleSkillMdPath} was removed before any data file was rewritten`,
    );
    expect(message).toContain(
      `the previous ${kindFacetDest} was removed and NOT restored`,
    );
    // Singular: not the plural "were" phrasing.
    expect(message).not.toContain(`${kindFacetDest} were removed`);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * [KNOWN BUG -- redundant "not loadable" clause] When SKILL.md itself is
 * the payload file whose own write fails (either `createdByFailedWrite`
 * surfacing its own lstat failure as "unknown whether created", or a
 * genuinely left-behind SKILL.md after rollback's own removal fails), its
 * own clause already explains SKILL.md's loadability precisely ("left in
 * place; whether this run created it is unknown" / "delete it by hand ...
 * Claude Code will load a truncated skill"). But when a pre-existing
 * project SKILL.md was ALSO removed earlier in this same run
 * (`removeStaleSkillEntry`, setting `skillRemoved`), `replacedClause`'s
 * `"overwrite"` arm unconditionally appends its own GENERIC "-- the skill
 * is not loadable until a successful re-run" clause on top -- redundant at
 * best (both clauses describe the same SKILL.md) and confusing at worst
 * (the generic clause talks about the file being "removed and NOT
 * restored", which is not what happened to THIS write: it was attempted
 * and failed, not merely removed). The fix this suite is written against:
 * when the failing write IS SKILL.md itself, its own specific clause is
 * the complete story and the generic "not loadable" clause must not also
 * appear.
 */
describe("a SKILL.md write failure does not also append the generic 'not loadable' clause when SKILL.md's own clause already covers it", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("[unknown whether created] omits the 'not loadable' clause even though a pre-existing SKILL.md was removed first", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-notloadable-unknown-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-notloadable-unknown-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const skillMdDest = join(destDir, "SKILL.md");
    // A pre-existing, differing SKILL.md -- its removal sets `skillRemoved`,
    // which is what currently makes the overwrite policy's generic "not
    // loadable" clause fire alongside this write's own clause.
    writeFileSync(skillMdDest, "---\nname: customize\n---\n# stale\n");

    // SKILL.md's own write throws without physically creating it, and its
    // own createdByFailedWrite lstat probe also fails -- "unknown whether
    // created", same technique as the domain-map.ts test above, applied to
    // SKILL.md itself instead.
    let writeAttempted = false;
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          writeAttempted = true;
          throw new Error("EIO: some I/O error (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest && writeAttempted) {
          throw new Error("EIO: lstat itself failed (simulated)");
        }
        return real.lstatSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(skillMdDest);
    expect(message).toContain(
      "left in place; whether this run created it is unknown",
    );
    expect(message).not.toContain(
      "the skill is not loadable until a successful re-run",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[left behind] omits the 'not loadable' clause even though a pre-existing SKILL.md was removed first", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-notloadable-left-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-notloadable-left-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const skillMdDest = join(destDir, "SKILL.md");
    // A pre-existing, differing SKILL.md -- its removal sets `skillRemoved`,
    // which is what currently makes the overwrite policy's generic "not
    // loadable" clause fire alongside this write's own clause.
    writeFileSync(skillMdDest, "---\nname: customize\n---\n# stale\n");

    // SKILL.md's own "wx" write physically creates it, then fails mid-way;
    // rollback's later removal of it also fails -- genuinely left behind.
    // Same technique as the "a left-behind SKILL.md after a failed
    // rollback" suite above, with a pre-existing SKILL.md added so
    // `skillRemoved` is set this time.
    let writeAttempted = false;
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest) {
          writeAttempted = true;
          real.writeFileSync(target, "PARTIAL CONTENT", { flag: "wx" });
          throw new Error("ENOSPC: no space left on device (simulated)");
        }
        return real.writeFileSync(...args);
      },
    );
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.rmSync>) => {
        const [target] = args;
        if (String(target) === skillMdDest && writeAttempted) {
          const failure = new Error(
            "EBUSY: resource busy or locked, unlink (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EBUSY";
          throw failure;
        }
        return real.rmSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(skillMdDest);
    expect(message).toContain("delete it by hand");
    expect(message).toContain("Claude Code will load a truncated skill");
    expect(message).not.toContain(
      "the skill is not loadable until a successful re-run",
    );
    // Genuinely left behind: rollback's own removal failed.
    expect(existsSync(skillMdDest)).toBe(true);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * [NIT] withRemediation's "already carries a re-run remediation" check must
 * be END-anchored, not a loose substring match anywhere in the message: a
 * target path that itself happens to CONTAIN marker-shaped text (e.g. a
 * directory literally named "re-run the CLI-something") is embedded in the
 * body via `could not write <dest>...`, and a naive `.includes()` check
 * would misread that coincidental text as "this message already carries
 * its own remediation", silently suppressing the real one.
 */
describe("withRemediation's marker check is END-anchored, not a coincidental substring match (NIT)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("still appends fresh-mode's --fresh --force advice when the target path's own text happens to contain 're-run the CLI'", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-nit-marker-src-"));
    // The directory name itself embeds the marker text the real symlink
    // refusal uses -- purely coincidental, nothing to do with a real
    // remediation already being present.
    const targetDir = mkdtempSync(
      join(tmpdir(), "re-run the CLI-plugin-nit-marker-tgt-"),
    );
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const dest = join(destDir, "kind-facet-map.ts");

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) => {
        const [target] = args;
        if (String(target) === dest) {
          const failure = new Error(
            "EACCES: permission denied, open (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EACCES";
          throw failure;
        }
        return real.writeFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Confirms the coincidental substring really is embedded in the body
    // (via the written-out `dest` path), so a naive, non-end-anchored
    // `.includes()` marker check has something to be fooled by.
    expect(message).toContain(targetDir);
    expect(message).toContain("--fresh --force");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * [NIT] `installCustomizeSkill`/`installCustomizeSkillGuarded`'s `sourceDir`
 * parameter defaults to `pluginDir()` (`../src/plugin.js`), which calls
 * `resolveAsset` (`../src/assets.js`). A default parameter value is
 * evaluated as part of entering the function body, BEFORE
 * `withRemediation`'s own `try` runs -- so a `pluginDir()` failure today
 * propagates completely raw: no "could not install the /customize skill: "
 * prefix, no chained `cause`, no remediation at all. Every other failure
 * path in this module gets that treatment; this one is a gap.
 */
describe("[NIT] a pluginDir()/resolveAsset() failure (the sourceDir default) gets the same install-prefix and remediation as every other failure", () => {
  afterEach(() => {
    vi.doUnmock("../src/assets.js");
    vi.resetModules();
  });

  it("wraps a resolveAsset() failure reached through installCustomizeSkill's default sourceDir the same way as any other failure", async () => {
    const assetFailure = new Error(
      "simulated resolveAsset failure: no source checkout or vendored copy found",
    );
    vi.doMock("../src/assets.js", () => ({
      resolveAsset: vi.fn(() => {
        throw assetFailure;
      }),
    }));
    vi.resetModules();
    const { installCustomizeSkill: installCustomizeSkillFreshImport } =
      await import("../src/plugin.js");

    const targetDir = mkdtempSync(join(tmpdir(), "plugin-nit-plugindir-tgt-"));

    let thrown: unknown;
    try {
      // No sourceDir argument: forces the pluginDir() default to run.
      installCustomizeSkillFreshImport(targetDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect((thrown as Error).cause).toBe(assetFailure);
    expect(message).toContain("--fresh --force");

    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * `classifyExistingSkill` (`../src/plugin.js`, via `regularFileMatches`)
 * reads an existing payload entry with `readFileSync` and today treats ANY
 * read failure, regardless of its errno code, the same way: "unreadable" ->
 * "foreign" (fresh mode then replaces it like any other stale copy; adopt
 * mode falls back to `.groundwork/customize/`). Only `EACCES`/`EPERM` -- a
 * genuine permission denial -- should keep that leave-it-alone-and-route-
 * around treatment (see the regression-pin suite below). Every other code
 * is not something either mode should guess past:
 *
 * - `EMFILE`/`EIO`: the entry is a plain regular file (its `lstat` already
 *   confirmed that), but something about the environment or the file itself
 *   makes it unreadable right now in a way no "stale project copy" story
 *   explains.
 * - `ENOENT`/`ELOOP` raised by the READ itself, after the preceding `lstat`
 *   already confirmed a regular file: a race -- the entry vanished, or
 *   became a symlink loop, in the window between the two calls.
 *
 * The fix this suite is written against: those codes throw the same "could
 * not install the /customize skill: ... could not read <path>" shape every
 * other failure in this module uses, with the raw errno error chained as
 * `cause`, before anything is removed or written -- for BOTH
 * `installCustomizeSkill` (fresh mode) and `installCustomizeSkillGuarded`
 * (adopt mode).
 */
describe("a non-EACCES/EPERM read failure against an existing payload entry throws, rather than being treated as foreign/replaced", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  /** Makes `readFileSync` against exactly `path` throw an errno-coded failure, passing every other path through to the real implementation. */
  function mockReadFailure(path: string, code: string): void {
    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.readFileSync>) => {
        const [target] = args;
        if (String(target) === path) {
          const failure = new Error(
            `${code}: simulated read failure`,
          ) as NodeJS.ErrnoException;
          failure.code = code;
          throw failure;
        }
        return real.readFileSync(...args);
      },
    );
  }

  describe.each([
    ["EMFILE", "too many open files"],
    ["EIO", "a hardware/filesystem fault"],
    ["ENOENT", "the entry vanished after lstat (a race)"],
    ["ELOOP", "the entry became a symlink loop after lstat (a race)"],
  ])("%s (%s)", (code) => {
    it(`[fresh mode] throws naming the path, chains the raw ${code} error, and leaves the destination untouched`, () => {
      const sourceDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-fresh-${code}-src-`),
      );
      const targetDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-fresh-${code}-tgt-`),
      );
      writeSourceFixture(sourceDir);
      const destDir = join(targetDir, ".claude", "skills", "customize");
      mkdirSync(destDir, { recursive: true });
      const domainMapDest = join(destDir, "domain-map.ts");
      // A pre-existing entry, lstat-visible as a regular file; only its
      // READ is made to fail.
      writeFileSync(domainMapDest, "export const y = 2;\n");
      const entriesBefore = readdirSync(destDir).toSorted();
      mockReadFailure(domainMapDest, code);

      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith("could not install the /customize skill")).toBe(
        true,
      );
      expect(message).toContain(`could not read ${domainMapDest}`);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as NodeJS.ErrnoException).code).toBe(code);

      // Nothing removed or written: the directory holds exactly what it
      // did before the call, and the targeted entry's own bytes (read via
      // the REAL implementation, bypassing the still-active mock override)
      // are unchanged.
      expect(readdirSync(destDir).toSorted()).toEqual(entriesBefore);
      expect(real.readFileSync(domainMapDest, "utf8")).toBe(
        "export const y = 2;\n",
      );

      real.rmSync(sourceDir, { recursive: true, force: true });
      real.rmSync(targetDir, { recursive: true, force: true });
    });

    it(`[adopt mode] throws naming the path, chains the raw ${code} error, and installs nothing to .groundwork/`, () => {
      const sourceDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-adopt-${code}-src-`),
      );
      const targetDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-adopt-${code}-tgt-`),
      );
      writeSourceFixture(sourceDir);
      const destDir = join(targetDir, ".claude", "skills", "customize");
      mkdirSync(destDir, { recursive: true });
      const domainMapDest = join(destDir, "domain-map.ts");
      writeFileSync(domainMapDest, "export const y = 2;\n");
      const entriesBefore = readdirSync(destDir).toSorted();
      mockReadFailure(domainMapDest, code);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith("could not install the /customize skill")).toBe(
        true,
      );
      expect(message).toContain(`could not read ${domainMapDest}`);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as NodeJS.ErrnoException).code).toBe(code);

      expect(readdirSync(destDir).toSorted()).toEqual(entriesBefore);
      expect(real.readFileSync(domainMapDest, "utf8")).toBe(
        "export const y = 2;\n",
      );
      // Adopt mode's today's fallback (.groundwork/customize/, five files)
      // must NOT have been taken: this failure refuses the whole install
      // instead of routing around it.
      expect(existsSync(join(targetDir, ".groundwork"))).toBe(false);

      real.rmSync(sourceDir, { recursive: true, force: true });
      real.rmSync(targetDir, { recursive: true, force: true });
    });
  });
});

/**
 * Regression pin, using the same fs-mock seam as the suite above: `EACCES`
 * and `EPERM` are the one pair of errno codes that must KEEP today's
 * behaviour once the fix above lands -- fresh mode still replaces the
 * unreadable entry like any other stale copy, and adopt mode still falls
 * back to `.groundwork/customize/`, naming the errno code in
 * `fallbackReason`. `EACCES` is already covered end-to-end via real `chmod`
 * in `plugin-existing-unreadable.test.ts`; this covers `EPERM`
 * specifically (which `chmod` alone cannot reliably reproduce) via the mock
 * seam instead.
 */
describe("EACCES/EPERM keep today's behaviour: fresh mode replaces, adopt mode falls back (EPERM, mock-seam regression pin)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  function mockEpermRead(path: string): void {
    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.readFileSync>) => {
        const [target] = args;
        if (String(target) === path) {
          const failure = new Error(
            "EPERM: operation not permitted (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EPERM";
          throw failure;
        }
        return real.readFileSync(...args);
      },
    );
  }

  it("[fresh mode] replaces the unreadable entry like any other stale copy, rather than throwing", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-eperm-fresh-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-eperm-fresh-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const domainMapDest = join(destDir, "domain-map.ts");
    writeFileSync(domainMapDest, "STALE\n");
    mockEpermRead(domainMapDest);

    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toContain(
      join(".claude", "skills", "customize", "domain-map.ts"),
    );
    expect(real.readFileSync(domainMapDest, "utf8")).toBe(
      "export const y = 2;\n",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[adopt mode] falls back to .groundwork/customize/, naming the errno code in fallbackReason, rather than throwing", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-eperm-adopt-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-eperm-adopt-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const domainMapDest = join(destDir, "domain-map.ts");
    writeFileSync(domainMapDest, "STALE\n");
    mockEpermRead(domainMapDest);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("entry");
    expect(result.fallbackReason).toContain("EPERM");
    // The project's own (unreadable) entry is left exactly as it was.
    expect(readdirSync(destDir).toSorted()).toEqual(["domain-map.ts"]);
    expect(real.readFileSync(domainMapDest, "utf8")).toBe("STALE\n");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});
