// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// A script literally named `__proto__` is an OWN property after JSON.parse and
// must be surveyed like any other; the copy must never touch Object.prototype.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyToolchain } from "../../src/survey/survey-toolchain.js";

describe("surveyToolchain scripts: own Object.prototype-named scripts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "survey-proto-"));
    // Raw text on purpose: only JSON.parse makes `__proto__` an own key.
    writeFileSync(
      join(dir, "package.json"),
      `{"scripts":{"__proto__":"echo hi","constructor":"echo c","build":"tsc"}}`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports all three scripts as own entries with their commands", () => {
    const { scripts } = surveyToolchain(dir, []);
    expect(Object.keys(scripts).sort()).toEqual([
      "__proto__",
      "build",
      "constructor",
    ]);
    expect(Object.getOwnPropertyDescriptor(scripts, "__proto__")?.value).toBe(
      "echo hi",
    );
    expect(Object.getOwnPropertyDescriptor(scripts, "constructor")?.value).toBe(
      "echo c",
    );
    expect(Object.getOwnPropertyDescriptor(scripts, "build")?.value).toBe(
      "tsc",
    );
  });

  it("leaves Object.prototype untouched", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    surveyToolchain(dir, []);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
