// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's classifier: a pure function from a path's recorded
 * manifest entry, its current hash in the project and its hash in the new
 * release to one {@link UpgradeClass}. No I/O, no clock, no randomness.
 */
import type { Manifest } from "../manifest.js";

/**
 * What the upgrade plan does with one baseline path. `current` needs no
 * change; `add`, `safe-update` and `remove` are applied (or proposed) without
 * asking; `conflict-2way` and `conflict-3way` need a per-file decision;
 * `local-only`, `user-deleted` and `orphan-edited` are reported and left alone.
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
  | "orphan-edited";

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
 * Classifies one path. The rules are read in order and the first match wins
 * (`M` recorded, `C` current, `N` next):
 *
 * 1. no `M` and no `N`: not a baseline path, throws;
 * 2. no `M`: `add` when `C` is absent, `current` when `C == N`, otherwise
 *    `conflict-2way`;
 * 3. `M` and `N`: `user-deleted` when `C` is absent, `current` when `C == N`,
 *    `conflict-2way` for a `merged` origin, `local-only` when `N == M`,
 *    `safe-update` when `C == M`, otherwise `conflict-3way`;
 * 4. `M`, no `N`: `current` when `C` is absent, `orphan-edited` for a
 *    `merged` origin, `remove` when `C == M`, otherwise `orphan-edited`.
 *
 * `safe-update` and `remove` are therefore only returned for an `emitted`
 * file whose current hash still equals its recorded hash.
 *
 * @param input - The recorded entry and the current and next hashes.
 * @returns The path's class.
 * @throws Error When both `recorded` and `next` are absent: such a path is
 * the project's own file, never a baseline path, and a caller passing one is
 * a bug.
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
    if (next === undefined) {
      throw new Error(
        "cannot classify a path whose recorded entry and next release file are both absent",
      );
    }
    if (current === undefined) return "add";
    return current === next ? "current" : "conflict-2way";
  }
  if (next !== undefined) {
    if (current === undefined) return "user-deleted";
    if (current === next) return "current";
    if (recorded.origin === "merged") return "conflict-2way";
    if (next === recorded.sha256) return "local-only";
    if (current === recorded.sha256) return "safe-update";
    return "conflict-3way";
  }
  if (current === undefined) return "current";
  if (recorded.origin === "merged") return "orphan-edited";
  return current === recorded.sha256 ? "remove" : "orphan-edited";
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
