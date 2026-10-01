// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Regression coverage for issue #100: `copyCustomizeSkillFiles` (reached via
 * `installCustomizeSkill`/`installCustomizeSkillGuarded` in `../src/plugin.js`)
 * must lstat-guard every directory component it writes through and must
 * replace -- never follow -- a symlinked payload-file destination. Mirrors
 * the symlink-refusal pattern in `baseline-stage.test.ts`'s "symlink guard"
 * describe and the remove-then-`wx` pattern in `inventory.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";
import { main } from "../src/main.js";

/** Builds the same five-file payload fixture `plugin.test.ts` uses. */
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

/** Asserts `thrown` is an `Error` naming a symlink refusal at exactly `offendingPath`. */
function expectSymlinkRefusal(thrown: unknown, offendingPath: string): void {
  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain("refusing to write through a symlink");
  expect(message).toContain(offendingPath);
}

describe("copyCustomizeSkillFiles directory-component symlink guard", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-outside-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  const claudePathComponents: [string, string[]][] = [
    [".claude", [".claude"]],
    [".claude/skills", [".claude", "skills"]],
    [".claude/skills/customize", [".claude", "skills", "customize"]],
  ];

  /** Replaces the final segment of `targetDir/<segments>` with a symlink to `outsideDir`, after creating any real ancestor segments. */
  function plantSymlinkAt(segments: string[]): string {
    const ancestors = segments.slice(0, -1);
    if (ancestors.length > 0) {
      mkdirSync(join(targetDir, ...ancestors), { recursive: true });
    }
    const symlinkPath = join(targetDir, ...segments);
    symlinkSync(outsideDir, symlinkPath, "dir");
    return symlinkPath;
  }

  test.each(claudePathComponents)(
    "installCustomizeSkill (fresh mode) refuses when %s is a symlink, writing nothing outside and leaving the symlink in place",
    (_label, segments) => {
      const symlinkPath = plantSymlinkAt(segments);

      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expectSymlinkRefusal(thrown, symlinkPath);
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    },
  );

  test.each(claudePathComponents)(
    "installCustomizeSkillGuarded (absent branch -> .claude destination) refuses when %s is a symlink",
    (_label, segments) => {
      const symlinkPath = plantSymlinkAt(segments);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expectSymlinkRefusal(thrown, symlinkPath);
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    },
  );

  const groundworkPathComponents: [string, string[]][] = [
    [".groundwork", [".groundwork"]],
    [".groundwork/customize", [".groundwork", "customize"]],
  ];

  test.each(groundworkPathComponents)(
    "installCustomizeSkillGuarded (differs branch -> .groundwork destination) refuses when %s is a symlink",
    (_label, segments) => {
      // Force the "differs" branch first, so the destination is really
      // .groundwork/customize/ -- then plant the symlink inside it.
      writeDifferingClaudeSkill(targetDir);
      const symlinkPath = plantSymlinkAt(segments);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expectSymlinkRefusal(thrown, symlinkPath);
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      // The project's own (differing) skill under .claude/ is untouched too.
      expect(
        readFileSync(
          join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
          "utf8",
        ),
      ).toContain("a project-authored version");
    },
  );
});

describe("copyCustomizeSkillFiles payload-file symlink guard (remove-then-wx)", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-payload-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-payload-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-payload-outside-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("replaces a symlinked SKILL.md destination (installCustomizeSkill, fresh mode / .claude destination) instead of writing through it; the outside file is untouched", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    const outsideFile = join(outsideDir, "sentinel-skill.md");
    writeFileSync(outsideFile, "SENTINEL - do not touch\n");
    const destPath = join(
      targetDir,
      ".claude",
      "skills",
      "customize",
      "SKILL.md",
    );
    symlinkSync(outsideFile, destPath);

    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(outsideFile, "utf8")).toBe("SENTINEL - do not touch\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(destPath, "utf8")).toContain("name: customize");
  });

  it("replaces a symlinked payload file (installCustomizeSkillGuarded, absent branch -> .claude destination) instead of writing through it", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    const outsideFile = join(outsideDir, "sentinel-pack-map.ts");
    writeFileSync(outsideFile, "// SENTINEL2\n");
    const destPath = join(
      targetDir,
      ".claude",
      "skills",
      "customize",
      "pack-map.ts",
    );
    symlinkSync(outsideFile, destPath);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("claude");
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(outsideFile, "utf8")).toBe("// SENTINEL2\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(destPath, "utf8")).toBe("export const z = 3;\n");
  });

  it("replaces a symlinked payload file (installCustomizeSkillGuarded, differs branch -> .groundwork destination) instead of writing through it", () => {
    writeDifferingClaudeSkill(targetDir);
    mkdirSync(join(targetDir, ".groundwork", "customize"), {
      recursive: true,
    });
    const outsideFile = join(outsideDir, "sentinel-domain-map.ts");
    writeFileSync(outsideFile, "// SENTINEL3\n");
    const destPath = join(
      targetDir,
      ".groundwork",
      "customize",
      "domain-map.ts",
    );
    symlinkSync(outsideFile, destPath);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(outsideFile, "utf8")).toBe("// SENTINEL3\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(destPath, "utf8")).toBe("export const y = 2;\n");
  });
});

describe("copyCustomizeSkillFiles wraps a remove-then-wx write failure", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-write-fail-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-write-fail-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  /**
   * Replaces the payload destination with a non-empty directory. `rmSync`
   * is called without `recursive`, so it throws `ERR_FS_EISDIR` rather than
   * removing it -- the same shape of failure the surrounding `try`/`catch`
   * in `copyCustomizeSkillFiles` exists to wrap (a permission error on a
   * read-only destination directory throws the same way, but a non-empty
   * directory is portable across platforms and doesn't need a root check).
   */
  function plantNonEmptyDirectoryAt(destPath: string): void {
    mkdirSync(destPath, { recursive: true });
    writeFileSync(join(destPath, "blocks-the-rm.txt"), "occupied\n");
  }

  it("installCustomizeSkill (fresh mode) wraps the fs error in a message naming the destination, with the original error as cause", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    const destPath = join(
      targetDir,
      ".claude",
      "skills",
      "customize",
      "SKILL.md",
    );
    plantNonEmptyDirectoryAt(destPath);

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not write");
    expect(message).toContain(destPath);
    expect(message).toContain("installing the /customize skill");
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    // The raw fs error's own message is distinct from the wrapper's -- this
    // is what a missing catch (letting the raw error propagate unwrapped)
    // would fail: the raw SystemError never mentions "could not write" or
    // "installing the /customize skill", only the underlying EISDIR fact.
    expect(((thrown as Error).cause as Error).message).not.toContain(
      "could not write",
    );
  });

  it("installCustomizeSkillGuarded (absent branch -> .claude destination) wraps the fs error the same way", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    const destPath = join(
      targetDir,
      ".claude",
      "skills",
      "customize",
      "pack-map.ts",
    );
    plantNonEmptyDirectoryAt(destPath);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not write");
    expect(message).toContain(destPath);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });
});

describe("plain run (no symlinks) is unchanged by the guard", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-plain-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-plain-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("writes the same filesWritten names and byte-identical content, and a second run over its own output still succeeds", () => {
    const expectedNames = [
      join(".claude", "skills", "customize", "SKILL.md"),
      join(".claude", "skills", "customize", "kind-facet-map.ts"),
      join(".claude", "skills", "customize", "domain-map.ts"),
      join(".claude", "skills", "customize", "pack-map.ts"),
      join(".claude", "skills", "customize", "plugin-map.ts"),
    ].sort();

    const result1 = installCustomizeSkill(targetDir, sourceDir);
    expect([...result1.filesWritten].sort()).toEqual(expectedNames);

    const destDir = join(targetDir, ".claude", "skills", "customize");
    expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(destDir, "domain-map.ts"), "utf8")).toBe(
      "export const y = 2;\n",
    );

    // Re-running over its own output must still succeed, with the same
    // names and the same (unchanged) content.
    const result2 = installCustomizeSkill(targetDir, sourceDir);
    expect([...result2.filesWritten].sort()).toEqual(expectedNames);
    expect(readFileSync(join(destDir, "plugin-map.ts"), "utf8")).toBe(
      "export const w = 4;\n",
    );
  });
});

describe("adopt mode (main()) and a symlinked .claude", () => {
  let workDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "plugin-symlink-adopt-work-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-adopt-outside-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses to install the /customize skill through a symlinked .claude, leaving the outside directory untouched and writing no .groundwork/inventory.json", () => {
    const projectDir = join(workDir, "project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    symlinkSync(outsideDir, join(projectDir, ".claude"), "dir");

    expect(() => main([projectDir])).toThrow(/symlink/);

    expect(readdirSync(outsideDir)).toEqual([]);
    expect(lstatSync(join(projectDir, ".claude")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(projectDir, ".groundwork", "inventory.json"))).toBe(
      false,
    );
  });
});
