// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * What the generic skill installer (`plugin.ts`'s `installSkill` and
 * `installSkillGuarded`) needs to know about one skill: its name, its payload
 * files and their write order, where it installs, and where each file is read
 * from in the plugin source. {@link CUSTOMIZE_SKILL} describes `/customize`
 * from `customize-paths.ts`'s constants. Pure data, no I/O.
 */
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_ENTRY_FILE,
  CUSTOMIZE_SKILL_STEP_FILE_NAMES,
  CUSTOMIZE_SKILL_WRITE_ORDER,
  GROUNDWORK_DEST_SEGMENTS,
} from "./customize-paths.js";
import { UPGRADE_SKILL_FALLBACK_DIR_NAME } from "./upgrade/paths.js";
import { join } from "node:path";

export { plannedSkillPaths } from "./customize-paths.js";

/**
 * One installable skill. Every file name and path segment is a single path
 * component; {@link assertValidSkillSpec} refuses one that is not.
 *
 * @example
 * ```ts
 * import { join } from "node:path";
 * import type { SkillSpec } from "./skill-spec.js";
 *
 * const demo: SkillSpec = {
 *   name: "demo",
 *   entryFile: "SKILL.md",
 *   writeOrder: ["data.txt", "SKILL.md"],
 *   claudeSegments: [".claude", "skills", "demo"],
 *   fallbackSegments: [".groundwork", "demo"],
 *   sourceFile: (sourceDir, fileName) => join(sourceDir, "skills", "demo", fileName),
 * };
 * ```
 */
export interface SkillSpec {
  /** The skill's name, without the leading `/`; error messages call it `/<name>`. */
  readonly name: string;
  /** The file whose presence makes Claude Code load the skill; the last entry of {@link SkillSpec.writeOrder}. */
  readonly entryFile: string;
  /** Every payload file's name, in the order an install writes them, {@link SkillSpec.entryFile} last. */
  readonly writeOrder: readonly string[];
  /** The primary destination, as path segments relative to the project root. */
  readonly claudeSegments: readonly string[];
  /** The adopt-mode fallback destination, as path segments relative to the project root. */
  readonly fallbackSegments: readonly string[];
  /** Where `fileName` is read from inside the plugin source directory `sourceDir`. */
  readonly sourceFile: (sourceDir: string, fileName: string) => string;
}

/** The `/customize` payload files sourced from the plugin's `skills/customize/`; every other one comes from its `src/`. */
const CUSTOMIZE_SKILL_DIR_FILE_NAMES: ReadonlySet<string> = new Set<string>([
  CUSTOMIZE_SKILL_ENTRY_FILE,
  ...CUSTOMIZE_SKILL_STEP_FILE_NAMES,
]);

/**
 * The `/customize` skill: `SKILL.md` and its step files are read from the
 * plugin source's `skills/customize/`, the backing-data files from its
 * `src/`; it installs into `.claude/skills/customize/`, falling back (adopt
 * mode) to `.groundwork/customize/`.
 *
 * @example
 * ```ts
 * import { CUSTOMIZE_SKILL } from "./skill-spec.js";
 *
 * CUSTOMIZE_SKILL.writeOrder.at(-1); // "SKILL.md"
 * ```
 */
export const CUSTOMIZE_SKILL: SkillSpec = {
  name: "customize",
  entryFile: CUSTOMIZE_SKILL_ENTRY_FILE,
  writeOrder: CUSTOMIZE_SKILL_WRITE_ORDER,
  claudeSegments: CLAUDE_DEST_SEGMENTS,
  fallbackSegments: GROUNDWORK_DEST_SEGMENTS,
  sourceFile: (sourceDir, fileName) =>
    CUSTOMIZE_SKILL_DIR_FILE_NAMES.has(fileName)
      ? join(sourceDir, "skills", "customize", fileName)
      : join(sourceDir, "src", fileName),
};

/**
 * The `/upgrade` skill: `SKILL.md` and its step file are read from the
 * plugin source's `skills/upgrade/`; it installs into
 * `.claude/skills/upgrade/`, falling back to `.groundwork/upgrade-skill/`
 * (`upgrade/paths.ts`'s {@link UPGRADE_SKILL_FALLBACK_DIR_NAME}), a sibling
 * of the `.groundwork/upgrade/` staging directory that `--upgrade` replaces
 * wholesale.
 *
 * @example
 * ```ts
 * import { UPGRADE_SKILL } from "./skill-spec.js";
 *
 * UPGRADE_SKILL.fallbackSegments.join("/"); // ".groundwork/upgrade-skill"
 * ```
 */
export const UPGRADE_SKILL: SkillSpec = {
  name: "upgrade",
  entryFile: "SKILL.md",
  writeOrder: ["step-3-conflicts.md", "SKILL.md"],
  claudeSegments: [".claude", "skills", "upgrade"],
  fallbackSegments: [".groundwork", UPGRADE_SKILL_FALLBACK_DIR_NAME],
  sourceFile: (sourceDir, fileName) =>
    join(sourceDir, "skills", "upgrade", fileName),
};

