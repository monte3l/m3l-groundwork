// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyDocs } from "../../src/survey/survey-docs.js";

describe("surveyDocs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no files for a bare directory", () => {
    expect(surveyDocs(dir)).toEqual({ files: [] });
  });

  it("indexes README.md and CONTRIBUTING.md at the root with their heading outline", () => {
    writeFileSync(join(dir, "README.md"), "# Title\n\n## Usage\n");
    writeFileSync(join(dir, "CONTRIBUTING.md"), "# Contributing\n");

    const survey = surveyDocs(dir);
    const paths = survey.files.map((f) => f.path).sort();

    expect(paths).toEqual(
      [join(dir, "CONTRIBUTING.md"), join(dir, "README.md")].sort(),
    );
    const readme = survey.files.find((f) => f.path.endsWith("README.md"));
    expect(readme?.headings).toEqual(["Title", "Usage"]);
    expect(readme?.sizeBytes).toBeGreaterThan(0);
  });

  it("indexes a STYLE*.md file at the root", () => {
    writeFileSync(join(dir, "STYLE_GUIDE.md"), "# Style\n");
    expect(surveyDocs(dir).files.map((f) => f.path)).toContain(
      join(dir, "STYLE_GUIDE.md"),
    );
  });

  it("indexes markdown files under docs/contributing and docs/adr", () => {
    mkdirSync(join(dir, "docs", "contributing"), { recursive: true });
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "contributing", "style-guide.md"),
      "# Style\n",
    );
    writeFileSync(join(dir, "docs", "adr", "0001-foo.md"), "# ADR 1\n");

    const paths = surveyDocs(dir)
      .files.map((f) => f.path)
      .sort();
    expect(paths).toEqual(
      [
        join(dir, "docs", "adr", "0001-foo.md"),
        join(dir, "docs", "contributing", "style-guide.md"),
      ].sort(),
    );
  });

  it("indexes a top-level decisions/ or adr/ directory", () => {
    mkdirSync(join(dir, "adr"), { recursive: true });
    writeFileSync(join(dir, "adr", "0001.md"), "# ADR\n");
    expect(surveyDocs(dir).files.map((f) => f.path)).toContain(
      join(dir, "adr", "0001.md"),
    );
  });
});
