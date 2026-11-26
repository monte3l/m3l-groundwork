// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * What `--check-update` and `--update` share: the refusals raised before
 * either reads (or writes) anything, the installed CLI's own templates and
 * history, the project's origin as the classification sees it, and the
 * wording of the per-action counts.
 */
import { readdirSync, statSync } from "node:fs";
import { resolveAsset } from "./assets.js";
import { fetchBase } from "./fetch-base.js";
import type { FetchedBase, RunNpm } from "./fetch-base.js";
import { escapeControls } from "./format-error.js";
import { LOCK_FILE, readLock } from "./lock.js";
import type { Lock } from "./lock.js";
import { classifyProjectOrigin } from "./pack-installation.js";
import type { LedgerEntry } from "./pack-installation.js";
import { errnoCode, isAbsentError } from "./survey/internal/read-guard.js";
import { loadTemplateHistory } from "./template-history.js";
import type { TemplateHistory } from "./template-history.js";
import { hasHashOnlyBase } from "./update-classify.js";
import type { UpdateAction, UpdateOrigin } from "./update-classify.js";
import { CliUsageError, USAGE } from "./usage.js";

/**
 * Project-controlled text on one line, with no raw control character.
 *
 * @example
 * ```ts
 * escapeInline("a\nb"); // "a\\nb"
 * ```
 */
export function escapeInline(text: string): string {
  return escapeControls(text).replaceAll("\n", "\\n");
}

/**
 * An error's message, or the value as a string.
 *
 * @example
 * ```ts
 * messageOf(new Error("boom")); // "boom"
 * ```
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses a `targetDir` that is not an existing directory, creating
 * nothing; `flag` (`--check-update` or `--update`) names the run and `need`
 * what it needs the directory for.
 *
 * @throws `CliUsageError` when `targetDir` is absent, not a directory, or
 * cannot be inspected (the failure as `cause`).
 *
 * @example
 * ```ts
 * assertUpdateTarget("/path/to/project", "--update", "a bootstrapped or adopted project to stage an update for");
 * ```
 */
export function assertUpdateTarget(
  targetDir: string,
  flag: string,
  need: string,
): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(targetDir).isDirectory();
  } catch (error) {
    if (!isAbsentError(error)) {
      throw new CliUsageError(
        `${targetDir} could not be checked (${errnoCode(error) ?? "unknown error"}) -- ${flag} needs a project directory it can inspect\n\n${USAGE}`,
        { cause: error },
      );
    }
    // Absent: reported as "not an existing directory" just below.
  }
  if (!isDirectory) {
    throw new CliUsageError(
      `${targetDir} is not an existing directory -- ${flag} needs ${need}\n\n${USAGE}`,
    );
  }
}

/**
 * Refuses a project whose origin gives nothing to compare against: an adopt
 * run that did not finish, or an unknown origin with no lock.
 *
 * @throws `CliUsageError` for either refusal.
 *
 * @example
 * ```ts
 * assertUpdatableOrigin("/path/to/project");
 * ```
 */
export function assertUpdatableOrigin(targetDir: string): void {
  const origin = classifyProjectOrigin(targetDir);
  switch (origin.kind) {
    case "interrupted-adopt":
      throw new CliUsageError(
        `${targetDir} holds an adopt run that did not finish -- re-run adopt mode (npx @monte3l/groundwork ${targetDir}) first`,
      );
    case "unknown":
      if ("absent" in readLock(targetDir)) {
        throw new CliUsageError(
          `${targetDir} does not look like a project groundwork bootstrapped or adopted (no ${LOCK_FILE}, no bootstrap or adopt markers) -- there is no release to compare against`,
        );
      }
      return;
    case "adopted":
    case "bootstrapped":
      return;
    default: {
      const exhaustive: never = origin;
      throw new Error(`unhandled project origin ${String(exhaustive)}`);
    }
  }
}

/**
 * The installed CLI's own `templates/core`, refusing one that cannot be
 * read: comparing against it would report every file removed upstream.
 * `what` opens the message (`"cannot check for an update"`).
 *
 * @throws `Error` (the read failure as `cause`) when it cannot be listed.
 *
 * @example
 * ```ts
 * const coreDir = installedCoreDir("cannot stage an update");
 * ```
 */
export function installedCoreDir(what: string): string {
  const dir = resolveAsset({ repo: "templates/core", local: "templates/core" });
  try {
    readdirSync(dir);
  } catch (error) {
    throw new Error(
      `${what}: this CLI's templates (${dir}) cannot be read (${errnoCode(error) ?? "unknown error"}) -- this CLI install is damaged; reinstall @monte3l/groundwork`,
      { cause: error },
    );
  }
  return dir;
}

/**
 * The template history: `injected` when given, else the shipped one.
 *
 * @throws `Error` (a packaging defect, never a usage error) when it is
 * damaged; `what` opens the message.
 *
 * @example
 * ```ts
 * const history = requireTemplateHistory(undefined, "cannot stage an update");
 * ```
 */
