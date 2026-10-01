// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `staging.ts` is the shared module `baseline-stage.ts` and `pack-stage.ts`
 * both build on: the `.staged` suffix convention, the staged-name derivation,
 * and the posix-path normalizer. `baseline-stage.ts` re-exports
 * `STAGED_SUFFIX`/`stagedNameFor`/`toPosixPath` rather than redeclaring them,
 * so every existing `baseline-stage*.test.ts` file keeps passing unchanged --
 * this file only covers the exports `pack-stage.ts` relies on directly, plus
 * the re-export identity itself.
 */
import { describe, expect, it } from "vitest";
import {
  STAGED_SUFFIX,
  findStagedPathCollision,
  stagedNameFor,
  toPosixPath,
} from "../src/staging.js";
import {
  STAGED_SUFFIX as baselineStagedSuffix,
  stagedNameFor as baselineStagedNameFor,
  toPosixPath as baselineToPosixPath,
} from "../src/baseline-stage.js";

describe("staging.ts exports", () => {
  it("exports the neutral suffix every staged file carries", () => {
    expect(STAGED_SUFFIX).toBe(".staged");
  });

  it("stagedNameFor appends the suffix to a project-relative path", () => {
    expect(stagedNameFor("src/index.ts")).toBe("src/index.ts.staged");
    expect(stagedNameFor("eslint.config.js")).toBe("eslint.config.js.staged");
    expect(stagedNameFor("")).toBe(".staged");
  });

  it("toPosixPath replaces every backslash with a forward slash, leaving an already-posix path untouched", () => {
    expect(toPosixPath("a\\b\\c.txt")).toBe("a/b/c.txt");
    expect(toPosixPath("already/posix.txt")).toBe("already/posix.txt");
    expect(toPosixPath("")).toBe("");
  });

  it("baseline-stage.ts re-exports the identical STAGED_SUFFIX value", () => {
    expect(baselineStagedSuffix).toBe(STAGED_SUFFIX);
  });

  it("baseline-stage.ts re-exports the SAME stagedNameFor function, not a reimplementation (reference identity)", () => {
    expect(baselineStagedNameFor).toBe(stagedNameFor);
  });

  it("baseline-stage.ts re-exports the SAME toPosixPath function, not a reimplementation (reference identity)", () => {
    expect(baselineToPosixPath).toBe(toPosixPath);
  });
});

describe("findStagedPathCollision (round-2 item 4)", () => {
  it.each([
    [
      "two staged names equal after case-fold",
      ["README.md.staged", "readme.md.staged"],
      ["README.md.staged", "readme.md.staged"],
    ],
    [
      "one staged name is a proper directory-prefix of another",
      ["x.staged", "x.staged/y.staged"],
      ["x.staged", "x.staged/y.staged"],
    ],
    [
      "a directory-prefix collision that ALSO needs case-folding to match (ancestor segment 'X.staged' folds to 'x.staged')",
      ["X.staged", "x.staged/y.staged"],
      ["X.staged", "x.staged/y.staged"],
    ],
    [
      "the same directory-prefix pair in reverse array order",
      ["x.staged/y.staged", "x.staged"],
      ["x.staged/y.staged", "x.staged"],
    ],
  ])("flags %s", (_label, paths, expectedMentions) => {
    const collision = findStagedPathCollision(paths);
    expect(collision).toBeDefined();
    for (const mention of expectedMentions) {
      expect(collision).toContain(mention);
    }
  });

  it.each([
    ["no paths at all", []],
    ["a single path", ["only.staged"]],
    ["two unrelated flat names", ["a.staged", "b.staged"]],
    [
      "two sibling files under the same directory (neither is a prefix of the other)",
      ["x.staged/y.staged", "x.staged/z.staged"],
    ],
    [
      "a mere string prefix without a path-segment boundary (must not false-positive)",
      ["abc.staged", "abcd.staged"],
    ],
  ])("does not flag %s", (_label, paths) => {
    expect(findStagedPathCollision(paths)).toBeUndefined();
  });
});
