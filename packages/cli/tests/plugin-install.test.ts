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
 * - item E: the currency check (`isCustomizeSkillCurrent`) never reads a
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

  it("writes SKILL.md last in filesWritten for the guarded groundwork branch too", () => {
    writeDifferingClaudeSkill(targetDir);
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("groundwork");
    expect(result.filesWritten.at(-1)).toBe(
      join(".groundwork", "customize", "SKILL.md"),
    );
  });

  it("rolls back after the 2nd payload file (domain-map.ts) fails to write -- .claude destination", () => {
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    // An unrelated, pre-existing project file in the same directory.
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const obstaclePath = join(destDir, "domain-map.ts");
    plantNonEmptyDirectoryAt(obstaclePath);

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 1 file(s) already written");
    expect((thrown as Error).cause).toBeDefined();

    // kind-facet-map.ts (written first) was rolled back.
    expect(existsSync(join(destDir, "kind-facet-map.ts"))).toBe(false);
    // SKILL.md, written last, was never reached.
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
    // pack-map.ts/plugin-map.ts were never attempted.
    expect(existsSync(join(destDir, "pack-map.ts"))).toBe(false);
    expect(existsSync(join(destDir, "plugin-map.ts"))).toBe(false);
    // The obstacle itself is untouched -- the call never removed it.
    expect(lstatSync(obstaclePath).isDirectory()).toBe(true);
    expect(readdirSync(obstaclePath)).toEqual(["blocks-the-rm.txt"]);
    // The pre-existing project file survives untouched.
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    // After the obstacle is cleared, a re-run installs cleanly.
    rmSync(obstaclePath, { recursive: true, force: true });
    const result = installCustomizeSkill(targetDir, sourceDir);
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toContain(
      "name: customize",
    );
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );
  });

  it("rolls back after the LAST payload file (SKILL.md) fails to write -- .claude destination", () => {
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const obstaclePath = join(destDir, "SKILL.md");
    plantNonEmptyDirectoryAt(obstaclePath);

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 4 file(s) already written");
    expect((thrown as Error).cause).toBeDefined();

    for (const name of [
      "kind-facet-map.ts",
      "domain-map.ts",
      "pack-map.ts",
      "plugin-map.ts",
    ]) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    expect(lstatSync(obstaclePath).isDirectory()).toBe(true);
    expect(readdirSync(obstaclePath)).toEqual(["blocks-the-rm.txt"]);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    rmSync(obstaclePath, { recursive: true, force: true });
    const result = installCustomizeSkill(targetDir, sourceDir);
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );
  });

  it("rolls back after the 2nd payload file (domain-map.ts) fails to write -- .groundwork destination", () => {
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const obstaclePath = join(destDir, "domain-map.ts");
    plantNonEmptyDirectoryAt(obstaclePath);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 1 file(s) already written");
    expect((thrown as Error).cause).toBeDefined();

    expect(existsSync(join(destDir, "kind-facet-map.ts"))).toBe(false);
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(destDir, "pack-map.ts"))).toBe(false);
    expect(existsSync(join(destDir, "plugin-map.ts"))).toBe(false);
    expect(lstatSync(obstaclePath).isDirectory()).toBe(true);
    expect(readdirSync(obstaclePath)).toEqual(["blocks-the-rm.txt"]);
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

    rmSync(obstaclePath, { recursive: true, force: true });
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );
  });

  it("rolls back after the LAST payload file (SKILL.md) fails to write -- .groundwork destination", () => {
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    const obstaclePath = join(destDir, "SKILL.md");
    plantNonEmptyDirectoryAt(obstaclePath);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("removed the 4 file(s) already written");
    expect((thrown as Error).cause).toBeDefined();

    for (const name of [
      "kind-facet-map.ts",
      "domain-map.ts",
      "pack-map.ts",
      "plugin-map.ts",
    ]) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    expect(lstatSync(obstaclePath).isDirectory()).toBe(true);
    expect(readdirSync(obstaclePath)).toEqual(["blocks-the-rm.txt"]);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );

    rmSync(obstaclePath, { recursive: true, force: true });
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(join(destDir, "project-owned.txt"), "utf8")).toBe(
      "mine\n",
    );
  });
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

  it("installCustomizeSkillGuarded wraps the same ENOTDIR failure", () => {
    writeFileSync(join(targetDir, ".claude"), "not a directory\n");

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
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
});

describe("isCustomizeSkillCurrent never reads a non-regular file (item E)", () => {
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
  // (`isCustomizeSkillCurrent` reading through a non-regular installed
  // entry instead of checking `lstat(...).isFile()` first) without any
  // risk of blocking the test runner; treat that as this item's coverage
  // and prove the FIFO branch, if the implementer adds one, by a
  // non-blocking means (e.g. asserting `lstat(...).isFIFO()` is checked
  // before any read is attempted, never by planting a real unopened FIFO
  // in this suite).
});