export function requireTemplateHistory(
  injected: { history: TemplateHistory } | { note: string } | undefined,
  what: string,
): { history: TemplateHistory } {
  const loaded = injected ?? loadTemplateHistory();
  if ("note" in loaded) {
    throw new Error(
      `${what}: ${loaded.note} -- this CLI install is damaged; reinstall @monte3l/groundwork`,
    );
  }
  return loaded;
}

/**
 * The project's origin as the classification sees it: the lock's when there
 * is one, else the project's markers.
 *
 * @example
 * ```ts
 * const origin = updateOrigin("/path/to/project", undefined); // "fresh"
 * ```
 */
export function updateOrigin(
  targetDir: string,
  lock: Lock | undefined,
): UpdateOrigin {
  if (lock !== undefined) return lock.origin === "adopt" ? "adopted" : "fresh";
  const { kind } = classifyProjectOrigin(targetDir);
  switch (kind) {
    case "adopted":
      return "adopted";
    case "bootstrapped":
      return "fresh";
    case "interrupted-adopt":
    case "unknown":
      return "unknown";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled project origin ${String(exhaustive)}`);
    }
  }
}

/**
 * The version each ledger pack was installed with, for the entries that
 * record one.
 *
 * @example
 * ```ts
 * ledgerPackVersions([{ name: "quality", cliVersion: "1.4.0" }]); // { quality: "1.4.0" }
 * ```
 */
export function ledgerPackVersions(
  entries: readonly LedgerEntry[],
): Record<string, string> {
  return Object.fromEntries(
    entries.flatMap(({ name, cliVersion }) =>
      cliVersion === undefined ? [] : [[name, cliVersion] as const],
    ),
  );
}

/** The counted actions, in print order, with their wording. */
const COUNT_PARTS: readonly (readonly [UpdateAction, string])[] = [
  ["take", "update cleanly"],
  ["merge", "need a merge"],
  ["conflict", "conflict"],
  ["review", "need review"],
  ["add", "new"],
  ["delete", "removed"],
  ["rename", "renamed"],
];

/**
 * The non-zero per-action counts of `summary`, worded for a report line
 * (`3 update cleanly`, `1 conflict`, ...), in a fixed order.
 *
 * @example
 * ```ts
 * formatUpdateCounts(result.summary).join(", "); // "2 update cleanly, 1 new"
 * ```
 */
export function formatUpdateCounts(
  summary: Readonly<Record<UpdateAction, number>>,
): string[] {
  return COUNT_PARTS.filter(([action]) => summary[action] > 0).map(
    ([action, wording]) => `${String(summary[action])} ${wording}`,
  );
}

/** The actions that change something in the project. */
const ACTIONABLE: ReadonlySet<UpdateAction> = new Set<UpdateAction>([
  "take",
  "merge",
  "conflict",
  "review",
  "add",
  "delete",
  "rename",
]);

/**
 * Whether an update would change this project: any entry whose action
 * changes something (take, merge, conflict, add, delete, rename, review), or
 * any outdated ledger pack. The one test `--check-update` (exit 3) and
 * `--update` (stage rather than `already up to date`) share.
 *
 * @example
 * ```ts
 * import { isUpdateAvailable } from "./update-common.js";
 *
 * isUpdateAvailable([{ action: "keep" }], 0); // false
 * isUpdateAvailable([{ action: "take" }], 0); // true
 * ```
 */
export function isUpdateAvailable(
  entries: readonly { readonly action: UpdateAction }[],
  outdatedPacks: number,
): boolean {
  return (
    outdatedPacks > 0 || entries.some(({ action }) => ACTIONABLE.has(action))
  );
}

/**
 * The base `--fetch-base` brings, or `undefined` when no fetch is wanted:
 * without the flag, or when neither `--base-version` was given nor any base
 * is known only by its hash (see `hasHashOnlyBase`). Otherwise fetches
 * `input.baseVersion` through `runNpm` (default: the real `npm`).
 *
 * @throws `CliUsageError` (exit 2) when the fetch fails; nothing is written.
 *
 * @example
 * ```ts
 * import { fetchedBaseFor } from "./update-common.js";
 *
 * const fetchedBase = fetchedBaseFor(input, { fetchBase: true, explicitVersion: false });
 * ```
 */
export function fetchedBaseFor(
  input: Parameters<typeof hasHashOnlyBase>[0],
  options: {
    readonly fetchBase: boolean | undefined;
    readonly explicitVersion: boolean;
    readonly runNpm?: RunNpm | undefined;
  },
): FetchedBase | undefined {
  if (options.fetchBase !== true) return undefined;
  if (!options.explicitVersion && !hasHashOnlyBase(input)) return undefined;
  return fetchBase({ version: input.baseVersion, runNpm: options.runNpm });
}
