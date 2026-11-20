// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's classifier: a pure function from a path's recorded
 * manifest entry, its current hash in the project and its hash in the new
 * release to one {@link UpgradeClass}. No I/O, no clock, no randomness.
 */
import type { Manifest } from "../manifest.js";

/**
 * What the upgrade plan does with one baseline path. Each class is the
 * outcome of one or more rows of the decision table in
 * `.claude/rules/upgrade-mode.md`:
 *
 * - `current`: the file exists and already matches the new release; stamp
 *   re-hashes it (rows 3 and 6).
 * - `add`: new in the release and absent from the project (row 2).
 * - `conflict-2way`: no usable 3-way base, so the project file and the new
 *   release are compared directly (rows 4 and 7).
 * - `user-deleted`: the user deleted a file the release still ships (row 5).
 * - `local-only`: the user edited a file the release did not change (row 8).
 * - `safe-update`: an untouched `emitted` file the release changed (row 9).
 * - `conflict-3way`: user and release both changed an `emitted` file
 *   (row 10).
 * - `gone`: recorded but absent from both the new release and the project;
 *   stamp must drop its manifest entry, so it does not reappear on every later
 *   upgrade (row 11).
 * - `orphan-edited`: dropped by the release but merged or edited in the
 *   project (rows 12 and 14).
 * - `remove`: dropped by the release and untouched in the project (row 13).
 *
 * @example
 * ```ts
 * import type { UpgradeClass } from "./upgrade/classify.js";
 *
 * const needsDecision = (c: UpgradeClass): boolean =>
 *   c === "conflict-2way" || c === "conflict-3way";
 * ```
 */
export type UpgradeClass =
  | "current"
  | "local-only"
  | "safe-update"
  | "conflict-3way"
  | "add"
  | "conflict-2way"
  | "user-deleted"
  | "remove"
  | "orphan-edited"
  | "gone";

/**
 * One file's manifest record: the sha256 recorded at the last stamp and
 * whether it was `emitted` by the CLI or `merged` by hand. The same shape as
 * a `Manifest["files"]` entry, read-only.
 *
 * @example
 * ```ts
 * import type { Recorded } from "./upgrade/classify.js";
 *
 * const entry: Recorded = { sha256: "0".repeat(64), origin: "emitted" };
 * ```
 */
export type Recorded = Readonly<Manifest["files"][string]>;

/**
 * The three hashes {@link classifyPath} compares for one path. `undefined`
 * means absent: no manifest record, no file in the project, or no file in
 * the new release.
 *
 * @example
 * ```ts
 * import type { ClassifyInput } from "./upgrade/classify.js";
 *
 * const input: ClassifyInput = {
 *   recorded: undefined,
 *   current: undefined,
 *   next: "0".repeat(64),
 * };
 * ```
 */
export interface ClassifyInput {
  readonly recorded: Recorded | undefined;
  readonly current: string | undefined;
  readonly next: string | undefined;
}

/**
 * Classifies one path by the 14-row decision table in
 * `.claude/rules/upgrade-mode.md` (`M` recorded, `C` current, `N` next). The
 * rows are tested in order and the first match wins. `safe-update` and
 * `remove` are therefore only returned for an `emitted` file whose current
 * hash still equals its recorded hash.
 *
 * @param input - The recorded entry and the current and next hashes.
 * @returns The path's class.
 * @throws Error When both `recorded` and `next` are absent (row 1): such a
 * path is the project's own file, never a baseline path, and a caller passing
 * one is a bug.
 *
 * @example
 * ```ts
 * import { classifyPath } from "./upgrade/classify.js";
 *
 * classifyPath({
 *   recorded: { sha256: "a".repeat(64), origin: "emitted" },
 *   current: "a".repeat(64),
 *   next: "b".repeat(64),
 * }); // "safe-update"
 * ```
 */
export function classifyPath(input: ClassifyInput): UpgradeClass {
  const { recorded, current, next } = input;
  if (recorded === undefined) {
    // Row 1.
    if (next === undefined) {
      throw new Error(
        "cannot classify a path whose recorded entry and next release file are both absent",
      );
    }
    if (current === undefined) return "add"; // Row 2.
    return current === next ? "current" : "conflict-2way"; // Rows 3, 4.
  }
  if (next !== undefined) {
    if (current === undefined) return "user-deleted"; // Row 5.
    if (current === next) return "current"; // Row 6.
    if (recorded.origin === "merged") return "conflict-2way"; // Row 7.
    if (next === recorded.sha256) return "local-only"; // Row 8.
    if (current === recorded.sha256) return "safe-update"; // Row 9.
    return "conflict-3way"; // Row 10.
  }
  if (current === undefined) return "gone"; // Row 11.
  if (recorded.origin === "merged") return "orphan-edited"; // Row 12.
  return current === recorded.sha256 ? "remove" : "orphan-edited"; // Rows 13, 14.
}

/**
 * One classified path in {@link classifyAll}'s result.
 *
 * @example
 * ```ts
 * import type { UpgradeEntry } from "./upgrade/classify.js";
 *
 * const entry: UpgradeEntry = { path: "CLAUDE.md", class: "safe-update" };
 * ```
 */
export interface UpgradeEntry {
  readonly path: string;
  readonly class: UpgradeClass;
}

/**
 * Classifies every path in the union of `recorded` and `next` keys, once
 * each. A path only in `current` (the project's own file) is never listed.
 * Lookups go through the maps, so a path named `__proto__` or `constructor`
 * is an ordinary key. The result is sorted by code-unit order, not locale,
 * and the inputs are not mutated.
 *
 * @param maps - The manifest records, current hashes and next hashes, keyed
 * by project-relative path.
 * @returns One entry per path, sorted by path.
 *
 * @example
 * ```ts
 * import { classifyAll } from "./upgrade/classify.js";
 *
 * classifyAll({
 *   recorded: new Map(),
 *   current: new Map(),
 *   next: new Map([["CLAUDE.md", "a".repeat(64)]]),
 * }); // [{ path: "CLAUDE.md", class: "add" }]
 * ```
 */
export function classifyAll(maps: {
  readonly recorded: ReadonlyMap<string, Recorded>;
  readonly current: ReadonlyMap<string, string>;
  readonly next: ReadonlyMap<string, string>;
}): UpgradeEntry[] {
  // The Set makes every path distinct, so the comparator never sees a tie.
  const paths = [
    ...new Set([...maps.recorded.keys(), ...maps.next.keys()]),
  ].sort((a, b) => (a < b ? -1 : 1));
  return paths.map((path) => ({
    path,
    class: classifyPath({
      recorded: maps.recorded.get(path),
      current: maps.current.get(path),
      next: maps.next.get(path),
    }),
  }));
}
