// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pure `--adopt --apply` planner (`.claude/rules/headless-mode.md`):
 * {@link planAdoptActions} turns a parsed inventory, a validated complete
 * adopt answers document and a hash-only I/O seam into the list of actions
 * an apply step would carry out, plus the handoff entries the skill's
 * headless branch takes over. It writes nothing and reads no file itself:
 * the only I/O is {@link PlanIo.sha256OfTarget}, called once per item whose
 * write must be bound to the tree's current state, and only once the answers
 * have passed every usage check.
 *
 * Bytes to install come only from `inventory.stagedBaseline` (an `add`) and
 * `inventory.stagedDivergent` (a `take` or `merge-keys`), never from the
 * template. Usage errors (exit 2) are collected in full before any target is
 * hashed; drift (exit 4) is then collected for every item, in path order.
 */
import type { FileConflict } from "../conflicts.js";
import type { Inventory, StagedBaseline } from "../inventory.js";
import { foldPath, isGitSegment, type AnswersV1 } from "./contract.js";

/**
 * What is at a target-relative path, as far as binding a write needs to
 * know: nothing (`absent`, only for `ENOENT`), a regular file with its
 * lowercase hex sha256 (`file`), or anything else (`unreadable`: a
 * directory, a symlink, a permission error), with the error code or a
 * descriptive one such as `ENOTFILE`.
 *
 * @example
 * ```ts
 * import type { TargetState } from "./headless/actions.js";
 *
 * const describe = (state: TargetState): string =>
 *   state.kind === "file" ? state.sha256 : state.kind;
 * ```
 */
export type TargetState =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly sha256: string }
  | { readonly kind: "unreadable"; readonly code: string };

/**
 * The hash-only view of the target the planner needs: the
 * {@link TargetState} at a target-relative path. It may throw; the planner
 * does not catch it, so the caller wraps the planner call.
 *
 * @example
 * ```ts
 * import type { PlanIo } from "./headless/actions.js";
 *
 * const io: PlanIo = { sha256OfTarget: () => ({ kind: "absent" }) }; // an empty target
 * ```
 */
export interface PlanIo {
  readonly sha256OfTarget: (path: string) => TargetState;
}

/**
 * One planned step, keyed by its target-relative `path`. `install-staged`
 * (an `add`), `take-divergent` (a `take`) and `merge-keys` carry the staged
 * copy to read (`stagedPath`, project-relative) and the sha256 the inventory
 * recorded for its bytes; `merge-keys` adds the top-level keys to take from
 * it. `keep`, `skip` and `delegate` write nothing. Not exported until the
 * apply step consumes it by name (knip flags an export nothing imports);
 * `AdoptPlanResult["actions"]` reaches it meanwhile.
 */
type AdoptAction =
  | {
      readonly kind: "install-staged" | "take-divergent";
      readonly path: string;
      readonly stagedPath: string;
      readonly sha256: string;
    }
  | {
      readonly kind: "merge-keys";
      readonly path: string;
      readonly stagedPath: string;
      readonly sha256: string;
      readonly takeKeys: readonly string[];
    }
  | {
      readonly kind: "keep" | "skip" | "delegate";
      readonly path: string;
    };

/** Work the skill's headless branch takes over: a delegated conflict, or the owner's `missedNotes`. */
type AdoptHandoff =
  | { readonly kind: "delegate"; readonly path: string }
  | { readonly kind: "missed-notes"; readonly notes: string };

/** One answers problem: the JSON pointer it sits at and what is wrong. */
interface PlanUsageError {
  readonly pointer: string;
  readonly reason: string;
}

/** A target whose state no longer matches the survey; `actual` is `null` unless a regular file is there. */
interface PlanDrift {
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
}

/**
 * What {@link planAdoptActions} returns: the actions (sorted by path in code
 * point order) and handoff entries, or every usage error (exit 2), or, when
 * the answers are usable, every drifted target (exit 4).
 *
 * @example
 * ```ts
 * import type { AdoptPlanResult } from "./headless/actions.js";
 *
 * const exitCode = (result: AdoptPlanResult): number =>
 *   result.ok ? 0 : result.kind === "usage" ? 2 : 4;
 * ```
 */
