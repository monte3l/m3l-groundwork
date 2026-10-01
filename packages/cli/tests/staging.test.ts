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
import { STAGED_SUFFIX, stagedNameFor, toPosixPath } from "../src/staging.js";
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
