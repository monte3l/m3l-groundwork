// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A regular file sitting where a survey collector expects a directory
 * (`.claude/skills`, `.github/workflows`) makes `guardedExists` report
 * `present` (a `stat` on a regular file succeeds) and then the directory
 * listing itself (`readdirSync`) raises `ENOTDIR` -- a property of the
 * project's own tree, exactly like `EISDIR` is for a single-file read
 * landing on a directory. `read-guard.test.ts` proves this at
 * `guardedRead`'s own level; this file is the adopt-level proof that
 * `surveyHarness`/`surveyToolchain` carry that gap through to their own
 * callers, the same shape `survey-harness-unreadable.test.ts` and
 * `survey-toolchain-unreadable.test.ts` use for EACCES/EISDIR.
 *
 * RED today: `recordedReadCode` (`read-guard.ts`) does not recognize
 * `ENOTDIR`, so both collectors throw a `SurveyReadError` instead of
 * recording the path and continuing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyHarness } from "../../src/survey/survey-harness.js";
import { surveyToolchain } from "../../src/survey/survey-toolchain.js";

describe("surveyHarness: a regular file at .claude/skills (ENOTDIR on the directory listing) is recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];
  let skillsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-entdir-skills-"));
    undetermined = [];
    mkdirSync(join(dir, ".claude"), { recursive: true });
    skillsPath = join(dir, ".claude", "skills");
    writeFileSync(skillsPath, "not a directory");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("yields an empty skills[] rather than throwing, and records the path with ENOTDIR in undetermined", () => {
    let thrown: unknown;
    let survey;
    try {
      survey = surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.skills).toEqual([]);
    expect(
      undetermined.some(
        (entry) => entry.includes(skillsPath) && entry.includes("ENOTDIR"),
      ),
    ).toBe(true);
  });
});

describe("surveyToolchain: a regular file at .github/workflows (ENOTDIR on the directory listing) is recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];
  let workflowsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-entdir-workflows-"));
    undetermined = [];
    mkdirSync(join(dir, ".github"), { recursive: true });
    workflowsPath = join(dir, ".github", "workflows");
    writeFileSync(workflowsPath, "not a directory");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("yields an empty workflows.files[] rather than throwing, and records the path with ENOTDIR in undetermined", () => {
    let thrown: unknown;
    let survey;
    try {
      survey = surveyToolchain(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.workflows.files).toEqual([]);
    expect(
      undetermined.some(
        (entry) => entry.includes(workflowsPath) && entry.includes("ENOTDIR"),
      ),
    ).toBe(true);
  });
});
