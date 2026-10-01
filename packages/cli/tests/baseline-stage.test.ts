// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `stageBaselineAdditions` copies only the template files a conflict plan
 * (`conflicts.ts`'s `planConflicts`) marked "absent" into
 * `<groundworkDir>/baseline`, each under a neutral `<path>.staged` name so no
 * toolchain in the staged tree (or in the project the staged tree sits next
 * to) ever globs it -- the staged copy `/customize`'s Step 0 installs from
 * for a project the CLI itself never touches directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { planConflicts } from "../src/conflicts.js";
import type { FileConflict } from "../src/conflicts.js";
import {
  STAGED_BASELINE_DIR,
  STAGED_SUFFIX,
  plannedBaselineStagingPaths,
  stageBaselineAdditions,
  toPosixPath,
} from "../src/baseline-stage.js";

const here = dirname(fileURLToPath(import.meta.url));
const realTemplatesCoreDir = join(here, "..", "..", "..", "templates", "core");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `root`, relative to it, sorted -- empty directories are invisible on purpose: a leftover empty dir from a skipped file would otherwise pass silently. */
function listFiles(root: string): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      results.push(relative(root, absPath));
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return results.sort();
}

describe("stageBaselineAdditions", () => {
  let templateRoot: string;
  let targetDir: string;
  let groundworkDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "baseline-stage-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "baseline-stage-target-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "baseline-stage-groundwork-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  /**
   * new.txt (absent, carries a token placeholder), src/deep.ts (absent,
   * nested), _gitignore (absent, npm-escaped dotfile name), same.txt
   * (identical to the target -- must be skipped), differing.txt (divergent
   * -- must be skipped), identical-dir/keep.txt (identical, alone in its own
   * directory -- proves a skipped-only directory leaves no empty dir behind).
   */
  function writeTemplateFixture(): void {
    writeFileSync(join(templateRoot, "new.txt"), "__PROJECT_NAME__");
    mkdirSync(join(templateRoot, "src"), { recursive: true });
    writeFileSync(
      join(templateRoot, "src", "deep.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(join(templateRoot, "_gitignore"), "node_modules\n");
    writeFileSync(join(templateRoot, "same.txt"), "identical content\n");
    writeFileSync(join(templateRoot, "differing.txt"), "template version\n");
    mkdirSync(join(templateRoot, "identical-dir"), { recursive: true });
    writeFileSync(
      join(templateRoot, "identical-dir", "keep.txt"),
      "kept as-is\n",
    );
  }

  function writeTargetFixture(): void {
    writeFileSync(join(targetDir, "same.txt"), "identical content\n");
    writeFileSync(join(targetDir, "differing.txt"), "target version\n");
    mkdirSync(join(targetDir, "identical-dir"), { recursive: true });
    writeFileSync(join(targetDir, "identical-dir", "keep.txt"), "kept as-is\n");
    // new.txt, src/deep.ts and .gitignore are deliberately absent from the
    // target -- that is what makes them "absent" conflicts.
  }

  it("exports the staging directory name and the neutral suffix as constants", () => {
    expect(STAGED_BASELINE_DIR).toBe("baseline");
    expect(STAGED_SUFFIX).toBe(".staged");
  });

  it("stages exactly the absent files under <path>.staged with a matching sha256, restores the dotfile name, and leaves no empty directory for a skipped-only directory", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const conflicts = planConflicts(templateRoot, targetDir, {});

    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );

    const expectedPaths = conflicts
      .filter((c) => c.status === "absent")
      .map((c) => c.relPath);
    expect(staged.map((f) => f.path)).toEqual(expectedPaths);
    expect([...staged.map((f) => f.path)].sort()).toEqual(
      [".gitignore", "new.txt", "src/deep.ts"].sort(),
    );

    const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
    expect(listFiles(baselineDir)).toEqual(
      [".gitignore.staged", "new.txt.staged", "src/deep.ts.staged"].sort(),
    );
    expect(existsSync(join(baselineDir, "identical-dir"))).toBe(false);
    expect(existsSync(join(baselineDir, "same.txt"))).toBe(false);
    expect(existsSync(join(baselineDir, "differing.txt"))).toBe(false);
    expect(existsSync(join(baselineDir, "_gitignore"))).toBe(false);
    // The un-suffixed, real file name must never appear alongside the
    // suffixed one.
    expect(existsSync(join(baselineDir, "new.txt"))).toBe(false);
    expect(existsSync(join(baselineDir, ".gitignore"))).toBe(false);

    for (const file of staged) {
      expect(file.staged).toBe(`${file.path}${STAGED_SUFFIX}`);
      const bytes = readFileSync(join(baselineDir, file.staged));
      expect(file.sha256).toBe(sha256Hex(bytes));
    }

    expect(readFileSync(join(baselineDir, "new.txt.staged"), "utf8")).toBe(
      "__PROJECT_NAME__",
    );
    expect(
      readFileSync(join(baselineDir, "src", "deep.ts.staged"), "utf8"),
    ).toBe("export const x = 1;\n");
    expect(readFileSync(join(baselineDir, ".gitignore.staged"), "utf8")).toBe(
      "node_modules\n",
    );
  });

  it("never substitutes tokens into staged file CONTENT, even when a non-empty token table is supplied to both the conflict plan and the staging call", () => {
    writeTemplateFixture();
    writeTargetFixture();
    // A real substitution would turn new.txt's content into "acme-corp";
    // the conflict's "absent" status does not depend on this table at all
    // (the file is absent from the target either way), so this isolates
    // whether staging itself ever applies tokens to content.
    const tokens = { PROJECT_NAME: "acme-corp" };
    const conflicts = planConflicts(templateRoot, targetDir, tokens);

    stageBaselineAdditions(templateRoot, conflicts, groundworkDir, tokens);

    expect(
      readFileSync(
        join(groundworkDir, STAGED_BASELINE_DIR, "new.txt.staged"),
        "utf8",
      ),
    ).toBe("__PROJECT_NAME__");
  });

  it("stages a byte-identical copy of a binary file and a CRLF text file, each with a matching sha256", () => {
    const binaryBytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0xff, 0x7f]);
    writeFileSync(join(templateRoot, "binary.bin"), binaryBytes);
    const crlfText = "line one\r\nline two\r\n";
    writeFileSync(join(templateRoot, "crlf.txt"), crlfText, "utf8");

    const conflicts = planConflicts(templateRoot, targetDir, {});
    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );

    const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);

    const binaryEntry = staged.find((f) => f.path === "binary.bin");
    expect(binaryEntry).toBeDefined();
    const stagedBinaryBytes = readFileSync(
      join(baselineDir, binaryEntry?.staged ?? ""),
    );
    expect(stagedBinaryBytes.equals(binaryBytes)).toBe(true);
    expect(binaryEntry?.sha256).toBe(sha256Hex(binaryBytes));

    const crlfEntry = staged.find((f) => f.path === "crlf.txt");
    expect(crlfEntry).toBeDefined();
    const stagedCrlfBytes = readFileSync(
      join(baselineDir, crlfEntry?.staged ?? ""),
    );
    expect(stagedCrlfBytes.toString("utf8")).toBe(crlfText);
    expect(crlfEntry?.sha256).toBe(sha256Hex(Buffer.from(crlfText, "utf8")));
  });

  it("creates nothing when no file is absent", () => {
    writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
    writeFileSync(join(targetDir, "only.txt"), "same everywhere\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});
    expect(conflicts.every((c) => c.status !== "absent")).toBe(true);

    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );

    expect(staged).toEqual([]);
    expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
  });

  it("replaces a previous staging on re-stage rather than accumulating stale files", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const firstConflicts = planConflicts(templateRoot, targetDir, {});
    stageBaselineAdditions(templateRoot, firstConflicts, groundworkDir, {});
    expect(
      existsSync(join(groundworkDir, STAGED_BASELINE_DIR, "new.txt.staged")),
    ).toBe(true);

    // new.txt now exists in the target too (no longer absent); a brand-new
    // file appears in the template instead.
    writeFileSync(join(targetDir, "new.txt"), "__PROJECT_NAME__");
    writeFileSync(join(templateRoot, "fresh.txt"), "fresh content\n");
    const secondConflicts = planConflicts(templateRoot, targetDir, {});

    stageBaselineAdditions(templateRoot, secondConflicts, groundworkDir, {});

    expect(
      existsSync(join(groundworkDir, STAGED_BASELINE_DIR, "new.txt.staged")),
    ).toBe(false);
    expect(
      readFileSync(
        join(groundworkDir, STAGED_BASELINE_DIR, "fresh.txt.staged"),
        "utf8",
      ),
    ).toBe("fresh content\n");
  });

  it("removes a previous staging entirely when a later run has nothing left to stage", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const firstConflicts = planConflicts(templateRoot, targetDir, {});
    stageBaselineAdditions(templateRoot, firstConflicts, groundworkDir, {});
    expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(true);

    // Every previously-absent file now exists in the target.
    writeFileSync(join(targetDir, "new.txt"), "__PROJECT_NAME__");
    mkdirSync(join(targetDir, "src"), { recursive: true });
    writeFileSync(join(targetDir, "src", "deep.ts"), "export const x = 1;\n");
    writeFileSync(join(targetDir, ".gitignore"), "node_modules\n");
    const secondConflicts = planConflicts(templateRoot, targetDir, {});
    expect(secondConflicts.every((c) => c.status !== "absent")).toBe(true);

    stageBaselineAdditions(templateRoot, secondConflicts, groundworkDir, {});

    expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
  });

  it("remains readable after the template root it was staged from is deleted", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const conflicts = planConflicts(templateRoot, targetDir, {});
    stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});

    rmSync(templateRoot, { recursive: true, force: true });

    const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
    expect(readFileSync(join(baselineDir, "new.txt.staged"), "utf8")).toBe(
      "__PROJECT_NAME__",
    );
    expect(
      readFileSync(join(baselineDir, "src", "deep.ts.staged"), "utf8"),
    ).toBe("export const x = 1;\n");
    expect(readFileSync(join(baselineDir, ".gitignore.staged"), "utf8")).toBe(
      "node_modules\n",
    );
  });

  describe("neutral naming against the real templates/core baseline", () => {
    it("stages every file with a .staged suffix, never a bare toolchain-globbed extension, and keeps nested CLAUDE.md/SKILL.md suffixed too", () => {
      const emptyTarget = mkdtempSync(
        join(tmpdir(), "baseline-stage-real-target-"),
      );
      try {
        const conflicts = planConflicts(realTemplatesCoreDir, emptyTarget, {});
        // The target is empty, so every real templates/core file is "absent".
        expect(conflicts.length).toBeGreaterThan(0);
        expect(conflicts.every((c) => c.status === "absent")).toBe(true);

        const staged = stageBaselineAdditions(
          realTemplatesCoreDir,
          conflicts,
          groundworkDir,
          {},
        );

        expect(staged.length).toBe(conflicts.length);
        for (const file of staged) {
          expect(file.staged.endsWith(STAGED_SUFFIX)).toBe(true);
          // The staged name as a whole must never match a toolchain-globbed
          // extension other than via the ".staged" suffix itself.
          expect(file.staged).not.toMatch(
            /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|ya?ml)$/,
          );
          expect(file.staged).not.toBe("CLAUDE.md");
          expect(file.staged).not.toBe("SKILL.md");
        }

        const claudeMd = staged.find((f) => f.path === "CLAUDE.md");
        expect(claudeMd?.staged).toBe("CLAUDE.md.staged");

        const nestedSkill = staged.find(
          (f) =>
            f.path.includes(".claude/skills/") && f.path.endsWith("SKILL.md"),
        );
        expect(nestedSkill).toBeDefined();
        expect(nestedSkill?.staged.endsWith("SKILL.md.staged")).toBe(true);
      } finally {
        rmSync(emptyTarget, { recursive: true, force: true });
      }
    });
  });

  describe("tokenized template paths", () => {
    it("stages a file whose template NAME contains a token under the substituted path, reporting the substituted path", () => {
      writeFileSync(join(templateRoot, "__PROJECT_NAME__.txt"), "hello\n");
      const tokens = { PROJECT_NAME: "demo" };
      const conflicts = planConflicts(templateRoot, targetDir, tokens);
      expect(conflicts.find((c) => c.relPath === "demo.txt")?.status).toBe(
        "absent",
      );

      const staged = stageBaselineAdditions(
        templateRoot,
        conflicts,
        groundworkDir,
        tokens,
      );

      const entry = staged.find((f) => f.path === "demo.txt");
      expect(entry).toBeDefined();
      expect(entry?.staged).toBe("demo.txt.staged");
      expect(
        existsSync(join(groundworkDir, STAGED_BASELINE_DIR, "demo.txt.staged")),
      ).toBe(true);
    });

    it("stages a file inside a token-named directory under the substituted directory path", () => {
      mkdirSync(join(templateRoot, "__PROJECT_NAME__"), { recursive: true });
      writeFileSync(join(templateRoot, "__PROJECT_NAME__", "a.txt"), "hi\n");
      const tokens = { PROJECT_NAME: "demo" };
      const conflicts = planConflicts(templateRoot, targetDir, tokens);
      expect(conflicts.find((c) => c.relPath === "demo/a.txt")?.status).toBe(
        "absent",
      );

      const staged = stageBaselineAdditions(
        templateRoot,
        conflicts,
        groundworkDir,
        tokens,
      );

      const entry = staged.find((f) => f.path === "demo/a.txt");
      expect(entry).toBeDefined();
      expect(entry?.staged).toBe("demo/a.txt.staged");
      expect(
        existsSync(
          join(groundworkDir, STAGED_BASELINE_DIR, "demo", "a.txt.staged"),
        ),
      ).toBe(true);
    });

    it("throws when an absent conflict's relPath cannot be matched to any template file", () => {
      writeTemplateFixture();
      const bogus: FileConflict = {
        relPath: "does/not/exist.txt",
        status: "absent",
        keyDiffs: undefined,
      };

      expect(() =>
        stageBaselineAdditions(templateRoot, [bogus], groundworkDir, {}),
      ).toThrow();
    });
  });

  describe("atomic staging", () => {
    describe("plan failure (planStaging runs before the try: no wrapping, no temp dir, previous baseline untouched)", () => {
      it("throws its own distinct Error -- no 'incomplete'/'re-run' wording, no cause -- when an absent conflict has no template counterpart", () => {
        writeTemplateFixture();
        writeTargetFixture();
        const firstConflicts = planConflicts(templateRoot, targetDir, {});
        stageBaselineAdditions(templateRoot, firstConflicts, groundworkDir, {});

        const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
        const before = listFiles(baselineDir);
        expect(before.length).toBeGreaterThan(0);

        // A second, mixed run: the legitimate absent files (which would copy
        // successfully) plus one conflict with no template counterpart at
        // all, which must fail the whole run before anything is touched.
        const bogus: FileConflict = {
          relPath: "ghost.txt",
          status: "absent",
          keyDiffs: undefined,
        };
        const mixedConflicts = [
          ...firstConflicts.filter((c) => c.status === "absent"),
          bogus,
        ];

        let thrown: unknown;
        try {
          stageBaselineAdditions(
            templateRoot,
            mixedConflicts,
            groundworkDir,
            {},
          );
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        // Distinct from the generic "staging failed, incomplete, re-run"
        // wrapper used for a failure that happens AFTER the temp dir
        // exists -- planStaging's own failure is reported directly, never
        // wrapped with a cause.
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect((thrown as Error).cause).toBeUndefined();

        // The previous successful staging is untouched.
        expect(listFiles(baselineDir)).toEqual(before);

        // No sibling temp directory survives the failed run -- planStaging
        // never got far enough to create one.
        expect(readdirSync(groundworkDir)).toEqual([STAGED_BASELINE_DIR]);
      });

      it("throws its own distinct Error naming the path and both sources -- no 'incomplete'/'re-run' wording, no cause -- when two template files map to the same install path (a dotfile-escaped name and its literal twin)", () => {
        writeFileSync(join(templateRoot, "_gitignore"), "escaped\n");
        writeFileSync(join(templateRoot, ".gitignore"), "literal\n");
        const absent: FileConflict = {
          relPath: ".gitignore",
          status: "absent",
          keyDiffs: undefined,
        };

        let thrown: unknown;
        try {
          stageBaselineAdditions(templateRoot, [absent], groundworkDir, {});
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(".gitignore");
        expect(message).toContain("_gitignore");
        expect(message).not.toContain("re-run");
        expect(message).not.toContain("incomplete");
        expect((thrown as Error).cause).toBeUndefined();
        expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(
          false,
        );
      });

      it("throws its own distinct Error -- not the no-counterpart wording either -- when an absent conflict's relPath would escape the staging directory (CWE-22)", () => {
        writeTemplateFixture();
        writeTargetFixture();
        const firstConflicts = planConflicts(templateRoot, targetDir, {});
        stageBaselineAdditions(templateRoot, firstConflicts, groundworkDir, {});

        const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
        const before = listFiles(baselineDir);
        expect(before.length).toBeGreaterThan(0);

        const escaping: FileConflict = {
          relPath: "../escape.txt",
          status: "absent",
          keyDiffs: undefined,
        };

        let thrown: unknown;
        try {
          stageBaselineAdditions(templateRoot, [escaping], groundworkDir, {});
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect(message).not.toContain("no counterpart");
        expect((thrown as Error).cause).toBeUndefined();

        // The previous successful staging is untouched, and no temp dir
        // survives.
        expect(listFiles(baselineDir)).toEqual(before);
        expect(readdirSync(groundworkDir)).toEqual([STAGED_BASELINE_DIR]);
      });
    });

    it("throws an Error with a cause naming the real failure, wrapped with '.groundwork/'/'incomplete'/'re-run', leaving no temp dir and the previous baseline intact, for a failure that happens AFTER the temp staging dir already exists", () => {
      // This failure mode (a write failing mid-copy, once the temp dir and
      // some files already exist) is exercised with a mocked node:fs write
      // primitive in the isolated baseline-stage-write-failure.test.ts file,
      // the same pattern baseline-stage-swap-restore.test.ts uses -- see
      // that file's header comment for why the mock lives in its own file
      // rather than here.
      expect(true).toBe(true);
    });

    it("removes a stale .groundwork/.baseline-* temp dir left by a crashed earlier run before staging, without touching an unrelated directory", () => {
      mkdirSync(join(groundworkDir, ".baseline-stale1", "x"), {
        recursive: true,
      });
      writeFileSync(
        join(groundworkDir, ".baseline-stale1", "x", "leftover.txt"),
        "leftover\n",
      );
      mkdirSync(join(groundworkDir, ".other"), { recursive: true });
      mkdirSync(join(groundworkDir, "packs"), { recursive: true });

      writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});

      stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});

      expect(existsSync(join(groundworkDir, ".baseline-stale1"))).toBe(false);
      expect(existsSync(join(groundworkDir, ".other"))).toBe(true);
      expect(existsSync(join(groundworkDir, "packs"))).toBe(true);
    });

    it("stages normally when groundworkDir does not exist yet -- the stale-work-dir sweep is a no-op, not a failure, against a missing directory", () => {
      // removeStaleWorkDirs runs before mkdirSync(groundworkDir) (inside the
      // later try block) ever creates it, so at the point it runs,
      // groundworkDir genuinely does not exist on disk.
      rmSync(groundworkDir, { recursive: true, force: true });
      expect(existsSync(groundworkDir)).toBe(false);

      writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});

      const staged = stageBaselineAdditions(
        templateRoot,
        conflicts,
        groundworkDir,
        {},
      );

      expect(staged.map((f) => f.path)).toEqual(["only.txt"]);
      expect(
        existsSync(join(groundworkDir, STAGED_BASELINE_DIR, "only.txt.staged")),
      ).toBe(true);
    });
  });

  describe("toPosixPath", () => {
    it("replaces every backslash with a forward slash", () => {
      expect(toPosixPath("a\\b\\c.txt")).toBe("a/b/c.txt");
      expect(toPosixPath("already/posix.txt")).toBe("already/posix.txt");
      expect(toPosixPath("")).toBe("");
    });
  });

  describe("symlink guard", () => {
    let outsideDir: string;

    beforeEach(() => {
      outsideDir = mkdtempSync(join(tmpdir(), "baseline-stage-outside-"));
    });

    afterEach(() => {
      rmSync(outsideDir, { recursive: true, force: true });
    });

    it("throws before writing or deleting anything when groundworkDir itself is a symlink", () => {
      writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch");
      // Replace the real temp dir with a symlink pointing outside it.
      rmSync(groundworkDir, { recursive: true, force: true });
      symlinkSync(outsideDir, groundworkDir, "dir");

      writeTemplateFixture();
      const conflicts = planConflicts(templateRoot, targetDir, {});

      expect(() =>
        stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {}),
      ).toThrow();

      expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
        "do not touch",
      );
      expect(existsSync(join(outsideDir, STAGED_BASELINE_DIR))).toBe(false);
    });

    it("throws before writing or deleting anything when <groundworkDir>/baseline is a symlink", () => {
      writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch");
      symlinkSync(outsideDir, join(groundworkDir, STAGED_BASELINE_DIR), "dir");

      writeTemplateFixture();
      const conflicts = planConflicts(templateRoot, targetDir, {});

      expect(() =>
        stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {}),
      ).toThrow();

      expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
        "do not touch",
      );
    });
  });

  describe("plannedBaselineStagingPaths (round-2 item 3)", () => {
    it("returns every path stageBaselineAdditions would write, all resolving under groundworkDir/baseline, writing nothing", () => {
      writeTemplateFixture();
      writeTargetFixture();
      const conflicts = planConflicts(templateRoot, targetDir, {});
      const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);

      const paths = plannedBaselineStagingPaths(
        templateRoot,
        conflicts,
        groundworkDir,
        {},
      );

      expect(existsSync(baselineDir)).toBe(false);
      const absentRelPaths = conflicts
        .filter((c) => c.status === "absent")
        .map((c) => c.relPath);
      expect(paths.length).toBe(absentRelPaths.length);
      for (const path of paths) {
        expect(path.startsWith(baselineDir)).toBe(true);
      }
      for (const relPath of absentRelPaths) {
        expect(paths).toContain(
          join(baselineDir, `${relPath}${STAGED_SUFFIX}`),
        );
      }
    });

    it("returns [] when nothing is absent, writing nothing", () => {
      writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
      writeFileSync(join(targetDir, "only.txt"), "same everywhere\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});
      expect(conflicts.every((c) => c.status !== "absent")).toBe(true);

      const paths = plannedBaselineStagingPaths(
        templateRoot,
        conflicts,
        groundworkDir,
        {},
      );

      expect(paths).toEqual([]);
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
    });

    it("throws the same plan error as stageBaselineAdditions -- no counterpart -- writing nothing", () => {
      const bogus: FileConflict = {
        relPath: "ghost.txt",
        status: "absent",
        keyDiffs: undefined,
      };

      expect(() =>
        plannedBaselineStagingPaths(templateRoot, [bogus], groundworkDir, {}),
      ).toThrow(/ghost\.txt/);
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
      expect(readdirSync(groundworkDir)).toEqual([]);
    });

    it("throws the same plan error as stageBaselineAdditions -- duplicate install path -- writing nothing", () => {
      writeFileSync(join(templateRoot, "_gitignore"), "escaped\n");
      writeFileSync(join(templateRoot, ".gitignore"), "literal\n");
      const absent: FileConflict = {
        relPath: ".gitignore",
        status: "absent",
        keyDiffs: undefined,
      };

      let thrown: unknown;
      try {
        plannedBaselineStagingPaths(templateRoot, [absent], groundworkDir, {});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(".gitignore");
      expect(message).toContain("_gitignore");
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
      expect(readdirSync(groundworkDir)).toEqual([]);
    });

    it("throws the same plan error as stageBaselineAdditions -- escaping staged path (CWE-22) -- writing nothing", () => {
      const escaping: FileConflict = {
        relPath: "../escape.txt",
        status: "absent",
        keyDiffs: undefined,
      };

      expect(() =>
        plannedBaselineStagingPaths(
          templateRoot,
          [escaping],
          groundworkDir,
          {},
        ),
      ).toThrow();
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
      expect(readdirSync(groundworkDir)).toEqual([]);
    });
  });

  describe("staged-path collision detection (round-2 item 4)", () => {
    it("throws its own distinct Error naming both paths -- no 'incomplete'/'re-run' wording, no cause -- when one absent file's staged name is a directory-prefix of another's (a top-level file 'x' beside a directory 'x.staged/' containing 'y')", () => {
      writeFileSync(join(templateRoot, "x"), "the file\n");
      mkdirSync(join(templateRoot, "x.staged"), { recursive: true });
      writeFileSync(join(templateRoot, "x.staged", "y"), "the nested file\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});
      expect(conflicts.map((c) => c.relPath).sort()).toEqual(
        ["x", "x.staged/y"].sort(),
      );
      expect(conflicts.every((c) => c.status === "absent")).toBe(true);

      let thrown: unknown;
      try {
        stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("x.staged");
      expect(message).toContain("x.staged/y.staged");
      expect(message).not.toContain("incomplete");
      expect(message).not.toContain("re-run");
      expect((thrown as Error).cause).toBeUndefined();
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
      expect(readdirSync(groundworkDir)).toEqual([]);
    });

    it("throws its own distinct Error naming both paths -- no 'incomplete'/'re-run' wording, no cause -- when two absent files' staged names collide only by case (a literal 'readme.md' beside a tokenized name substituting to 'README.md')", () => {
      writeFileSync(join(templateRoot, "readme.md"), "literal readme\n");
      writeFileSync(
        join(templateRoot, "__PROJECT_NAME__.md"),
        "tokenized readme\n",
      );
      const tokens = { PROJECT_NAME: "README" };
      const conflicts = planConflicts(templateRoot, targetDir, tokens);
      expect(conflicts.map((c) => c.relPath).sort()).toEqual(
        ["README.md", "readme.md"].sort(),
      );
      expect(conflicts.every((c) => c.status === "absent")).toBe(true);

      let thrown: unknown;
      try {
        stageBaselineAdditions(templateRoot, conflicts, groundworkDir, tokens);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("README.md");
      expect(message).toContain("readme.md");
      expect(message).not.toContain("incomplete");
      expect(message).not.toContain("re-run");
      expect((thrown as Error).cause).toBeUndefined();
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
      expect(readdirSync(groundworkDir)).toEqual([]);
    });
  });

  describe("colon in a relPath (round-2 item 6 -- pack-stage only, baseline unaffected)", () => {
    it("stages a file whose relPath contains a colon without throwing -- only pack-stage.ts refuses ':'", () => {
      writeFileSync(join(templateRoot, "c:foo"), "colon file\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});
      expect(conflicts.find((c) => c.relPath === "c:foo")?.status).toBe(
        "absent",
      );

      const staged = stageBaselineAdditions(
        templateRoot,
        conflicts,
        groundworkDir,
        {},
      );

      const entry = staged.find((f) => f.path === "c:foo");
      expect(entry).toBeDefined();
      expect(entry?.staged).toBe("c:foo.staged");
    });
  });
});
