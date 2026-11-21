// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Where the `/customize` skill install (`plugin.ts`) writes, owned in one
 * place so `main.ts`'s adopt-mode write-scope check can validate the planned
 * destinations before `plugin.ts` writes anything. Pure data, no I/O.
 */
import { join } from "node:path";
// Type-only: erased at runtime, so this adds no import cycle.
import type { SkillSpec } from "./skill-spec.js";

/**
 * The skill's entry file: it lives under the plugin source's
 * `skills/customize/` beside {@link CUSTOMIZE_SKILL_STEP_FILE_NAMES} (the
 * backing-data files live under its `src/`), and it is the one payload file
 * whose presence makes Claude Code load the skill -- which is why
 * {@link CUSTOMIZE_SKILL_WRITE_ORDER} writes it last.
 *
 * @example
 * ```ts
 * import { CUSTOMIZE_SKILL_ENTRY_FILE } from "./customize-paths.js";
 *
 * CUSTOMIZE_SKILL_ENTRY_FILE; // "SKILL.md"
 * ```
 */
export const CUSTOMIZE_SKILL_ENTRY_FILE = "SKILL.md";

/** The backing-data payload files, all sourced from the plugin's `src/`. */
const CUSTOMIZE_SKILL_DATA_FILE_NAMES = [
  "kind-facet-map.ts",
  "domain-map.ts",
  "pack-map.ts",
  "plugin-map.ts",
] as const;

/**
 * The step files `SKILL.md` delegates to (Step 0's adopt-mode reconcile and
 * Step 3's Round 1), sourced from the plugin's `skills/customize/` beside
 * {@link CUSTOMIZE_SKILL_ENTRY_FILE}. Like the backing-data files, they are
 * written before `SKILL.md`, so a loadable `SKILL.md` never sits beside a
 * missing step file.
 *
 * @example
 * ```ts
 * import { CUSTOMIZE_SKILL_STEP_FILE_NAMES } from "./customize-paths.js";
 *
 * CUSTOMIZE_SKILL_STEP_FILE_NAMES[0]; // "step-0-reconcile.md"
 * ```
 */
export const CUSTOMIZE_SKILL_STEP_FILE_NAMES: readonly [
  "step-0-reconcile.md",
  "step-3-round-1.md",
] = ["step-0-reconcile.md", "step-3-round-1.md"] as const;

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
export const CUSTOMIZE_SKILL_FILE_NAMES: readonly [
  "SKILL.md",
  "kind-facet-map.ts",
  "domain-map.ts",
  "pack-map.ts",
  "plugin-map.ts",
  "step-0-reconcile.md",
  "step-3-round-1.md",
] = [
  CUSTOMIZE_SKILL_ENTRY_FILE,
  ...CUSTOMIZE_SKILL_DATA_FILE_NAMES,
  ...CUSTOMIZE_SKILL_STEP_FILE_NAMES,
] as const;

/**
 * The order an install writes the payload in: every backing-data file, then
 * every step file, {@link CUSTOMIZE_SKILL_ENTRY_FILE} last. A run that fails
 * part-way (and whose rollback cannot remove everything) therefore never
 * leaves a loadable `SKILL.md` beside missing or stale data or step files --
 * given the precondition that no `SKILL.md` already sits at the destination.
 * Wherever an install replaces existing entries -- fresh mode's
 * `.claude/skills/customize/` (a `--force` re-run over an earlier install)
 * and the CLI-owned `.groundwork/customize/` -- `plugin.ts` establishes that
 * precondition by removing any existing `SKILL.md` entry before the first
 * data or step file is rewritten. Adopt mode's additive
 * `.claude/skills/customize/` install only ever writes there when no
 * `SKILL.md` entry exists.
 *
 * @example
 * ```ts
 * import { CUSTOMIZE_SKILL_WRITE_ORDER } from "./customize-paths.js";
 *
 * CUSTOMIZE_SKILL_WRITE_ORDER.at(-1); // "SKILL.md"
 * ```
 */
export const CUSTOMIZE_SKILL_WRITE_ORDER: readonly [
  "kind-facet-map.ts",
  "domain-map.ts",
  "pack-map.ts",
  "plugin-map.ts",
  "step-0-reconcile.md",
  "step-3-round-1.md",
  "SKILL.md",
] = [
  ...CUSTOMIZE_SKILL_DATA_FILE_NAMES,
  ...CUSTOMIZE_SKILL_STEP_FILE_NAMES,
  CUSTOMIZE_SKILL_ENTRY_FILE,
] as const;

/**
 * The fresh-mode destination -- and adopt mode's, when nothing is there yet
 * or an earlier install was interrupted before its `SKILL.md` -- as path
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
 * The adopt-mode fallback destination, as path segments relative to the
 * project root. Used whenever {@link CLAUDE_DEST_SEGMENTS} cannot be written
 * additively: a project-owned entry under any of the skill's payload names
 * that is not this CLI's current copy (a differing file, a symlink, a
 * directory, a `SKILL.md` without its data or step files), or a component of
 * `.claude/skills/customize` that is a symlink or not a directory.
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
 * Every path, relative to the project root, that either of a skill's install
 * locations could write -- `claudeSegments` first, then `fallbackSegments`,
 * each listing the entry file first and then the rest in write order -- so a
 * caller can scope-check them before anything is written. Also re-exported
 * by `skill-spec.ts`; it lives here because `skill-spec.ts` builds
 * `CUSTOMIZE_SKILL` from this module's constants, so this module must not
 * import that one back at runtime.
 *
 * @example
 * ```ts
 * import { CUSTOMIZE_SKILL, plannedSkillPaths } from "./skill-spec.js";
 *
 * plannedSkillPaths(CUSTOMIZE_SKILL);
 * // [".claude/skills/customize/SKILL.md", ..., ".groundwork/customize/step-3-round-1.md"]
 * ```
 */
export function plannedSkillPaths(
  spec: Pick<
    SkillSpec,
    "entryFile" | "writeOrder" | "claudeSegments" | "fallbackSegments"
  >,
): readonly string[] {
  const names = [
    spec.entryFile,
    ...spec.writeOrder.filter((name) => name !== spec.entryFile),
  ];
  return [spec.claudeSegments, spec.fallbackSegments].flatMap((segments) =>
    names.map((name) => join(...segments, name)),
  );
}

/**
 * Every path, relative to the project root, that either `/customize` install
 * location could write -- so a caller can scope-check them before anything
 * is written. {@link plannedSkillPaths} over the `/customize` constants.
 *
 * @example
 * ```ts
 * import { plannedCustomizeSkillPaths } from "./customize-paths.js";
 *
 * plannedCustomizeSkillPaths();
 * // [".claude/skills/customize/SKILL.md", ..., ".groundwork/customize/step-3-round-1.md"]
 * ```
 */
export function plannedCustomizeSkillPaths(): readonly string[] {
  return plannedSkillPaths({
    entryFile: CUSTOMIZE_SKILL_ENTRY_FILE,
    writeOrder: CUSTOMIZE_SKILL_WRITE_ORDER,
    claudeSegments: CLAUDE_DEST_SEGMENTS,
    fallbackSegments: GROUNDWORK_DEST_SEGMENTS,
  });
}
