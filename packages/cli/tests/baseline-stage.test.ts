// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `stageBaselineAdditions` copies only the template files a conflict plan
 * (`conflicts.ts`'s `planConflicts`) marked "absent" into
 * `<groundworkDir>/baseline`, verbatim -- the staged copy `/customize`'s
 * Step 0 installs from for a project the CLI itself never touches directly.
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import {
  STAGED_BASELINE_DIR,
  stageBaselineAdditions,
} from "../src/baseline-stage.js";

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

  it("exports the staging directory name as a constant", () => {
    expect(STAGED_BASELINE_DIR).toBe("baseline");
  });

  it("stages exactly the absent files, restores the dotfile name, and leaves no empty directory for a skipped-only directory", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const conflicts = planConflicts(templateRoot, targetDir, {});

    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
    );

    const expectedRelPaths = conflicts
      .filter((c) => c.status === "absent")
      .map((c) => c.relPath);
    expect(staged).toEqual(expectedRelPaths);
    expect([...staged].sort()).toEqual(
      [".gitignore", "new.txt", "src/deep.ts"].sort(),
    );

    const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
    expect(listFiles(baselineDir)).toEqual(
      [".gitignore", "new.txt", "src/deep.ts"].sort(),
    );
    expect(existsSync(join(baselineDir, "identical-dir"))).toBe(false);
    expect(existsSync(join(baselineDir, "same.txt"))).toBe(false);
    expect(existsSync(join(baselineDir, "differing.txt"))).toBe(false);
    expect(existsSync(join(baselineDir, "_gitignore"))).toBe(false);

    expect(readFileSync(join(baselineDir, "new.txt"), "utf8")).toBe(
      "__PROJECT_NAME__",
    );
    expect(readFileSync(join(baselineDir, "src", "deep.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(baselineDir, ".gitignore"), "utf8")).toBe(
      "node_modules\n",
    );
  });

  it("never substitutes tokens, even when the conflict plan itself was computed with a non-empty token table", () => {
    writeTemplateFixture();
    writeTargetFixture();
    // A real substitution would turn new.txt's content into "acme-corp";
    // the conflict's "absent" status does not depend on this table at all
    // (the file is absent from the target either way), so this isolates
    // whether staging itself ever applies tokens.
    const conflicts = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme-corp",
    });

    stageBaselineAdditions(templateRoot, conflicts, groundworkDir);

    expect(
      readFileSync(join(groundworkDir, STAGED_BASELINE_DIR, "new.txt"), "utf8"),
    ).toBe("__PROJECT_NAME__");
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
    );

    expect(staged).toEqual([]);
    expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
  });

  it("replaces a previous staging on re-stage rather than accumulating stale files", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const firstConflicts = planConflicts(templateRoot, targetDir, {});
    stageBaselineAdditions(templateRoot, firstConflicts, groundworkDir);
    expect(
      existsSync(join(groundworkDir, STAGED_BASELINE_DIR, "new.txt")),
    ).toBe(true);

    // new.txt now exists in the target too (no longer absent); a brand-new
    // file appears in the template instead.
    writeFileSync(join(targetDir, "new.txt"), "__PROJECT_NAME__");
    writeFileSync(join(templateRoot, "fresh.txt"), "fresh content\n");
    const secondConflicts = planConflicts(templateRoot, targetDir, {});

    stageBaselineAdditions(templateRoot, secondConflicts, groundworkDir);

    expect(
      existsSync(join(groundworkDir, STAGED_BASELINE_DIR, "new.txt")),
    ).toBe(false);
    expect(
      readFileSync(
        join(groundworkDir, STAGED_BASELINE_DIR, "fresh.txt"),
        "utf8",
      ),
    ).toBe("fresh content\n");
  });

  it("remains readable after the template root it was staged from is deleted", () => {
    writeTemplateFixture();
    writeTargetFixture();
    const conflicts = planConflicts(templateRoot, targetDir, {});
    stageBaselineAdditions(templateRoot, conflicts, groundworkDir);

    rmSync(templateRoot, { recursive: true, force: true });

    const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
    expect(readFileSync(join(baselineDir, "new.txt"), "utf8")).toBe(
      "__PROJECT_NAME__",
    );
    expect(readFileSync(join(baselineDir, "src", "deep.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(baselineDir, ".gitignore"), "utf8")).toBe(
      "node_modules\n",
    );
  });
});
