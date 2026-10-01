// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Direct unit coverage for `customize-paths.ts`'s `plannedCustomizeSkillPaths`
 * (round-two /customize skill installer review, item F): the project-relative
 * paths either install location (`.claude/skills/customize/` and
 * `.groundwork/customize/`) could write, and confirmation that `main.ts`'s
 * `assertAdoptWriteScope` accepts every one of them while still rejecting a
 * sibling path that only shares a name prefix.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_FILE_NAMES,
  GROUNDWORK_DEST_SEGMENTS,
  plannedCustomizeSkillPaths,
} from "../src/customize-paths.js";
import { assertAdoptWriteScope } from "../src/main.js";

describe("plannedCustomizeSkillPaths", () => {
  it("returns one path per payload name, for both install locations", () => {
    const paths = plannedCustomizeSkillPaths();

    expect(paths).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length * 2);

    const claudePaths = CUSTOMIZE_SKILL_FILE_NAMES.map((name) =>
      join(...CLAUDE_DEST_SEGMENTS, name),
    );
    const groundworkPaths = CUSTOMIZE_SKILL_FILE_NAMES.map((name) =>
      join(...GROUNDWORK_DEST_SEGMENTS, name),
    );

    for (const expectedPath of claudePaths) {
      expect(paths).toContain(expectedPath);
    }
    for (const expectedPath of groundworkPaths) {
      expect(paths).toContain(expectedPath);
    }
  });

  it("includes SKILL.md for both locations", () => {
    const paths = plannedCustomizeSkillPaths();

    expect(paths).toContain(join(...CLAUDE_DEST_SEGMENTS, "SKILL.md"));
    expect(paths).toContain(join(...GROUNDWORK_DEST_SEGMENTS, "SKILL.md"));
  });

  it("names paths under exactly CLAUDE_DEST_SEGMENTS and GROUNDWORK_DEST_SEGMENTS, nothing else", () => {
    const paths = plannedCustomizeSkillPaths();
    const claudePrefix = join(...CLAUDE_DEST_SEGMENTS);
    const groundworkPrefix = join(...GROUNDWORK_DEST_SEGMENTS);

    for (const path of paths) {
      expect(
        path.startsWith(`${claudePrefix}/`) ||
          path.startsWith(`${groundworkPrefix}/`),
      ).toBe(true);
    }
  });
});

describe("assertAdoptWriteScope over plannedCustomizeSkillPaths (main.ts's scope check)", () => {
  const targetDir = "/work/app";

  it("accepts every path plannedCustomizeSkillPaths() names, for both locations", () => {
    expect(() =>
      assertAdoptWriteScope(targetDir, plannedCustomizeSkillPaths()),
    ).not.toThrow();
  });

  it("rejects a sibling path under .claude/skills/ that is not the customize destination", () => {
    const sibling = join(".claude", "skills", "other", "x");

    expect(() => assertAdoptWriteScope(targetDir, [sibling])).toThrow();
  });
});
