// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one owner of the names under `.groundwork/upgrade/`, the directory the
 * `--upgrade` plan step writes: `stage.ts` writes them, `report.ts` and
 * `main.ts` name them in text. A module of its own so `report.ts` can read
 * them without importing `stage.ts`, which imports `report.ts`.
 */

/**
 * The staging directory's name under `.groundwork/`.
 *
 * @example
 * ```ts
 * import { UPGRADE_DIR_NAME } from "./upgrade/paths.js";
 *
 * const dir = `.groundwork/${UPGRADE_DIR_NAME}`; // ".groundwork/upgrade"
 * ```
 */
export const UPGRADE_DIR_NAME = "upgrade";

/**
 * The staging directory, relative to the project root, `/`-separated.
 *
 * @example
 * ```ts
 * import { UPGRADE_RELATIVE_DIR } from "./upgrade/paths.js";
 *
 * console.log(`wrote ${UPGRADE_RELATIVE_DIR}/`); // "wrote .groundwork/upgrade/"
 * ```
 */
export const UPGRADE_RELATIVE_DIR: string = `.groundwork/${UPGRADE_DIR_NAME}`;

/**
 * The directory under the staging directory that holds the `.staged` copies.
 *
 * @example
 * ```ts
 * import { UPGRADE_STAGED_DIR_NAME } from "./upgrade/paths.js";
 *
 * const name = `${UPGRADE_STAGED_DIR_NAME}/README.md.staged`;
 * ```
 */
export const UPGRADE_STAGED_DIR_NAME = "staged";

/**
 * The plan's file name, written last: the commit marker of a staging.
 *
 * @example
 * ```ts
 * import { UPGRADE_PLAN_FILE } from "./upgrade/paths.js";
 *
 * const path = `.groundwork/upgrade/${UPGRADE_PLAN_FILE}`;
 * ```
 */
export const UPGRADE_PLAN_FILE = "plan.json";

/**
 * The report's file name.
 *
 * @example
 * ```ts
 * import { UPGRADE_REPORT_FILE } from "./upgrade/paths.js";
 *
 * const path = `.groundwork/upgrade/${UPGRADE_REPORT_FILE}`;
 * ```
 */
export const UPGRADE_REPORT_FILE = "upgrade-report.md";
