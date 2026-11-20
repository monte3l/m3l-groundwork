// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's plan step, its writes: {@link stageUpgrade} writes the
 * plan, its report and the new release's copy of every file the plan would
 * change into `.groundwork/upgrade/`, as one unit swapped in by rename
 * (`stageAtomically` in `staging.ts`). This module never imports `main.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProjectRelativePath } from "../manifest.js";
import {
  prepareStaging,
  stageAtomically,
  stagedNameFor,
  writeStagedBytes,
} from "../staging.js";
import type { StagingTarget } from "../staging.js";
import type { UpgradeClass } from "./classify.js";
import type { RenderedRelease, UpgradePlan } from "./plan.js";
import { renderUpgradeReport } from "./report.js";

/** The staging directory's name under `.groundwork/`. */
const UPGRADE_DIR_NAME = "upgrade";
/** The directory under `.groundwork/upgrade/` that holds the staged copies. */
const STAGED_DIR_NAME = "staged";
const CALLER = "stageUpgrade";

/**
 * One file staged by {@link stageUpgrade}: its project-relative `path`, its
 * `staged` name relative to `.groundwork/upgrade/`
 * (`staged/<path>.staged`) and the sha256 of the staged bytes. Reached by
 * consumers as `StagedUpgrade["staged"][number]`.
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

/**
 * Reads `path` from the rendered release. `computePlan` already refused any
 * path that is not relative and inside the project, so one here is a caller
 * defect: an `AssertionError`, which `stageAtomically` surfaces unwrapped.
 */
function readReleaseFile(releaseDir: string, path: string): Buffer {
  assert.ok(
    isProjectRelativePath(path),
    `${CALLER}: refusing to stage ${JSON.stringify(path)}: not a relative, /-separated path inside the project`,
  );
  return readFileSync(join(releaseDir, path));
}

/**
 * Stages the upgrade `plan` into `<targetDir>/.groundwork/upgrade/`: the
 * rendered `release`'s bytes of every `add`, `safe-update`, `conflict-2way`
 * and `conflict-3way` file as `staged/<path>.staged`, then
 * `upgrade-report.md` ({@link renderUpgradeReport}), then `plan.json` last:
 * the plan plus `legacy: false` and the staged list, sorted by path, as
 * two-space-indented JSON with a trailing newline. No timestamp and no
 * absolute path is written, so the same inputs give the same bytes. The
 * directory is built in a work directory and swapped in by rename, so a
 * previous `.groundwork/upgrade/` is replaced wholesale, or left intact when
 * staging fails. Nothing outside `.groundwork/upgrade/` is written, apart
 * from creating `.groundwork/` itself and a work directory beside it that is
 * always removed.
 *
 * @param params - The project root, the plan `computePlan` returned for it
 *   and the release it was computed against (not yet disposed).
 * @returns The staging directory and the staged files.
 * @throws `Error` naming the path when `.groundwork/` or
 *   `.groundwork/upgrade/` is a symlink, before anything is written.
 * @throws The standard `.groundwork/ is incomplete -- re-run` `Error`, with
 *   `cause`, when reading the release or writing the staging fails (two
 *   staged names that land on one file on a case-insensitive file system
 *   fail the second exclusive write); an `AssertionError` for a plan path
 *   that is not relative and inside the project.
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
  // The default sort is code-unit order, the order the plan itself sorts by.
  const toStage = plan.files
    .filter((entry) => STAGED_CLASSES[entry.class])
    .map((entry) => entry.path)
    .sort()
    .map((path) => ({
      path,
      staged: stagedNameFor(`${STAGED_DIR_NAME}/${path}`),
    }));

  const target: StagingTarget = {
    groundworkDir: join(targetDir, ".groundwork"),
    dirName: UPGRADE_DIR_NAME,
    noun: "upgrade plan",
    plural: false,
  };
  const dir = prepareStaging(target);
  const staged = stageAtomically(target, (newDir) => {
    const written: StagedUpgradeFile[] = toStage.map(({ path, staged }) => ({
      path,
      staged,
      sha256: writeStagedBytes(
        CALLER,
        readReleaseFile(release.dir, path),
        newDir,
        staged,
      ),
    }));
    writeStagedBytes(
      CALLER,
      Buffer.from(renderUpgradeReport(plan), "utf8"),
      newDir,
      "upgrade-report.md",
    );
    const planJson = `${JSON.stringify({ ...plan, legacy: false, staged: written }, null, 2)}\n`;
    writeStagedBytes(
      CALLER,
      Buffer.from(planJson, "utf8"),
      newDir,
      "plan.json",
    );
    return written;
  });
  return { dir, staged };
}
