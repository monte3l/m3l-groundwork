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
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";

// vi.mock(...) is hoisted above every other statement in this file,
// including a plain top-level `let` -- so the real implementations this
// file's "passthrough" default needs are captured into a vi.hoisted() ref
// object instead, mutated once from inside the mock factory below.
const { rmSyncMock, writeFileSyncMock, real } = vi.hoisted(() => ({
  rmSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  real: {} as {
    rmSync: typeof NodeFs.rmSync;
    writeFileSync: typeof NodeFs.writeFileSync;
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  real.rmSync = actual.rmSync;
  real.writeFileSync = actual.writeFileSync;
  return { ...actual, rmSync: rmSyncMock, writeFileSync: writeFileSyncMock };
});

const { installCustomizeSkill, installCustomizeSkillGuarded } =
  await import("../src/plugin.js");

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

    // Plant a non-empty directory at plugin-map.ts's destination (the 4th
    // file in write order) so its own pre-write `rmSync(dest, { force:
    // true })` -- called without `recursive`, like the real write path --
    // throws ERR_FS_EISDIR, the natural failure that triggers a rollback of
    // the three files written before it.
    mkdirSync(pluginMapDest, { recursive: true });
    writeFileSync(join(pluginMapDest, "blocks-the-rm.txt"), "occupied\n");

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
    expect(message).toContain("removed the 2 file(s) already written");
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
    expect(message).toContain("removed the 0 file(s) already written");
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
      "removed the 1 file(s) already written",
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
    expect(result.filesWritten).toHaveLength(5);
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
    // The four data files written before SKILL.md, plus the partially
    // created SKILL.md itself: 5 total.
    expect((thrown as Error).message).toContain(
      "removed the 5 file(s) already written",
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
      "removed the 2 file(s) already written",
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
      "removed the 5 file(s) already written",
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
    expect(result.filesWritten).toHaveLength(5);
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