/** Whether `name` is one plain path component: not empty, `.` or `..`, and free of `/` and `\`. */
function isSinglePathComponent(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/** The shape a skill name must have: lowercase letters, digits and `-`, not starting with `-`. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Quotes a caller-supplied value for an error message: `JSON.stringify`
 * escapes the C0 controls, and DEL and the C1 controls (which it leaves raw)
 * are escaped here, so no raw control character reaches a terminal.
 */
function quote(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The key two payload names collide under: NFC-normalised, lowercased, as a case-insensitive filesystem may compare them. */
function collisionKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Whether `inner` equals `outer` or is a leading prefix of it, segment by segment, compared by {@link collisionKey}. */
function isSegmentPrefix(
  inner: readonly string[],
  outer: readonly string[],
): boolean {
  return (
    inner.length <= outer.length &&
    inner.every(
      (segment, i) => collisionKey(segment) === collisionKey(String(outer[i])),
    )
  );
}

/**
 * Refuses a malformed {@link SkillSpec} -- a caller's programming error, not
 * a runtime condition -- before an install reads or writes anything, and
 * returns a frozen copy (fresh frozen arrays) that an install uses from
 * then on, so a caller's later change to its own arrays (even one made from
 * inside `sourceFile`) cannot change what is written. Checked in this order:
 *
 * - `name` must match `^[a-z0-9][a-z0-9-]*$` -- checked first, so no later
 *   message carries an unvalidated name;
 * - `writeOrder` must be non-empty, every file name one plain path
 *   component (not empty, `.` or `..`, free of `/` and `\`), no two names
 *   equal once NFC-normalised and lowercased (they would collide on a
 *   case-insensitive filesystem), and `entryFile` its last entry;
 * - `claudeSegments` and `fallbackSegments` must be non-empty, every segment
 *   one plain path component, neither equal to nor a prefix of the other
 *   (compared the same case-insensitive way), with `claudeSegments` rooted
 *   at `.claude` and `fallbackSegments` at `.groundwork`.
 *
 * Every value a message quotes goes through `JSON.stringify` (plus escaping
 * of DEL and the C1 controls), so a message never carries a raw control
 * character.
 *
 * @throws `Error` (a plain one) starting "invalid skill spec" and naming the
 * defect.
 *
 * @example
 * ```ts
 * import { assertValidSkillSpec, CUSTOMIZE_SKILL } from "./skill-spec.js";
 *
 * const spec = assertValidSkillSpec(CUSTOMIZE_SKILL); // a frozen copy
 * Object.isFrozen(spec.writeOrder); // true
 * ```
 */
export function assertValidSkillSpec(spec: SkillSpec): SkillSpec {
  const name = spec.name;
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid skill spec: name ${quote(name)} must match ${String(SKILL_NAME_PATTERN)}`,
    );
  }
  const refuse = (defect: string): never => {
    throw new Error(`invalid skill spec for /${name}: ${defect}`);
  };
  const copy: SkillSpec = Object.freeze({
    name,
    entryFile: spec.entryFile,
    writeOrder: Object.freeze([...spec.writeOrder]),
    claudeSegments: Object.freeze([...spec.claudeSegments]),
    fallbackSegments: Object.freeze([...spec.fallbackSegments]),
    sourceFile: spec.sourceFile,
  });

  if (copy.writeOrder.length === 0) {
    refuse("writeOrder is empty");
  }
  const seen = new Map<string, string>();
  for (const fileName of copy.writeOrder) {
    if (!isSinglePathComponent(fileName)) {
      refuse(`writeOrder has an unsafe file name ${quote(fileName)}`);
    }
    const earlier = seen.get(collisionKey(fileName));
    if (earlier !== undefined) {
      refuse(
        `writeOrder repeats ${quote(earlier)} as ${quote(fileName)} (names are compared case-insensitively)`,
      );
    }
    seen.set(collisionKey(fileName), fileName);
  }
  if (copy.writeOrder.at(-1) !== copy.entryFile) {
    refuse(`writeOrder must end with its entryFile ${quote(copy.entryFile)}`);
  }

  for (const [field, segments] of [
    ["claudeSegments", copy.claudeSegments],
    ["fallbackSegments", copy.fallbackSegments],
  ] as const) {
    if (segments.length === 0) {
      refuse(`${field} is empty`);
    }
    for (const segment of segments) {
      if (!isSinglePathComponent(segment)) {
        refuse(`${field} has an unsafe segment ${quote(segment)}`);
      }
    }
  }
  if (
    isSegmentPrefix(copy.claudeSegments, copy.fallbackSegments) ||
    isSegmentPrefix(copy.fallbackSegments, copy.claudeSegments)
  ) {
    refuse(
      "fallbackSegments and claudeSegments must be disjoint: neither may equal or contain the other (compared case-insensitively)",
    );
  }
  if (copy.claudeSegments[0] !== ".claude") {
    refuse(
      `claudeSegments must start with ".claude", not ${quote(String(copy.claudeSegments[0]))}`,
    );
  }
  if (copy.fallbackSegments[0] !== ".groundwork") {
    refuse(
      `fallbackSegments must start with ".groundwork", not ${quote(String(copy.fallbackSegments[0]))}`,
    );
  }
  return copy;
}