export type AdoptPlanResult =
  | {
      readonly ok: true;
      readonly actions: readonly AdoptAction[];
      readonly handoff: readonly AdoptHandoff[];
    }
  | {
      readonly ok: false;
      readonly kind: "usage";
      readonly errors: readonly PlanUsageError[];
    }
  | {
      readonly ok: false;
      readonly kind: "drift";
      readonly drift: readonly PlanDrift[];
    };

/** A planned action, with the target hash the survey recorded (meaningful only for a write bound to it). */
interface Bound {
  readonly action: AdoptAction;
  readonly expected: string | null;
}

/** The inventory fields older schema versions lack, read as optional so a legacy inventory never throws. */
type VersionedFields = Partial<
  Pick<Inventory, "packs" | "stagedBaseline" | "stagedDivergent">
>;

/** The staged copies under `key`, or `undefined` when the inventory predates them (`minVersion`) or lacks them. */
function stagedOf(
  inventory: Pick<Inventory, "schemaVersion"> & VersionedFields,
  key: "stagedBaseline" | "stagedDivergent",
  minVersion: number,
): StagedBaseline | undefined {
  return inventory.schemaVersion < minVersion ? undefined : inventory[key];
}

/** The usage error for an inventory too old to carry the staged copies under `key`. */
function legacyStagedError(
  inventory: Inventory,
  key: "stagedBaseline" | "stagedDivergent",
  minVersion: number,
  path: string,
  pointer: string,
): PlanUsageError {
  return {
    pointer,
    reason: `${path} needs inventory.${key}, which inventory schemaVersion ${String(inventory.schemaVersion)} does not carry (needs ${String(minVersion)}); re-run the adopt survey`,
  };
}

