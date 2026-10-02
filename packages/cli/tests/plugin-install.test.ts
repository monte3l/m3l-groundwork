// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Round-two review fixes for the `/customize` skill installer
 * (`../src/plugin.js`):
 *
 * - item A: writes are all-or-nothing, with `SKILL.md` written LAST; a
 *   failure partway through removes every file THIS call already wrote
 *   (never a pre-existing project file) and names the removed count.
 * - item B: presence under `.claude/skills/customize/` is detected by
 *   `lstat`, never `existsSync`, so ANY entry under ANY payload name
 *   (file, dir, symlink, dangling or not) routes the install to
 *   `.groundwork/customize/` instead of silently replacing it.
 * - item C: a raw fs error from the symlink/mkdir/currency-check machinery
 *   (not a deliberate symlink refusal) is rethrown wrapped, with `cause`.
 * - item E: the currency check (`classifyExistingSkill`) never reads a
 *   non-regular file -- it checks `lstat(...).isFile()` first.
 *
 * Item D (the directory-component symlink fallback, and its
 * `fallbackReason` field) is covered in `plugin-symlink.test.ts`, which
 * already exercises the symlink-refusal/fallback matrix this suite
 * extends.
 *
 * The four non-SKILL.md payload files' write order is assumed, for the
 * rollback-position tests below, to be the natural minimal-diff order:
 * `CUSTOMIZE_SKILL_FILE_NAMES` with `SKILL.md` filtered out and moved to
 * the end -- kind-facet-map.ts, domain-map.ts, pack-map.ts, plugin-map.ts,
 * SKILL.md. "2nd" below means domain-map.ts; "LAST" always means
 * SKILL.md, which item A specifies directly regardless of the other four's
 * relative order.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  test,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
  type GuardedInstallResult,
} from "../src/plugin.js";
import { CUSTOMIZE_SKILL_FILE_NAMES } from "../src/customize-paths.js";

/** The same five-file payload fixture plugin.test.ts/plugin-symlink.test.ts use. */
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

/**
 * Replaces the payload destination with a non-empty directory, so a
 * non-recursive `rmSync` throws `ERR_FS_EISDIR` instead of removing it --
 * the write failure `copyCustomizeSkillFiles` must roll back from.
 */
function plantNonEmptyDirectoryAt(destPath: string): void {
  mkdirSync(destPath, { recursive: true });
  writeFileSync(join(destPath, "blocks-the-rm.txt"), "occupied\n");
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

describe("GuardedInstallResult carries an optional fallbackReason (item D's result shape)", () => {
  it("types fallbackReason as an optional string", () => {
    expectTypeOf<GuardedInstallResult>()
      .toHaveProperty("fallbackReason")
      .toEqualTypeOf<string | undefined>();
  });
});

describe("copyCustomizeSkillFiles writes SKILL.md last and rolls back all-or-nothing on failure (item A)", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-install-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-install-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("writes SKILL.md last in filesWritten on a plain, unobstructed install (.claude destination)", () => {
    const result = installCustomizeSkill(targetDir, sourceDir);
    expect(result.filesWritten.at(-1)).toBe(
      join(".claude", "skills", "customize", "SKILL.md"),
    );
  });

  it("writes SKILL.md last in filesWritten for the guarded groundwork branch too, and names the differing SKILL.md in fallbackReason (item 2)", () => {
    writeDifferingClaudeSkill(targetDir);
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("groundwork");
    expect(result.filesWritten.at(-1)).toBe(
      join(".groundwork", "customize", "SKILL.md"),
    );
    // [item 2] fallbackReason must be set for EVERY .groundwork fallback,
    // not only the directory-component-symlink case -- here naming the
    // existing, differing .claude/skills/customize/SKILL.md.
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(
      join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
    );
  });

  // The four rollback-position tests that used to live here (2nd file/LAST
  // file, .claude/.groundwork) planted a non-empty directory at the failing
  // payload name to force its pre-write `rmSync` to throw `ERR_FS_EISDIR`.
  // `assertNoDirectoryAtPayloadNames` (`../src/plugin.js`) now refuses up
  // front, before anything is removed or written, whenever a directory sits
  // at ANY payload name this run would write -- so that injection no longer
  // reaches a mid-loop write failure at all; it is refused before the first
  // file is even attempted (see `plugin-preflight.test.ts`). The same
  // rollback-position invariant, injected instead via the fs-mock seam
  // `plugin-rollback.test.ts` already has, now lives there: "item A: rollback
  // positions, moved from plugin-install.test.ts (preflight now refuses a
  // directory obstacle before anything is touched)".
});

