// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's plan step, its writes: {@link stageUpgrade} writes the
 * plan, its report and the new release's copy of every file the plan would
 * change into `.groundwork/upgrade/`, as one unit swapped in by rename
 * (`stageAtomically` in `staging.ts`), and {@link inspectPreviousUpgrade}
 * checks what a previous run left there first. The names under the
 * directory come from `paths.ts`. This module never imports `main.ts`.
 */
import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isProjectRelativePath, sha256Hex } from "../manifest.js";
import {
  prepareStaging,
  stageAtomically,
  stagedNameFor,
  writeStagedBytes,
} from "../staging.js";
import type { StagingTarget } from "../staging.js";
import type { UpgradeClass } from "./classify.js";
import {
  UPGRADE_DIR_NAME,
  UPGRADE_PLAN_FILE,
  UPGRADE_RELATIVE_DIR,
  UPGRADE_REPORT_FILE,
  UPGRADE_STAGED_DIR_NAME,
} from "./paths.js";
import type { RenderedRelease, UpgradePlan } from "./plan.js";
import { renderUpgradeReport } from "./report.js";

const CALLER = "stageUpgrade";

/** The entries a staging writes; anything else found there is foreign. */
const OWN_ENTRIES: ReadonlySet<string> = new Set([
  UPGRADE_PLAN_FILE,
  UPGRADE_REPORT_FILE,
  UPGRADE_STAGED_DIR_NAME,
]);

/**
 * One file staged by {@link stageUpgrade}: its project-relative `path`, its
 * `staged` name relative to `.groundwork/upgrade/`
 * (`staged/<path>.staged`) and the sha256 of the staged bytes, which is the
 * plan entry's `nextSha256`. Reached by consumers as
 * `StagedUpgrade["staged"][number]`.
 */
interface StagedUpgradeFile {
  readonly path: string;
  readonly staged: string;
  readonly sha256: string;
}

/**
 * What {@link stageUpgrade} wrote: the absolute `.groundwork/upgrade/`
 * directory and the staged files, sorted by path.
 *
 * @example
 * ```ts
 * import type { StagedUpgrade } from "./upgrade/stage.js";
 *
 * const count = (result: StagedUpgrade): number => result.staged.length;
 * ```
 */
export interface StagedUpgrade {
  readonly dir: string;
  readonly staged: readonly StagedUpgradeFile[];
}

/**
 * Whether the new release's copy of a file of each class is staged: the
 * classes an apply step would write the new copy for. A table keyed by every
 * class, so a new class is a compile error until it is placed.
 */
const STAGED_CLASSES: Readonly<Record<UpgradeClass, boolean>> = {
  add: true,
  "safe-update": true,
  "conflict-2way": true,
  "conflict-3way": true,
  current: false,
  "local-only": false,
  "user-deleted": false,
  remove: false,
  "orphan-edited": false,
  gone: false,
};

/** A staged file's bytes, read from the release and verified, not yet written. */
interface VerifiedFile extends StagedUpgradeFile {
  readonly bytes: Buffer;
}

/**
 * Reads `path` from the rendered release and checks its bytes against the
 * plan's `nextSha256`. `computePlan` already refused any path that is not
 * relative and inside the project, so one here is a caller defect: an
 * `AssertionError`.
 */
function readVerified(
  releaseDir: string,
  path: string,
  nextSha256: string | undefined,
): VerifiedFile {
  assert.ok(
    isProjectRelativePath(path),
    `${CALLER}: refusing to stage ${JSON.stringify(path)}: not a relative, /-separated path inside the project`,
  );
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(releaseDir, path));
  } catch (cause) {
    throw new Error(
      `could not read ${path} from the rendered release in ${releaseDir}, so nothing was staged -- re-run --upgrade`,
      { cause },
    );
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== nextSha256) {
    throw new Error(
      `${path} in the rendered release in ${releaseDir} changed after the plan was computed, so nothing was staged -- re-run --upgrade`,
    );
  }
  return {
    path,
    staged: stagedNameFor(`${UPGRADE_STAGED_DIR_NAME}/${path}`),
    sha256,
    bytes,
  };
}

/** `.groundwork/upgrade` exists but is not a directory; rethrown unwrapped. */
class UpgradeDirectoryError extends Error {
  override readonly name = "UpgradeDirectoryError";
}

/**
 * Checks what a previous run left at `<targetDir>/.groundwork/upgrade`,
 * writing nothing, and returns the names of its entries that a staging does
 * not write (anything but `plan.json`, `upgrade-report.md` and `staged`),
 * sorted: the entries the next {@link stageUpgrade} discards. Nothing there,
 * or a symlink (which `stageUpgrade` refuses), gives an empty list.
 *
 * @throws `Error` naming `.groundwork/upgrade` and saying to remove it when
 *   it is a regular file or anything else that is not a directory; `Error`
 *   with `cause` when it cannot be inspected or listed.
 *
 * @example
 * ```ts
 * import { inspectPreviousUpgrade } from "./upgrade/stage.js";
 *
 * const foreign = inspectPreviousUpgrade("/work/app"); // e.g. ["decisions.json"]
 * ```
 */
