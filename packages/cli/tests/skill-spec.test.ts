// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, expectTypeOf, it } from "vitest";
import { join } from "node:path";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_WRITE_ORDER,
  GROUNDWORK_DEST_SEGMENTS,
  plannedCustomizeSkillPaths,
} from "../src/customize-paths.js";
import {
  assertValidSkillSpec,
  CUSTOMIZE_SKILL,
  plannedSkillPaths,
  type SkillSpec,
} from "../src/skill-spec.js";
import { DEMO_SPEC } from "./skill-fixture.js";

describe("SkillSpec", () => {
  it("has the documented shape", () => {
    expectTypeOf<SkillSpec>().toEqualTypeOf<{
      readonly name: string;
      readonly entryFile: string;
      readonly writeOrder: readonly string[];
      readonly claudeSegments: readonly string[];
      readonly fallbackSegments: readonly string[];
      readonly sourceFile: (sourceDir: string, fileName: string) => string;
    }>();
  });
});

describe("CUSTOMIZE_SKILL", () => {
  it("mirrors the customize-paths constants", () => {
    expect(CUSTOMIZE_SKILL.name).toBe("customize");
    expect(CUSTOMIZE_SKILL.entryFile).toBe("SKILL.md");
    expect(CUSTOMIZE_SKILL.writeOrder).toEqual(CUSTOMIZE_SKILL_WRITE_ORDER);
    expect(CUSTOMIZE_SKILL.claudeSegments).toEqual(CLAUDE_DEST_SEGMENTS);
    expect(CUSTOMIZE_SKILL.fallbackSegments).toEqual(GROUNDWORK_DEST_SEGMENTS);
  });

  it("sources step files and SKILL.md from skills/customize and data files from src", () => {
    expect(CUSTOMIZE_SKILL.sourceFile("/p", "SKILL.md")).toBe(
      join("/p", "skills", "customize", "SKILL.md"),
    );
    expect(CUSTOMIZE_SKILL.sourceFile("/p", "step-0-reconcile.md")).toBe(
      join("/p", "skills", "customize", "step-0-reconcile.md"),
    );
    expect(CUSTOMIZE_SKILL.sourceFile("/p", "domain-map.ts")).toBe(
      join("/p", "src", "domain-map.ts"),
    );
  });

  it("ends its write order with its entry file", () => {
    expect(CUSTOMIZE_SKILL.writeOrder.at(-1)).toBe(CUSTOMIZE_SKILL.entryFile);
  });
});

describe("plannedSkillPaths", () => {
  it("lists both locations' paths for every file", () => {
    const paths = plannedSkillPaths(DEMO_SPEC);
    expect(paths).toHaveLength(6);
    expect(new Set(paths)).toEqual(
      new Set([
        join(".claude", "skills", "demo", "data.txt"),
        join(".claude", "skills", "demo", "step-1.md"),
        join(".claude", "skills", "demo", "SKILL.md"),
        join(".groundwork", "demo", "data.txt"),
        join(".groundwork", "demo", "step-1.md"),
        join(".groundwork", "demo", "SKILL.md"),
      ]),
    );
  });

  it("equals plannedCustomizeSkillPaths for CUSTOMIZE_SKILL", () => {
    expect(plannedSkillPaths(CUSTOMIZE_SKILL)).toEqual(
      plannedCustomizeSkillPaths(),
    );
  });
});

describe("assertValidSkillSpec", () => {
  it("returns a frozen copy, not the caller's arrays", () => {
    const writeOrder = ["data.txt", "step-1.md", "SKILL.md"];
    const claudeSegments = [".claude", "skills", "demo"];
    const fallbackSegments = [".groundwork", "demo"];
    const spec: SkillSpec = {
      ...DEMO_SPEC,
      writeOrder,
      claudeSegments,
      fallbackSegments,
    };
    const copy = assertValidSkillSpec(spec);
    expect(copy).toEqual(spec);
    expect(copy.writeOrder).not.toBe(writeOrder);
    expect(copy.claudeSegments).not.toBe(claudeSegments);
    expect(copy.fallbackSegments).not.toBe(fallbackSegments);
    expect(Object.isFrozen(copy.writeOrder)).toBe(true);
    expect(Object.isFrozen(copy.claudeSegments)).toBe(true);
    expect(Object.isFrozen(copy.fallbackSegments)).toBe(true);
    writeOrder.push("late.txt");
    expect(copy.writeOrder).toEqual(["data.txt", "step-1.md", "SKILL.md"]);
  });

  it("accepts CUSTOMIZE_SKILL", () => {
    expect(assertValidSkillSpec(CUSTOMIZE_SKILL).name).toBe("customize");
  });

  it("validates the name first, so the message never echoes a raw control character", () => {
    let thrown: unknown;
    try {
      assertValidSkillSpec({ ...DEMO_SPEC, name: "a\nb", writeOrder: [] });
    } catch (error) {
      thrown = error;
    }
    expect(Object.getPrototypeOf(thrown)).toBe(Error.prototype);
    const message = (thrown as Error).message;
    expect(message.startsWith("invalid skill spec")).toBe(true);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("writeOrder");
  });
});

describe("assertValidSkillSpec message escaping", () => {
  // eslint-disable-next-line no-control-regex -- the point is to detect raw control characters
  const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

  function refusal(spec: SkillSpec): string {
    let thrown: unknown;
    try {
      assertValidSkillSpec(spec);
    } catch (error) {
      thrown = error;
    }
    expect(Object.getPrototypeOf(thrown)).toBe(Error.prototype);
    const message = (thrown as Error).message;
    expect(message.startsWith("invalid skill spec")).toBe(true);
    return message;
  }

  const ESCAPED = [
    ["DEL", "\u007f", "\\u007f"],
    ["U+0085", "\u0085", "\\u0085"],
    ["U+009F", "\u009f", "\\u009f"],
  ] as const;

  describe.each(ESCAPED)("%s", (_label, raw, escaped) => {
    it("is escaped in an unsafe writeOrder file name", () => {
      const message = refusal({
        ...DEMO_SPEC,
        writeOrder: [`a/${raw}b`, "SKILL.md"],
      });
      expect(message).not.toMatch(RAW_CONTROL);
      expect(message).toContain(escaped);
    });

    it("is escaped in an unsafe segment", () => {
      const message = refusal({
        ...DEMO_SPEC,
        claudeSegments: [".claude", `x/${raw}y`],
      });
      expect(message).not.toMatch(RAW_CONTROL);
      expect(message).toContain(escaped);
    });

    it("is escaped in a refused name", () => {
      const message = refusal({ ...DEMO_SPEC, name: `a${raw}b` });
      expect(message).not.toMatch(RAW_CONTROL);
      expect(message).toContain(escaped);
    });
  });

  it("leaves no raw plain control character in an unsafe file name, segment or name", () => {
    const messages = [
      refusal({ ...DEMO_SPEC, writeOrder: ["a/\u0001\tb", "SKILL.md"] }),
      refusal({
        ...DEMO_SPEC,
        fallbackSegments: [".groundwork", "x/\u0001\ty"],
      }),
      refusal({ ...DEMO_SPEC, name: "a\u0001\tb" }),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(RAW_CONTROL);
    }
    expect(messages[0]).toContain("\\u0001");
    expect(messages[0]).toContain("\\t");
  });

  it("does not escape a harmless non-ASCII character in a refused value", () => {
    const message = refusal({
      ...DEMO_SPEC,
      writeOrder: ["café/x", "SKILL.md"],
    });
    expect(message).toContain("café/x");
    expect(message).not.toContain("\\u00e9");
  });
});