/** Whether `action` writes, so its write must be bound to the target's current state. */
function writes(action: AdoptAction): boolean {
  switch (action.kind) {
    case "install-staged":
    case "take-divergent":
    case "merge-keys":
      return true;
    case "keep":
    case "skip":
    case "delegate":
      return false;
    default: {
      const unreachable: never = action;
      throw new Error(`unhandled action ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The drift entry for a bound write over `state`, or `undefined` when the write may proceed. */
function driftOf(
  { action, expected }: Bound,
  state: TargetState,
): PlanDrift | undefined {
  const actual = state.kind === "file" ? state.sha256 : null;
  // An add expects nothing there. A take or merge expects a regular file with
  // the surveyed hash; a null expected hash means the survey could not read
  // it, so the drift is undetermined and never "unchanged".
  const ok =
    action.kind === "install-staged"
      ? state.kind === "absent"
      : expected !== null && state.kind === "file" && actual === expected;
  return ok ? undefined : { path: action.path, expected, actual };
}

/** Orders strings by Unicode code point (not UTF-16 code unit), so the order is the same in any language. */
function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff =
      (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** The project-relative staged copy for `path` in `staged`, or `undefined` when none was staged. */
function stagedEntry(
  staged: StagedBaseline,
  path: string,
): { readonly stagedPath: string; readonly sha256: string } | undefined {
  const file = staged.files.find((entry) => entry.path === path);
  return file === undefined
    ? undefined
    : { stagedPath: `${staged.dir}/${file.staged}`, sha256: file.sha256 };
}

/** The usage errors a path earns wherever it appears: a `.git` segment at any depth. */
function gitSegmentError(
  path: string,
  pointer: string,
): PlanUsageError | undefined {
  return path.split("/").some((segment) => isGitSegment(segment))
    ? {
        pointer,
        reason: `${path} has a .git segment (ignoring case, or its 8.3 short name git~1); apply never writes inside a repository's git directory`,
      }
    : undefined;
}

/** Errors for a path answered in both collections, or colliding with a file of an installed pack. */
function collisionErrors(
  inventory: Inventory,
  answers: AnswersV1,
  adopt: NonNullable<AnswersV1["adopt"]>,
): PlanUsageError[] {
  const errors: PlanUsageError[] = [];
  const additionAt = new Map<string, number>();
  adopt.additions.forEach((addition, index) => {
    additionAt.set(foldPath(addition.path), index);
  });
  adopt.conflicts.forEach((conflict, index) => {
    const other = additionAt.get(foldPath(conflict.path));
    if (other !== undefined) {
      errors.push({
        pointer: `/adopt/conflicts/${String(index)}`,
        reason: `${conflict.path} is also answered at /adopt/additions/${String(other)} (ignoring case and Unicode normalization); a path may be decided only once`,
      });
    }
  });
  const packFiles = new Map<string, string>();
  const fields: VersionedFields = inventory;
  const surveyed = fields.packs;
  answers.packs.install.forEach((name, index) => {
    const pointer = `/packs/install/${String(index)}`;
    const pack = surveyed?.find((survey) => survey.name === name);
    if (pack === undefined) {
      errors.push({
        pointer,
        reason: `pack ${name} was not surveyed: inventory.packs does not list it`,
      });
      return;
    }
    for (const file of pack.fileConflicts) {
      const key = foldPath(file.relPath);
      const owner = `${file.relPath} of pack ${name} (${pointer})`;
      const other = packFiles.get(key);
      if (other === undefined) packFiles.set(key, owner);
      else {
        errors.push({
          pointer,
          reason: `${owner} collides with ${other} (ignoring case and Unicode normalization); two installed packs may not ship the same path`,
        });
      }
    }
  });
  const answered = [
    ...adopt.additions.map((a, i) => ({
      path: a.path,
      at: `additions/${String(i)}`,
    })),
    ...adopt.conflicts.map((c, i) => ({
      path: c.path,
      at: `conflicts/${String(i)}`,
    })),
  ];
  for (const { path, at } of answered) {
    const owner = packFiles.get(foldPath(path));
    if (owner !== undefined) {
      errors.push({
        pointer: `/adopt/${at}`,
        reason: `${path} collides with ${owner} (ignoring case and Unicode normalization)`,
      });
    }
  }
  return errors;
}

/** Plans one addition, or returns the usage error it earns. */
function planAddition(
  inventory: Inventory,
  absent: ReadonlyMap<string, FileConflict>,
  addition: NonNullable<AnswersV1["adopt"]>["additions"][number],
  pointer: string,
): Bound | PlanUsageError {
  const { path, action } = addition;
  const gitError = gitSegmentError(path, pointer);
  if (gitError !== undefined) return gitError;
  if (!absent.has(path)) {
    return {
      pointer,
      reason: `${path} is not a baseline file the inventory lists as absent`,
    };
  }
  switch (action) {
    case "skip":
      return { action: { kind: "skip", path }, expected: null };
    case "add": {
      const stagedBaseline = stagedOf(inventory, "stagedBaseline", 5);
      if (stagedBaseline === undefined) {
        return legacyStagedError(inventory, "stagedBaseline", 5, path, pointer);
      }
      const staged = stagedEntry(stagedBaseline, path);
      if (staged === undefined) {
        return {
          pointer,
          reason: `${path} has no staged copy in inventory.stagedBaseline to install`,
        };
      }
      return {
        action: { kind: "install-staged", path, ...staged },
        expected: null,
      };
    }
    case null:
      return { pointer: `${pointer}/action`, reason: "must be decided" };
    default: {
      const unreachable: never = action;
      return { pointer, reason: `unknown action ${String(unreachable)}` };
    }
  }
}

/** The usage error for `merge-keys` on `conflict`, or `undefined` when its keys are ones the survey found different. */
function mergeKeysError(
  conflict: FileConflict,
  takeKeys: readonly string[] | undefined,
  pointer: string,
): PlanUsageError | undefined {
  const differing = conflict.keyDiffs ?? [];
  if (differing.length === 0) {
    return {
      pointer: `${pointer}/resolution`,
      reason: `${conflict.relPath} differs as a whole file, not by top-level key, so merge-keys does not apply`,
    };
  }
  if (takeKeys === undefined || takeKeys.length === 0) {
    return {
      pointer: `${pointer}/takeKeys`,
      reason: "must name at least one key to take with merge-keys",
    };
  }
  const unknown = takeKeys.filter((key) => !differing.includes(key));
  return unknown.length === 0
    ? undefined
    : {
        pointer: `${pointer}/takeKeys`,
        reason: `${unknown.join(", ")} not among the keys the survey found different (${differing.join(", ")})`,
      };
}

/** Plans one conflict answer, or returns the usage error it earns. */
function planConflict(
  inventory: Inventory,
  divergent: ReadonlyMap<string, FileConflict>,
  answer: NonNullable<AnswersV1["adopt"]>["conflicts"][number],
  pointer: string,
): Bound | PlanUsageError {
  const { path, resolution } = answer;
  const gitError = gitSegmentError(path, pointer);
  if (gitError !== undefined) return gitError;
  const conflict = divergent.get(path);
  if (conflict === undefined) {
    return {
      pointer,
      reason: `${path} is not a baseline file the inventory lists as divergent`,
    };
  }
  switch (resolution) {
    case "keep":
    case "delegate":
      return { action: { kind: resolution, path }, expected: null };
    case "take":
    case "merge-keys": {
      if (resolution === "merge-keys") {
        const error = mergeKeysError(conflict, answer.takeKeys, pointer);
        if (error !== undefined) return error;
      }
      const stagedDivergent = stagedOf(inventory, "stagedDivergent", 7);
      if (stagedDivergent === undefined) {
        return legacyStagedError(
          inventory,
          "stagedDivergent",
          7,
          path,
          pointer,
        );
      }
      const staged = stagedEntry(stagedDivergent, path);
      if (staged === undefined) {
        return {
          pointer,
          reason: `${path} has no staged copy in inventory.stagedDivergent to take from`,
        };
      }
      const action: AdoptAction =
        resolution === "take"
          ? { kind: "take-divergent", path, ...staged }
          : {
              kind: "merge-keys",
              path,
              ...staged,
              takeKeys: [...(answer.takeKeys ?? [])],
            };
      return { action, expected: conflict.targetSha256 };
    }
    case null:
      return { pointer: `${pointer}/resolution`, reason: "must be decided" };
    default: {
      const unreachable: never = resolution;
      return { pointer, reason: `unknown resolution ${String(unreachable)}` };
    }
  }
}

/** Whether a {@link planAddition}/{@link planConflict} outcome is a usage error. */
function isUsageError(
  outcome: Bound | PlanUsageError,
): outcome is PlanUsageError {
  return "reason" in outcome;
}

/** A usage error for every answer whose exact path an earlier answer in the same collection already decided. */
function duplicateErrors(
  paths: readonly string[],
  collection: "additions" | "conflicts",
): PlanUsageError[] {
  const firstAt = new Map<string, number>();
  const errors: PlanUsageError[] = [];
  paths.forEach((path, index) => {
    const first = firstAt.get(path);
    if (first === undefined) firstAt.set(path, index);
    else {
      errors.push({
        pointer: `/adopt/${collection}/${String(index)}`,
        reason: `${path} is also answered at /adopt/${collection}/${String(first)}; a path may be decided only once`,
      });
    }
  });
  return errors;
}

/** A usage error for every inventory path of `status` the answers never decide. */
function undecidedErrors(
  conflicts: ReadonlyMap<string, FileConflict>,
  answered: ReadonlySet<string>,
  pointer: string,
): PlanUsageError[] {
  return [...conflicts.keys()]
    .filter((path) => !answered.has(path))
    .map((path) => ({
      pointer,
      reason: `undecided path ${path}: the inventory lists it, but the answers never decide it`,
    }));
}

/** The inventory conflicts of one status, keyed by exact path. */
function conflictsOf(
  inventory: Inventory,
  status: FileConflict["status"],
): ReadonlyMap<string, FileConflict> {
  return new Map(
    inventory.conflicts
      .filter((conflict) => conflict.status === status)
      .map((conflict) => [conflict.relPath, conflict]),
  );
}

/**
 * Plans an `--adopt --apply` run from a parsed `inventory` (schema 7), the
 * `answers` {@link validateAnswers} accepted under the `complete` profile and
 * a hash-only `io` seam. Pure: it mutates neither input, writes nothing and
 * calls `io.sha256OfTarget` only for an `add`, `take` or `merge-keys`, and
 * only once every usage check has passed.
 *
 * Never throws on a validated `answers` document, even for an inventory from
 * an older schema version; only `io` may throw. A usage error (exit 2),
 * every one collected, is: an answers document whose `mode` is not `adopt`
 * (at `/mode`); a pack in `packs.install` the inventory did not survey, or
 * two installed packs shipping the same path; an exact path answered twice
 * in `additions` or in `conflicts`; an addition for a path the inventory does not list as
 * absent, or a conflict answer for one it does not list as divergent; an
 * absent or divergent inventory path the answers never decide; an `add`
 * without a `stagedBaseline` copy, or a `take`/`merge-keys` without a
 * `stagedDivergent` copy (including an inventory older than schema 7); `merge-keys` on a whole-file difference, or with a
 * key the survey did not find different; a path with a `.git` segment at any
 * depth (folded, or `git~1`); and a path answered in both `additions` and
 * `conflicts`, or colliding with a file of an installed pack, compared after
 * {@link foldPath}. Drift (exit 4), one entry per item in path order, is an
 * added path that is no longer `absent`, or a taken or merged path that is
 * not a regular file with the survey's `targetSha256`, which is always the
 * case when that hash was `null` (the survey could not read the file).
 *
 * @example
 * ```ts
 * import { createHash } from "node:crypto";
 * import { lstatSync, readFileSync } from "node:fs";
 * import { join } from "node:path";
 * import { planAdoptActions, type TargetState } from "./headless/actions.js";
 * import type { AnswersV1 } from "./headless/contract.js";
 * import type { Inventory } from "./inventory.js";
 *
 * declare const target: string;
 * declare const inventory: Inventory;
 * declare const answers: AnswersV1;
 * const stateOf = (path: string): TargetState => {
 *   const full = join(target, path);
 *   try {
 *     // lstat, not stat: a symlink is never followed, and is unreadable.
 *     if (!lstatSync(full).isFile()) return { kind: "unreadable", code: "ENOTFILE" };
 *     const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
 *     return { kind: "file", sha256 };
 *   } catch (error) {
 *     const code =
 *       error instanceof Error && "code" in error && typeof error.code === "string"
 *         ? error.code
 *         : "EUNKNOWN";
 *     // Only ENOENT means nothing is there; any other error is unreadable.
 *     return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", code };
 *   }
 * };
 * const result = planAdoptActions(inventory, answers, { sha256OfTarget: stateOf });
 * if (!result.ok) process.exitCode = result.kind === "usage" ? 2 : 4;
 * ```
 */
export function planAdoptActions(
  inventory: Inventory,
  answers: AnswersV1,
  io: PlanIo,
): AdoptPlanResult {
  const { adopt } = answers;
  if (answers.mode !== "adopt" || adopt === null) {
    return {
      ok: false,
      kind: "usage",
      errors: [
        {
          pointer: answers.mode === "adopt" ? "/adopt" : "/mode",
          reason: "must be an adopt answers document",
        },
      ],
    };
  }
  const absent = conflictsOf(inventory, "absent");
  const divergent = conflictsOf(inventory, "divergent");
  const errors: PlanUsageError[] = [];
  const bound: Bound[] = [];
  const record = (outcome: Bound | PlanUsageError): void => {
    if (isUsageError(outcome)) errors.push(outcome);
    else bound.push(outcome);
  };
  adopt.additions.forEach((addition, index) => {
    record(
      planAddition(
        inventory,
        absent,
        addition,
        `/adopt/additions/${String(index)}`,
      ),
    );
  });
  adopt.conflicts.forEach((answer, index) => {
    record(
      planConflict(
        inventory,
        divergent,
        answer,
        `/adopt/conflicts/${String(index)}`,
      ),
    );
  });
  errors.push(
    ...undecidedErrors(
      absent,
      new Set(adopt.additions.map((a) => a.path)),
      "/adopt/additions",
    ),
    ...undecidedErrors(
      divergent,
      new Set(adopt.conflicts.map((c) => c.path)),
      "/adopt/conflicts",
    ),
    ...duplicateErrors(
      adopt.additions.map((a) => a.path),
      "additions",
    ),
    ...duplicateErrors(
      adopt.conflicts.map((c) => c.path),
      "conflicts",
    ),
    ...collisionErrors(inventory, answers, adopt),
  );
  if (errors.length > 0) return { ok: false, kind: "usage", errors };

  bound.sort((a, b) => compareCodePoints(a.action.path, b.action.path));
  const drift: PlanDrift[] = [];
  for (const item of bound) {
    if (!writes(item.action)) continue;
    const entry = driftOf(item, io.sha256OfTarget(item.action.path));
    if (entry !== undefined) drift.push(entry);
  }
  if (drift.length > 0) return { ok: false, kind: "drift", drift };

  const handoff: AdoptHandoff[] = bound
    .filter(({ action }) => action.kind === "delegate")
    .map(({ action }) => ({ kind: "delegate", path: action.path }));
  if (adopt.missedNotes !== "") {
    handoff.push({ kind: "missed-notes", notes: adopt.missedNotes });
  }
  return { ok: true, actions: bound.map(({ action }) => action), handoff };
}