export function inspectPreviousUpgrade(targetDir: string): string[] {
  const dir = join(targetDir, UPGRADE_RELATIVE_DIR);
  try {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink()) return [];
    if (!stat.isDirectory()) {
      throw new UpgradeDirectoryError(
        `${dir} is not a directory -- remove it so --upgrade can write its plan to ${UPGRADE_RELATIVE_DIR}/`,
      );
    }
    return readdirSync(dir)
      .filter((name) => !OWN_ENTRIES.has(name))
      .sort();
  } catch (cause) {
    if (cause instanceof UpgradeDirectoryError) throw cause;
    throw new Error(`could not inspect ${dir}`, { cause });
  }
}

/**
 * Stages the upgrade `plan` into `<targetDir>/.groundwork/upgrade/`: the
 * rendered `release`'s bytes of every `add`, `safe-update`, `conflict-2way`
 * and `conflict-3way` file as `staged/<path>.staged`, then
 * `upgrade-report.md` ({@link renderUpgradeReport}), then `plan.json` last:
 * the plan plus `legacy: false` and the staged list, in the plan's path
 * order, as two-space-indented JSON with a trailing newline. Every staged
 * file is read from the release and checked against its plan entry's
 * `nextSha256` before anything is written, so each recorded `sha256` equals
 * `nextSha256`. No timestamp and no absolute path is written, so the same
 * inputs give the same bytes. The directory is built in a work directory and
 * swapped in by rename, so a previous `.groundwork/upgrade/` is replaced
 * wholesale, foreign entries included ({@link inspectPreviousUpgrade} lists
 * them), or left intact when staging fails. Nothing outside
 * `.groundwork/upgrade/` is written, apart from creating `.groundwork/`
 * itself and a work directory beside it that is always removed.
 *
 * @param params - The project root, the plan `computePlan` returned for it
 *   and the release it was computed against (not yet disposed).
 * @returns The staging directory and the staged files.
 * @throws `Error` naming the path and the release directory, with `cause`,
 *   when a staged file cannot be read from the release, and `Error` naming
 *   the path when its bytes differ from the plan's `nextSha256` (the release
 *   changed after the plan was computed); both before anything is written,
 *   `.groundwork/` included. An `AssertionError` for a plan path that is not
 *   relative and inside the project.
 * @throws `Error` naming the path when `.groundwork/` or
 *   `.groundwork/upgrade/` is a symlink, before anything is written.
 * @throws The standard `.groundwork/ is incomplete -- re-run` `Error`, with
 *   `cause`, when writing the staging fails (two staged names that land on
 *   one file on a case-insensitive file system fail the second exclusive
 *   write).
 *
 * @example
 * ```ts
 * import { stageUpgrade } from "./upgrade/stage.js";
 *
 * const { dir, staged } = stageUpgrade({ targetDir: "/work/app", plan, release });
 * console.log(`${String(staged.length)} files staged in ${dir}`);
 * ```
 */
export function stageUpgrade(params: {
  readonly targetDir: string;
  readonly plan: UpgradePlan;
  readonly release: RenderedRelease;
}): StagedUpgrade {
  const { targetDir, plan, release } = params;
  // Read and verified up front, outside stageAtomically, so a stale or
  // missing release copy fails before .groundwork/ is touched. computePlan
  // sorts `files` by path, so this list is sorted too.
  const verified = plan.files
    .filter((entry) => STAGED_CLASSES[entry.class])
    .map((entry) => readVerified(release.dir, entry.path, entry.nextSha256));
  const staged: StagedUpgradeFile[] = verified.map((file) => ({
    path: file.path,
    staged: file.staged,
    sha256: file.sha256,
  }));

  const target: StagingTarget = {
    groundworkDir: join(targetDir, ".groundwork"),
    dirName: UPGRADE_DIR_NAME,
    noun: "upgrade plan",
    plural: false,
  };
  const dir = prepareStaging(target);
  stageAtomically(target, (newDir) => {
    for (const file of verified) {
      writeStagedBytes(CALLER, file.bytes, newDir, file.staged);
    }
    writeStagedBytes(
      CALLER,
      Buffer.from(renderUpgradeReport(plan), "utf8"),
      newDir,
      UPGRADE_REPORT_FILE,
    );
    const planJson = `${JSON.stringify({ ...plan, legacy: false, staged }, null, 2)}\n`;
    writeStagedBytes(
      CALLER,
      Buffer.from(planJson, "utf8"),
      newDir,
      UPGRADE_PLAN_FILE,
    );
  });
  return { dir, staged };
}
