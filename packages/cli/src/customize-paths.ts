// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Where the `/customize` skill install (`plugin.ts`) writes, owned in one
 * place so `main.ts`'s adopt-mode write-scope check can validate the planned
 * destinations before `plugin.ts` writes anything. Pure data, no I/O.
 */
import { join } from "node:path";

/**
 * Every payload file's name inside an installed copy of the skill.
 *
 * @example
 * ```ts
 * import { CUSTOMIZE_SKILL_FILE_NAMES } from "./customize-paths.js";
 *
 * CUSTOMIZE_SKILL_FILE_NAMES.includes("SKILL.md"); // true
 * ```
 */
export const CUSTOMIZE_SKILL_FILE_NAMES = [
  "SKILL.md",
  "kind-facet-map.ts",
  "domain-map.ts",
  "pack-map.ts",
  "plugin-map.ts",
] as const;

/**
 * The fresh-mode (and adopt-mode, when absent) destination, as path
 * segments relative to the project root.
 *
 * @example
 * ```ts
 * import { join } from "node:path";
 * import { CLAUDE_DEST_SEGMENTS } from "./customize-paths.js";
 *
 * join(...CLAUDE_DEST_SEGMENTS); // ".claude/skills/customize"
 * ```
 */
export const CLAUDE_DEST_SEGMENTS = [".claude", "skills", "customize"] as const;

/**
 * The adopt-mode fallback destination, used when the project already has its
 * own differing skill, as path segments relative to the project root.
 *
 * @example
 * ```ts
 * import { join } from "node:path";
 * import { GROUNDWORK_DEST_SEGMENTS } from "./customize-paths.js";
 *
 * join(...GROUNDWORK_DEST_SEGMENTS); // ".groundwork/customize"
 * ```
 */
export const GROUNDWORK_DEST_SEGMENTS = [".groundwork", "customize"] as const;

/**
 * Every path, relative to the project root, that either install location
 * could write -- so a caller can scope-check them before anything is
 * written.
 *
 * @example
 * ```ts
 * import { plannedCustomizeSkillPaths } from "./customize-paths.js";
 *
 * plannedCustomizeSkillPaths();
 * // [".claude/skills/customize/SKILL.md", ..., ".groundwork/customize/plugin-map.ts"]
 * ```
 */
export function plannedCustomizeSkillPaths(): readonly string[] {
  return [CLAUDE_DEST_SEGMENTS, GROUNDWORK_DEST_SEGMENTS].flatMap((segments) =>
    CUSTOMIZE_SKILL_FILE_NAMES.map((name) => join(...segments, name)),
  );
}
