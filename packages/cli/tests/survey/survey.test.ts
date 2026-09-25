// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyProject } from "../../src/survey/survey.js";

describe("surveyProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "survey-project-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates all four collectors into one ProjectSurvey", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "vitest" } }),
    );
    writeFileSync(join(dir, "README.md"), "# Project\n");

    const survey = surveyProject(dir);

    expect(survey.shape.moduleType).toBe("module");
    expect(survey.toolchain.scripts).toEqual({ test: "vitest" });
    expect(survey.harness.present).toBe(false);
    expect(survey.docs.files.map((f) => f.path)).toContain(
      join(dir, "README.md"),
    );
    expect(survey.undetermined).toEqual([]);
  });

  it("surfaces toolchain-level undetermined entries at the aggregate level", () => {
    writeFileSync(join(dir, "tsconfig.json"), "{not json");
    const survey = surveyProject(dir);
    expect(survey.undetermined.length).toBeGreaterThan(0);
  });

  // Contract 7: surveyShape and surveyToolchain each run their own private
  // readPackageJson against the SAME package.json and independently push a
  // "could not parse ..." message into the SHARED undetermined array
  // surveyProject passes to both. A malformed package.json must therefore
  // be reported exactly once in the aggregate result, not once per
  // collector -- surveyProject is expected to de-duplicate the final array
  // before returning it.
  it("reports a malformed package.json exactly once, not once per collector", () => {
    writeFileSync(join(dir, "package.json"), "{not valid json");

    const survey = surveyProject(dir);

    const packageJsonEntries = survey.undetermined.filter((msg) =>
      msg.includes("package.json"),
    );
    expect(packageJsonEntries.length).toBe(1);
  });
});
