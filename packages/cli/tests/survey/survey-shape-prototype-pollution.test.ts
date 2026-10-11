// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyShape } from "../../src/survey/survey-shape.js";

const FIELDS = ["exports", "bin", "main"] as const;

describe("surveyShape kindEvidence ignores inherited properties", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shape-proto-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    for (const field of FIELDS) {
      Object.defineProperty(Object.prototype, field, {
        value: "inherited",
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  });

  afterEach(() => {
    for (const field of FIELDS) {
      Reflect.deleteProperty(Object.prototype, field);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not report exports/bin/main for a package.json without own fields", () => {
    const { kindEvidence } = surveyShape(dir, []);
    expect(kindEvidence.hasExportsMap).toBe(false);
    expect(kindEvidence.hasBinField).toBe(false);
    expect(kindEvidence.hasMainField).toBe(false);
  });

  it("still reports own fields", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ exports: "./a.js", bin: "./b.js", main: "./c.js" }),
    );
    const { kindEvidence } = surveyShape(dir, []);
    expect(kindEvidence.hasExportsMap).toBe(true);
    expect(kindEvidence.hasBinField).toBe(true);
    expect(kindEvidence.hasMainField).toBe(true);
  });
});
