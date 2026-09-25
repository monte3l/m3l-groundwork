// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The survey aggregate: runs all four collectors against a target directory
 * and returns the combined `ProjectSurvey`. See `types.ts` for the shape
 * and each `survey-*.ts` module's header for what it collects and why.
 */
import { surveyDocs } from "./survey-docs.js";
import { surveyHarness } from "./survey-harness.js";
import { surveyShape } from "./survey-shape.js";
import { surveyToolchain } from "./survey-toolchain.js";
import type { ProjectSurvey } from "./types.js";

// Every collector's field type (ShapeSurvey, ToolchainSurvey, ...) lives in
// ./types.js -- import from there directly rather than through this
// aggregator, which only re-exports the one type its own callers need.
export type { ProjectSurvey } from "./types.js";

/** Surveys `dir` end to end: shape, toolchain, harness, and docs. Offline, read-only. */
export function surveyProject(dir: string): ProjectSurvey {
  const undetermined: string[] = [];

  return {
    shape: surveyShape(dir, undetermined),
    toolchain: surveyToolchain(dir, undetermined),
    harness: surveyHarness(dir),
    docs: surveyDocs(dir),
    undetermined: [...new Set(undetermined)],
  };
}
