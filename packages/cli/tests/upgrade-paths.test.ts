// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  assertValidSkillSpec,
  plannedSkillPaths,
  UPGRADE_SKILL,
} from "../src/skill-spec.js";
import {
  UPGRADE_DIR_NAME,
  UPGRADE_SKILL_FALLBACK_DIR_NAME,
  UPGRADE_SKILL_FALLBACK_RELATIVE_DIR,
} from "../src/upgrade/paths.js";

describe("the /upgrade skill's fallback directory constants", () => {
  it("names the directory and its project-relative path", () => {
    expect(UPGRADE_SKILL_FALLBACK_DIR_NAME).toBe("upgrade-skill");
    expect(UPGRADE_SKILL_FALLBACK_RELATIVE_DIR).toBe(
      ".groundwork/upgrade-skill",
    );
  });

  it("is a sibling of the staging directory, never inside it", () => {
    expect(UPGRADE_SKILL_FALLBACK_DIR_NAME).not.toBe(UPGRADE_DIR_NAME);
    expect(
      UPGRADE_SKILL_FALLBACK_RELATIVE_DIR.startsWith(
        `.groundwork/${UPGRADE_DIR_NAME}/`,
      ),
    ).toBe(false);
  });
});

describe("UPGRADE_SKILL", () => {
  it("has the documented shape", () => {
    expect(UPGRADE_SKILL.name).toBe("upgrade");
    expect(UPGRADE_SKILL.entryFile).toBe("SKILL.md");
    expect(UPGRADE_SKILL.writeOrder).toEqual([
      "step-3-conflicts.md",
      "SKILL.md",
    ]);
    expect(UPGRADE_SKILL.claudeSegments).toEqual([
      ".claude",
      "skills",
      "upgrade",
    ]);
    expect(UPGRADE_SKILL.fallbackSegments).toEqual([
      ".groundwork",
      "upgrade-skill",
    ]);
  });

  it("derives its fallback segments from the paths constant", () => {
    expect(UPGRADE_SKILL.fallbackSegments.join("/")).toBe(
      UPGRADE_SKILL_FALLBACK_RELATIVE_DIR,
    );
  });

  it.each(["SKILL.md", "step-3-conflicts.md"])(
    "reads %s from skills/upgrade in the plugin source",
    (fileName) => {
      expect(UPGRADE_SKILL.sourceFile("/p", fileName)).toBe(
        join("/p", "skills", "upgrade", fileName),
      );
    },
  );

  it("passes assertValidSkillSpec unchanged", () => {
    const copy = assertValidSkillSpec(UPGRADE_SKILL);
    expect(copy.name).toBe("upgrade");
    expect(copy.writeOrder).toEqual(UPGRADE_SKILL.writeOrder);
  });

  it("plans exactly four paths, entry file first within each location", () => {
    expect(plannedSkillPaths(UPGRADE_SKILL)).toEqual([
      join(".claude", "skills", "upgrade", "SKILL.md"),
      join(".claude", "skills", "upgrade", "step-3-conflicts.md"),
      join(".groundwork", "upgrade-skill", "SKILL.md"),
      join(".groundwork", "upgrade-skill", "step-3-conflicts.md"),
    ]);
  });
});