describe("installCustomizeSkillGuarded detects presence by lstat, never existsSync (item B)", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-install-presence-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-install-presence-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("diverts to .groundwork/customize/ and leaves a dangling SKILL.md symlink untouched", () => {
    const existingDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(existingDir, { recursive: true });
    const skillMdPath = join(existingDir, "SKILL.md");
    const missingTarget = join(targetDir, "nowhere", "SKILL.md");
    symlinkSync(missingTarget, skillMdPath);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(lstatSync(skillMdPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(skillMdPath)).toBe(missingTarget);
    expect(
      existsSync(join(targetDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
    // [item 2] a dangling symlink is still a "present-but-not-current"
    // fallback, so fallbackReason must name it.
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(skillMdPath);
  });

  it("diverts to .groundwork/customize/ and leaves a project-owned pack-map.ts (regular file, no SKILL.md) byte-identical", () => {
    const existingDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(
      join(existingDir, "pack-map.ts"),
      "// project-owned, pre-customize\n",
    );

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(readFileSync(join(existingDir, "pack-map.ts"), "utf8")).toBe(
      "// project-owned, pre-customize\n",
    );
    expect(existsSync(join(existingDir, "SKILL.md"))).toBe(false);
    expect(
      existsSync(join(targetDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
    // [item 2] a project-owned data file (not SKILL.md) is also a
    // "present-but-not-current" fallback and must name the existing entry.
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(
      join(existingDir, "pack-map.ts"),
    );
  });
});

describe("raw fs errors are wrapped (item C)", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-install-enotdir-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-install-enotdir-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("installCustomizeSkill wraps the ENOTDIR raised when .claude is a regular file, not a directory", () => {
    writeFileSync(join(targetDir, ".claude"), "not a directory\n");

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe(
      "ENOTDIR",
    );
  });

  // [item 5, contract change] A regular FILE sitting where a directory
  // component is expected used to surface as a raw wrapped ENOTDIR,
  // aborting the whole adopt run. The guarded installer must instead treat
  // this the same as any other "can't use .claude/skills/customize/" case:
  // fall back to .groundwork/customize/ and report why via fallbackReason,
  // never throw. installCustomizeSkill (fresh mode) is unaffected -- fresh
  // mode has nothing to fall back to, so it keeps throwing (see the
  // "installCustomizeSkill wraps the ENOTDIR..." test above, unchanged).
  const regularFileComponents: [string, string[]][] = [
    [".claude", [".claude"]],
    [".claude/skills", [".claude", "skills"]],
    [".claude/skills/customize", [".claude", "skills", "customize"]],
  ];

  test.each(regularFileComponents)(
    "installCustomizeSkillGuarded falls back to .groundwork/customize/ (no throw) when %s is a regular file, naming it in fallbackReason",
    (_label, segments) => {
      const ancestors = segments.slice(0, -1);
      if (ancestors.length > 0) {
        mkdirSync(join(targetDir, ...ancestors), { recursive: true });
      }
      const collisionPath = join(targetDir, ...segments);
      writeFileSync(collisionPath, "not a directory\n");

      const result = installCustomizeSkillGuarded(targetDir, sourceDir);

      expect(result.location).toBe("groundwork");
      expect(typeof result.fallbackReason).toBe("string");
      expect(result.fallbackReason as string).toContain(collisionPath);
      expect(result.filesWritten).toHaveLength(5);
      expect(
        readFileSync(
          join(targetDir, ".groundwork", "customize", "SKILL.md"),
          "utf8",
        ),
      ).toContain("name: customize");
      // The regular file itself is left exactly as it was.
      expect(readFileSync(collisionPath, "utf8")).toBe("not a directory\n");
    },
  );
});

describe("classifyExistingSkill never reads a non-regular file (item E)", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-install-nonregular-source-"),
    );
    targetDir = mkdtempSync(
      join(tmpdir(), "plugin-install-nonregular-target-"),
    );
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("treats a SKILL.md symlink to a byte-identical regular file as differing, leaving it untouched, and diverts to .groundwork/customize/", () => {
    const existingDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(existingDir, { recursive: true });
    // The four data files are exact current copies...
    writeFileSync(
      join(existingDir, "kind-facet-map.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(join(existingDir, "domain-map.ts"), "export const y = 2;\n");
    writeFileSync(join(existingDir, "pack-map.ts"), "export const z = 3;\n");
    writeFileSync(join(existingDir, "plugin-map.ts"), "export const w = 4;\n");
    // ...but SKILL.md is a SYMLINK to a byte-identical regular file
    // elsewhere, not the regular file itself. Reading through it (the old,
    // readFileSync-based comparison) reports a byte match; lstat does not,
    // since the installed entry itself is not a regular file -- this must
    // still be "differs".
    const realSkillMd = join(targetDir, "real-skill.md");
    writeFileSync(realSkillMd, "---\nname: customize\n---\n# customize\n");
    const skillMdPath = join(existingDir, "SKILL.md");
    symlinkSync(realSkillMd, skillMdPath);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(lstatSync(skillMdPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(skillMdPath)).toBe(realSkillMd);
    expect(readFileSync(realSkillMd, "utf8")).toBe(
      "---\nname: customize\n---\n# customize\n",
    );
    expect(
      existsSync(join(targetDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
    // [item 2] a non-regular (symlink) installed entry is also a
    // "present-but-not-current" fallback and must name it.
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(skillMdPath);
  });

  // A FIFO-at-SKILL.md case (item E's other named non-regular-file example)
  // is deliberately NOT exercised here: verified live on this machine, a
  // `readFileSync`-based comparison opening a FIFO with no writer on the
  // other end blocks the Node *process* itself (a synchronous syscall, not
  // something a vitest per-test timeout can preempt), and even the standard
  // "hold an O_RDWR descriptor open so a reader never blocks" defanging
  // trick did not reliably prevent that hang on this platform -- it hung
  // the whole suite, confirmed by running it in isolation. The symlink case
  // above already discriminates the exact defect item E describes
  // (`classifyExistingSkill` reading through a non-regular installed
  // entry instead of checking `lstat(...).isFile()` first) without any
  // risk of blocking the test runner; treat that as this item's coverage
  // and prove the FIFO branch, if the implementer adds one, by a
  // non-blocking means (e.g. asserting `lstat(...).isFIFO()` is checked
  // before any read is attempted, never by planting a real unopened FIFO
  // in this suite).
});

/**
 * Item F (the destination this run re-visits already holds a prior
 * install): `CUSTOMIZE_SKILL_WRITE_ORDER`'s own TSDoc (`../src/
 * customize-paths.js`) says writing every data file first and SKILL.md
 * LAST means a run that fails part-way "never leaves a loadable SKILL.md
 * beside missing or stale data files" -- true for a FRESH destination,
 * since no SKILL.md exists until the final write succeeds. It is NOT yet
 * true when the destination already holds an OLD install from a prior
 * run (`.groundwork/customize/`, reached via `installCustomizeSkillGuarded`'s
 * "differs" fallback): that pre-existing SKILL.md sits there, loadable,
 * before this run writes anything, and the current write loop only
 * reaches (and so only replaces) it AFTER every data file -- so a failure
 * on an EARLIER data file leaves the stale SKILL.md right where it was,
 * now beside partially-rewritten data. The fix this test is written
 * against: a pre-existing SKILL.md at the destination must be removed
 * FIRST, before the data-file loop begins.
 */
describe("a pre-existing .groundwork/customize/SKILL.md is removed before any data file is rewritten (item F)", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-install-stale-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-install-stale-target-"));
    writeSourceFixture(sourceDir);
    destDir = join(targetDir, ".groundwork", "customize");
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  // The failure-path test that used to live here planted a non-empty
  // directory at domain-map.ts (2nd in write order) to force its own
  // pre-write `rmSync` to throw `ERR_FS_EISDIR` after kind-facet-map.ts (1st)
  // had already been rewritten. `assertNoDirectoryAtPayloadNames`
  // (`../src/plugin.js`) now refuses that same directory up front, before
  // anything is removed or written, so the injection never reaches a
  // mid-loop failure at all. The same stale-SKILL.md-removed-first
  // invariant, injected instead via the fs-mock seam, now lives in
  // `plugin-rollback.test.ts`'s "item F: stale SKILL.md removed before data
  // rewrite, moved from plugin-install.test.ts" test.

  // [8c, regression guard only] this test asserts no new behavior of its
  // own -- it's the happy-path companion to the failure-path test above,
  // kept here only so a future change can't silently reintroduce the stale
  // SKILL.md left loadable beside rewritten data.
  it("[regression guard only] re-run over a stale .groundwork/customize/ installs all five current files, and never touches the project's own differing .claude/ SKILL.md", () => {
    writeDifferingClaudeSkill(targetDir);
    writeGroundworkSkillPayload(targetDir, "OLD");

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(5);
    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      expect(readFileSync(join(destDir, name), "utf8")).not.toContain("OLD");
    }
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toContain(
      "name: customize",
    );
    // [item 2] fallbackReason must still be set here too.
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(
      join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
    );

    // The project's own (differing) skill under .claude/ is never removed
    // or overwritten by a write that lands at .groundwork/ instead.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");
  });
});

/**
 * Item 4: an install interrupted after the data files but before SKILL.md
 * (e.g. the process was killed between the two write phases) leaves
 * `.claude/skills/customize/` with every payload file EXCEPT SKILL.md, each
 * byte-identical to what this CLI ships. Routing that straight to
 * `.groundwork/customize/` (the ordinary "differs" fallback) would abandon a
 * perfectly fine `.claude/` install and stage a second, divergent copy
 * beside it for no reason -- the guarded installer must instead recognize
 * this exact shape and COMPLETE the interrupted install in place: write
 * only the missing SKILL.md (the four already-correct data files are left
 * untouched, never rewritten or removed), report location "claude". Any
 * divergence from that exact shape (one differing byte, or a
 * symlink/directory where a regular file is expected) must still divert to
 * `.groundwork/customize/` rather than guess.
 */
describe("interrupted-install repair: all data files already current, only SKILL.md missing (item 4)", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-install-repair-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-install-repair-target-"));
    writeSourceFixture(sourceDir);
    destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /** Writes the four non-SKILL.md payload files with byte-identical current content, leaving SKILL.md absent. */
  function writeCurrentDataFilesOnly(): void {
    writeFileSync(join(destDir, "kind-facet-map.ts"), "export const x = 1;\n");
    writeFileSync(join(destDir, "domain-map.ts"), "export const y = 2;\n");
    writeFileSync(join(destDir, "pack-map.ts"), "export const z = 3;\n");
    writeFileSync(join(destDir, "plugin-map.ts"), "export const w = 4;\n");
  }

  it("completes the install in .claude: writes only the missing SKILL.md, leaves the four already-correct data files untouched", () => {
    writeCurrentDataFilesOnly();

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("claude");
    expect(result.fallbackReason).toBeUndefined();
    // Only SKILL.md was written by this call -- the four already-correct
    // data files were never rewritten, so they're absent from filesWritten
    // (the result's own record of what this call actually wrote).
    expect(result.filesWritten).toEqual([
      join(".claude", "skills", "customize", "SKILL.md"),
    ]);
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toContain(
      "name: customize",
    );
  });

  it("[one differing byte] diverts to .groundwork/customize/ instead of repairing when a data file differs by even one byte", () => {
    writeCurrentDataFilesOnly();
    writeFileSync(join(destDir, "pack-map.ts"), "export const z = 9;\n");

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(typeof result.fallbackReason).toBe("string");
    // The project's own differing pack-map.ts is left exactly as it was.
    expect(readFileSync(join(destDir, "pack-map.ts"), "utf8")).toBe(
      "export const z = 9;\n",
    );
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
  });

  it("[symlink among data files] diverts to .groundwork/customize/ instead of repairing when a data file is a symlink, even to byte-identical content", () => {
    writeCurrentDataFilesOnly();
    rmSync(join(destDir, "domain-map.ts"), { force: true });
    const realDomainMap = join(targetDir, "real-domain-map.ts");
    writeFileSync(realDomainMap, "export const y = 2;\n");
    symlinkSync(realDomainMap, join(destDir, "domain-map.ts"));

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(lstatSync(join(destDir, "domain-map.ts")).isSymbolicLink()).toBe(
      true,
    );
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
  });

  it("[directory among data files] diverts to .groundwork/customize/ instead of repairing when a data file name is a directory", () => {
    writeCurrentDataFilesOnly();
    rmSync(join(destDir, "plugin-map.ts"), { force: true });
    mkdirSync(join(destDir, "plugin-map.ts"));

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(lstatSync(join(destDir, "plugin-map.ts")).isDirectory()).toBe(true);
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
  });

  // The "SKILL.md repair write itself fails" case moved to
  // plugin-rollback.test.ts: a directory at SKILL.md is no longer a valid
  // way to inject that failure (see "classifyExistingSkill diverts ANY
  // non-regular entry under a payload name to .groundwork/customize/, never
  // throwing" below) -- any entry under SKILL.md's name that is not a
  // regular file matching current bytes is now classified "foreign" and
  // diverted before a repair write is even attempted, so the failure must
  // be injected via the fs-mock seam instead.
});

/**
 * [KNOWN BUG -- directory-at-SKILL.md] `classifyExistingSkill`
 * (`../src/plugin.js`) special-cases `SKILL.md` being a directory by
 * `continue`-ing past it as if the entry were absent, rather than treating
 * it like every other non-regular-file entry under a payload name
 * ("foreign"). That misclassifies the destination as `"installable"`
 * whenever no OTHER payload entry is present either, so
 * `installCustomizeSkillGuarded` proceeds to write the four data files
 * into `.claude/skills/customize/` and then fails writing `SKILL.md`
 * itself (the directory occupies that name) -- surfacing as a thrown,
 * uncaught `Error` instead of the documented, non-throwing
 * `.groundwork/customize/` fallback every other "something's already
 * there and isn't this CLI's current copy" case gets.
 *
 * Maintainer policy for the fix: ANY project entry under a payload name
 * that is not a regular file matching the CLI's current bytes diverts to
 * `.groundwork/customize/` with `fallbackReason` set -- never thrown, never
 * touched. The two tests below assert that contract for a directory named
 * `SKILL.md`, empty and non-empty; both fail today (RED) because the
 * current code throws instead.
 */
describe("classifyExistingSkill diverts ANY non-regular entry under a payload name to .groundwork/customize/, never throwing", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-install-dirskill-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-install-dirskill-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("[empty directory] diverts to .groundwork/customize/ without throwing when SKILL.md is an empty directory and nothing else is present", () => {
    const existingDir = join(targetDir, ".claude", "skills", "customize");
    const skillMdDir = join(existingDir, "SKILL.md");
    mkdirSync(skillMdDir, { recursive: true });

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(skillMdDir);
    // The directory is left exactly as it was -- never removed or written
    // through.
    expect(lstatSync(skillMdDir).isDirectory()).toBe(true);
    expect(readdirSync(skillMdDir)).toEqual([]);
    expect(
      existsSync(join(targetDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
  });

  it("[non-empty directory] diverts to .groundwork/customize/ without throwing when SKILL.md is a directory holding an unrelated file", () => {
    const existingDir = join(targetDir, ".claude", "skills", "customize");
    const skillMdDir = join(existingDir, "SKILL.md");
    mkdirSync(skillMdDir, { recursive: true });
    writeFileSync(join(skillMdDir, "nested.txt"), "project file\n");

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(skillMdDir);
    expect(lstatSync(skillMdDir).isDirectory()).toBe(true);
    expect(readdirSync(skillMdDir)).toEqual(["nested.txt"]);
    expect(readFileSync(join(skillMdDir, "nested.txt"), "utf8")).toBe(
      "project file\n",
    );
  });
});

/**
 * Regression guard, not a RED case: `classifyExistingSkill` already
 * classifies a CURRENT, loadable `SKILL.md` sitting beside a missing data
 * file as `"foreign"` (the `entryLoadable` branch) -- this is the correct
 * contract, exercised here so the directory-at-SKILL.md fix above can't
 * accidentally broaden "installable" into this case too.
 */
describe("classifyExistingSkill treats a current SKILL.md with a missing data file as foreign", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-install-missingdata-source-"),
    );
    targetDir = mkdtempSync(
      join(tmpdir(), "plugin-install-missingdata-target-"),
    );
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("diverts to .groundwork/customize/ when SKILL.md is current but domain-map.ts is missing entirely", () => {
    const existingDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(
      join(existingDir, "SKILL.md"),
      "---\nname: customize\n---\n# customize\n",
    );
    writeFileSync(
      join(existingDir, "kind-facet-map.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(join(existingDir, "pack-map.ts"), "export const z = 3;\n");
    writeFileSync(join(existingDir, "plugin-map.ts"), "export const w = 4;\n");
    // domain-map.ts is absent entirely -- not planted at all.

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(typeof result.fallbackReason).toBe("string");
    expect(result.fallbackReason as string).toContain(
      join(existingDir, "SKILL.md"),
    );
    // The project's own files under .claude/ are left untouched.
    expect(existsSync(join(existingDir, "domain-map.ts"))).toBe(false);
    expect(readFileSync(join(existingDir, "SKILL.md"), "utf8")).toContain(
      "name: customize",
    );
  });
});

// [this round, item 1] The real-fs version of this test that used to live
// here planted a non-empty directory at pack-map.ts (3rd in write order,
// before SKILL.md) to force the re-run's own `rmSync` to throw
// `ERR_FS_EISDIR`. `assertNoDirectoryAtPayloadNames` (`../src/plugin.js`) now
// refuses that same directory up front, before anything is removed or
// written -- contradicting this test's own expectation that the re-run
// reaches and removes the previous run's `SKILL.md` before failing on
// pack-map.ts (`plugin-preflight.test.ts` asserts the opposite: nothing
// touched, the existing install -- SKILL.md included -- kept intact). The
// same invariant ("`overwrite` removes a pre-existing `SKILL.md` before its
// own data-file loop begins, even when a LATER write in that same loop then
// fails") is already covered, injected via the fs-mock seam instead of a
// real directory, by plugin-rollback.test.ts's "fresh-mode --force over an
// existing install removes the old SKILL.md first, even when the re-run's
// own write fails mid-way (this round, item 1)" test -- no separate
// real-fs replacement is needed here.

/**
 * [this round, item 3] When `installCustomizeSkillGuarded`'s "differs"
 * fallback itself fails to write into `.groundwork/customize/` (a plain fs
 * error, not a symlink refusal), the thrown error today carries only
 * `copyCustomizeSkillFiles`'s own wrapper message -- it never says WHY the
 * fallback destination was being written to in the first place (the
 * differing `.claude/` entry that triggered the fallback). The fix this
 * suite is written against: the fallback reason text must be folded into
 * the thrown error's own message, and the error must still carry a cause
 * chain.
 */
describe("a failed .groundwork fallback install still names why the fallback was taken (this round, item 3)", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-fallback-throw-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-fallback-throw-target-"));
    writeSourceFixture(sourceDir);
    writeDifferingClaudeSkill(targetDir);
    destDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
    plantNonEmptyDirectoryAt(join(destDir, "domain-map.ts"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("includes the differing-SKILL.md fallback reason in the thrown error's message, with a cause chain", () => {
    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    // Names the SAME differing-SKILL.md path classifyExistingSkill's own
    // "foreign" reason names -- the fact that made .claude/ unusable in the
    // first place, not just the unrelated write failure at .groundwork/.
    expect(message).toContain(
      join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
    );
    expect((thrown as Error).cause).toBeDefined();
  });
});

/**
 * [this round, item 5] `GuardedInstallResult.fallbackCause` discriminates
 * WHY a `.groundwork/customize/` fallback was taken, so a caller (main.ts's
 * next-step message) can tell the two cases apart without re-deriving the
 * reason from its free text: `"component"` when a `.claude/skills/customize`
 * path COMPONENT is a symlink or not a directory (nothing project-local
 * exists to "replace"), `"entry"` when a project-owned entry already sits
 * under one of the skill's payload names (a real project copy exists to
 * replace).
 */
describe("GuardedInstallResult.fallbackCause discriminates why the .groundwork fallback was taken (this round, item 5)", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-fallback-cause-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-fallback-cause-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-fallback-cause-outside-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('types fallbackCause as "entry" | "component" | undefined', () => {
    expectTypeOf<GuardedInstallResult>()
      .toHaveProperty("fallbackCause")
      .toEqualTypeOf<"entry" | "component" | undefined>();
  });

  it('reports "component" when .claude is a symlink', () => {
    symlinkSync(outsideDir, join(targetDir, ".claude"), "dir");

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("component");
  });

  it('reports "component" when .claude is a regular file, not a directory', () => {
    writeFileSync(join(targetDir, ".claude"), "not a directory\n");

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("component");
  });

  it('reports "entry" when .claude/skills/customize/SKILL.md already differs', () => {
    writeDifferingClaudeSkill(targetDir);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("entry");
  });

  it('reports "entry" when a project-owned data file (pack-map.ts) already sits there', () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    writeFileSync(
      join(targetDir, ".claude", "skills", "customize", "pack-map.ts"),
      "// project-owned\n",
    );

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("entry");
  });
});
