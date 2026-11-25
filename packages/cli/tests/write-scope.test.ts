// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { AssertionError } from "node:assert/strict";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAdoptWriteScope as fromMain } from "../src/main.js";
import { assertAdoptWriteScope } from "../src/write-scope.js";

const TARGET = "/work/app";
const PREFIX = "adopt mode wrote outside its scope:";

describe("assertAdoptWriteScope", () => {
  it.each([
    [".groundwork/inventory.json"],
    [join(TARGET, ".groundwork", "adoption-report.md")],
    [".claude/skills/customize/SKILL.md"],
  ])("accepts the in-scope path %s", (path) => {
    expect(() => {
      assertAdoptWriteScope(TARGET, [path]);
    }).not.toThrow();
  });

  it("accepts an empty path list", () => {
    expect(() => {
      assertAdoptWriteScope(TARGET, []);
    }).not.toThrow();
  });

  it.each([
    ["an absolute project file", join(TARGET, "package.json")],
    ["a ../ escape", ".groundwork/../package.json"],
    ["a look-alike sibling", ".groundwork-evil/x"],
    ["a .claude path outside the skill dest", ".claude/settings.json"],
  ])("rejects %s with the scope message", (_label, path) => {
    let thrown: unknown;
    try {
      assertAdoptWriteScope(TARGET, [path]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssertionError);
    expect((thrown as AssertionError).message).toContain(PREFIX);
  });

  it("names the first offending path, resolved, and stops there", () => {
    let thrown: unknown;
    try {
      assertAdoptWriteScope(TARGET, [
        ".groundwork/ok.json",
        "package.json",
        "README.md",
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssertionError);
    const message = (thrown as AssertionError).message;
    expect(message).toContain(`${PREFIX} ${join(TARGET, "package.json")}`);
    expect(message).not.toContain(join(TARGET, "README.md"));
  });

  it("is re-exported from main.js as the identical function", () => {
    expect(fromMain).toBe(assertAdoptWriteScope);
  });
});
