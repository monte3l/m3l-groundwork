// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `m3l-groundwork <dir> --add-pack <name>...`: stages one or more packs from
 * `templates/packs/` into an already bootstrapped or adopted project, for
 * `/customize add-pack` to install. The CLI never installs here: it writes
 * nothing outside `<dir>/.groundwork/add-pack/<name>/` -- each pack's inert
 * `pack.json.staged`, `files/<path>.staged` and, last, `plan.json`, the
 * survey `/customize` reads. Every refusal happens before the first write.
 */
import assert from "node:assert/strict";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { toPosixPath } from "./assets.js";
import {
  CAP_KEYS,
  CAP_LIMITS,
  countProjectCaps,
  formatCapsSummary,
} from "./caps.js";
import type { CapCounts } from "./caps.js";
import { planConflicts } from "./conflicts.js";
import type { FileConflict } from "./conflicts.js";
import { isLexicallyContained, isPathContained } from "./emit.js";
import { assertNotSymlink } from "./fs-guard.js";
import { resolveCliVersion } from "./inventory.js";
import {
  PACK_STATUS_LABELS,
  inspectPackInstallations,
  unsafeLedgerNames,
  projectNameOf,
} from "./pack-installation.js";
import type { PackInstallStatus, ProjectOrigin } from "./pack-installation.js";
import { planStagedPackDirs, writeStagedPack } from "./pack-stage.js";
import type { StagedPack } from "./pack-stage.js";
import { listPackNames, loadPack, observeWiring } from "./packs.js";
import type { Pack, PackManifest } from "./packs.js";
import { inspectCustomizeSkill } from "./plugin.js";
import {
  isIncompleteStagingError,
  prepareStaging,
  stageAtomically,
} from "./staging.js";
import type { StagingTarget } from "./staging.js";
import { errnoCode, isAbsentError } from "./survey/internal/read-guard.js";
import { paint } from "./term.js";
import { buildTokens, isNpmPackageName } from "./tokens.js";
import type { TokenTable } from "./tokens.js";
import { CliUsageError, USAGE } from "./usage.js";
import type { CliOptions } from "./main.js";

/**
 * The project-relative directory packs are staged under by `--add-pack`;
 * one pack's staging is `${STAGED_ADD_PACK_DIR}/<name>`.
 *
 * @example
 * ```ts
 * const dir = `${STAGED_ADD_PACK_DIR}/quality`; // ".groundwork/add-pack/quality"
 * ```
 */
export const STAGED_ADD_PACK_DIR = ".groundwork/add-pack";

/**
 * The plan file written last into each staged pack's directory: its presence
 * means that pack's staging completed.
 *
 * @example
 * ```ts
 * const planPath = `${STAGED_ADD_PACK_DIR}/quality/${ADD_PACK_PLAN_FILE}`;
 * ```
 */
export const ADD_PACK_PLAN_FILE = "plan.json";

/**
 * The `schemaVersion` of `plan.json`.
 *
 * @example
 * ```ts
 * if (plan.schemaVersion !== ADD_PACK_PLAN_SCHEMA_VERSION) throw new Error("unsupported plan");
 * ```
 */
export const ADD_PACK_PLAN_SCHEMA_VERSION = 1;

/**
 * `--add-pack`'s write-scope invariant (docs/assurance-case.md): every path
 * resolves under `<targetDir>/.groundwork/add-pack/`. `paths` may be
 * absolute or relative to `targetDir`; containment is
 * {@link isPathContained}'s, so a look-alike `.groundwork-evil/` or
 * `.groundwork/add-pack-evil/` is rejected. Lexical only: symlinked
 * components are refused by the writer itself (`fs-guard.ts`).
 *
 * @throws `AssertionError` naming the first path outside the scope.
 *
 * @example
 * ```ts
 * import { assertAddPackWriteScope } from "./add-pack.js";
 * assertAddPackWriteScope("/work/app", [".groundwork/add-pack/quality/plan.json"]); // ok
 * assertAddPackWriteScope("/work/app", ["package.json"]); // throws
 * ```
 */
export function assertAddPackWriteScope(
  targetDir: string,
  paths: readonly string[],
): void {
  const root = resolve(targetDir, STAGED_ADD_PACK_DIR);
  for (const path of paths) {
    const resolved = resolve(targetDir, path);
    assert.ok(
      isPathContained(resolved, root),
      isLexicallyContained(resolved, root)
        ? `add-pack mode wrote outside its scope: ${resolved} (a symlink on its path leads outside it, or the path cannot be resolved)`
        : `add-pack mode wrote outside its scope: ${resolved}`,
    );
  }
}

/**
 * A check on `path` that could not be made -- not a fact about the project:
 * an `Error` naming the path and errno, with the failure as `cause`.
 */
function checkFailed(path: string, error: unknown): Error {
  return new Error(
    `could not check ${path} (${errnoCode(error) ?? "unknown error"})`,
    { cause: error },
  );
}

/**
 * `path`'s stats by a real `stat`, or `undefined` when nothing is there
 * (`ENOENT`/`ENOTDIR`); any other failure throws {@link checkFailed}'s error.
 */
function statOrAbsent(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if (isAbsentError(error)) return undefined;
    throw checkFailed(path, error);
  }
}

/** Refuses a target that is missing, not a directory, or empty. */
function assertStageableTarget(targetDir: string): void {
  if (statOrAbsent(targetDir)?.isDirectory() !== true) {
    throw new CliUsageError(
      `${targetDir} is not an existing directory -- --add-pack stages packs into an existing project\n\n${USAGE}`,
    );
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(targetDir);
  } catch (error) {
    throw checkFailed(targetDir, error);
  }
  if (entries.length === 0) {
    throw new CliUsageError(
      `${targetDir} is empty: nothing to add a pack to -- bootstrap with --pack <name> instead\n\n${USAGE}`,
    );
  }
}

/** Loads a pack by name; an unknown name is a usage error listing the available ones. */
function resolveAddPack(name: string): Pack {
  const available = listPackNames();
  if (!available.includes(name)) {
    const list = available.length > 0 ? available.join(", ") : "none";
    throw new CliUsageError(
      `unknown pack "${name}" (available: ${list})\n\n${USAGE}`,
    );
  }
  return loadPack(name);
}

/** `plan.json`'s payload, minus `staged`, which is added once the pack's files are written. */
interface AddPackPlan {
  readonly schemaVersion: typeof ADD_PACK_PLAN_SCHEMA_VERSION;
  readonly kind: "m3l-groundwork/add-pack-plan";
  readonly cliVersion: string;
  readonly generatedAt: string;
  readonly targetDir: string;
  readonly origin: ProjectOrigin;
  readonly requiredMode: "adopt" | "fresh";
  readonly reinstall: boolean;
  readonly tokens: TokenTable;
  readonly pack: {
    readonly name: string;
    readonly description: string;
    readonly modes: readonly string[];
    readonly budget: CapCounts;
    readonly requires: PackManifest["requires"] | null;
    readonly wiring: PackManifest["wiring"];
    readonly adoptNotes: PackManifest["adoptNotes"] | null;
    readonly setupSteps: PackManifest["setupSteps"] | null;
  };
  readonly fileConflicts: readonly FileConflict[];
  readonly wiringObservations: readonly string[];
  readonly requires: readonly {
    readonly path: string;
    readonly present: boolean;
  }[];
  readonly caps: {
    readonly current: CapCounts;
    readonly pack: CapCounts;
    readonly total: CapCounts;
    readonly limits: CapCounts;
    readonly overCap: readonly (keyof CapCounts)[];
  };
  readonly installation: PackInstallStatus;
  readonly undetermined: readonly string[];
}

interface PlannedAddPack {
  readonly pack: Pack;
  readonly plan: AddPackPlan;
  readonly status: string;
  readonly divergent: number;
}

/** `JSON.stringify` of a plan, asserted to be a string (it can return `undefined`). */
function serializePlan(
  name: string,
  plan: AddPackPlan & { readonly staged: StagedPack },
): string {
  const text: unknown = JSON.stringify(plan, null, 2);
  if (typeof text !== "string") {
    throw new Error(`add-pack: pack "${name}"'s plan is not JSON`);
  }
  return `${text}\n`;
}

/**
 * Stages every pack in `options.addPacks` (sorted, de-duplicated by
 * `parseArgs`) into `<targetDir>/.groundwork/add-pack/<name>/`, then prints
 * one line per pack, the project's caps summary and the `/customize` next
 * step. Everything is read and planned first: a missing, non-directory or
 * empty target, a project that is neither adopted nor bootstrapped (or an
 * adopt run that did not complete), an unknown pack, a pack whose `modes`
 * lack the project's mode (`adopt` for an adopted project, `fresh` for a
 * bootstrapped one), an `installed` or `outdated` pack without
 * `--reinstall`, an invalid
 * `--name`, or a required path missing from a bootstrapped project is a
 * `CliUsageError` with nothing written -- for every pack, so one bad pack
 * stages none. A missing required path on an adopted project is only
 * recorded. Over a cap is a warning, never an error.
 *
 * Then, before the first write, every planned path is checked by
 * {@link assertAddPackWriteScope} and `.groundwork`, `.groundwork/add-pack`
 * and each `.groundwork/add-pack/<name>` are refused if a symlink. Each pack
 * is staged in turn, atomically (`stageAtomically`): a work directory, then
 * a rename over the previous `add-pack/<name>/` only, `plan.json` written
 * last. Beyond `add-pack/<name>/`, it creates only `.groundwork/` and
 * `.groundwork/add-pack/` when they are absent; nothing else in the project
 * or `.groundwork/` is created, changed or removed (bar `.<name>-*` work
 * directories of a pack being staged). A
 * failure on pack k leaves packs 1..k-1 staged; its message names the packs
 * staged and not staged.
 *
 * @throws `CliUsageError` for the refusals above; `Error` for a symlinked
 * staging directory; `AssertionError` for a scope violation (a bug); for a
 * staging failure an `Error` (or, when restoring the previous copy also
 * failed, an `AggregateError` of both) naming staged and unstaged packs,
 * with the original as `cause`.
 *
 * @example
 * ```ts
 * import { parseArgs } from "./main.js";
 * runAddPack(parseArgs(["/work/app", "--add-pack", "quality"]));
 * ```
 */
export function runAddPack(options: CliOptions): void {
  const { targetDir } = options;
  assertStageableTarget(targetDir);
  if (options.projectName !== "" && !isNpmPackageName(options.projectName)) {
    throw new CliUsageError(
      `--name must be a valid npm package name: ${JSON.stringify(options.projectName)}\n\n${USAGE}`,
    );
  }
  const names = [...new Set(options.addPacks)].sort();
  const packs = names.map((name) => resolveAddPack(name));

  // The /customize Record step never updates a ledger entry named like an
  // object-prototype key, so refuse here, before anything is staged.
  const unsafeNames = unsafeLedgerNames(targetDir);
  if (unsafeNames.length > 0) {
    throw new CliUsageError(
      `${targetDir}'s .groundwork/installed-packs.json has an entry named ${unsafeNames.map((name) => JSON.stringify(name)).join(", ")}, which no pack can have -- remove it and re-run\n\n${USAGE}`,
    );
  }

  const report = inspectPackInstallations(targetDir, names);
  const { origin } = report;
  if (origin.kind === "interrupted-adopt") {
    throw new CliUsageError(
      `${targetDir}: an adopt run did not complete (.groundwork/ has no valid inventory.json) -- re-run \`m3l-groundwork ${targetDir}\` first\n\n${USAGE}`,
    );
  }
  if (origin.kind === "unknown") {
    throw new CliUsageError(
      `${targetDir} is not a groundwork project (neither adopted nor bootstrapped) -- run \`m3l-groundwork ${targetDir}\` (adopt) first\n\n${USAGE}`,
    );
  }
  const requiredMode = origin.kind === "adopted" ? "adopt" : "fresh";
  for (const { manifest } of packs) {
    if (!manifest.modes.includes(requiredMode)) {
      throw new CliUsageError(
        `pack "${manifest.name}" does not support ${requiredMode} mode (modes: ${manifest.modes.join(", ")}), which this ${origin.kind} project needs -- it is not ${requiredMode}-capable; see its adoptNotes in the pack's documentation or \`m3l-groundwork --list-packs\`\n\n${USAGE}`,
      );
    }
  }
  const tokens = buildTokens(
    options.projectName !== "" ? options.projectName : projectNameOf(targetDir),
  );
  let current: CapCounts;
  const capsUndetermined: string[] = [];
  try {
    current = countProjectCaps(targetDir, capsUndetermined);
  } catch (cause) {
    throw new Error(`could not count ${targetDir}'s capped artifacts`, {
      cause,
    });
  }

  const planned = packs.map((pack, index): PlannedAddPack => {
    const { manifest } = pack;
    const entry = report.packs[index];
    assert.ok(entry?.name === manifest.name, "add-pack: report out of order");
    const installation = entry.status;
    if (installation.status === "installed" && !options.reinstall) {
      throw new CliUsageError(
        `pack "${manifest.name}" is already installed in ${targetDir} -- pass --reinstall to stage it again\n\n${USAGE}`,
      );
    }
    if (installation.status === "outdated" && !options.reinstall) {
      throw new CliUsageError(
        `pack "${manifest.name}" is already installed in ${targetDir} and outdated (an older CLI installed a different copy of it) -- re-run with --update to bring the whole project forward, or pass --reinstall to restage just this pack\n\n${USAGE}`,
      );
    }
    const requires = (manifest.requires?.paths ?? []).map((path) => ({
      path,
      present: statOrAbsent(join(targetDir, path)) !== undefined,
    }));
    const missing = requires.find(({ present }) => !present);
    if (missing !== undefined && requiredMode === "fresh") {
      throw new CliUsageError(
        `pack "${manifest.name}" requires "${missing.path}", which is missing from ${targetDir} -- restore it, then re-run\n\n${USAGE}`,
      );
    }
    const undetermined = [...report.undetermined, ...capsUndetermined];
    const fileConflicts = planConflicts(
      pack.filesDir,
      targetDir,
      tokens,
      undetermined,
    ).map((conflict) => ({
      ...conflict,
      relPath: toPosixPath(conflict.relPath),
    }));
    const wiringObservations = observeWiring(targetDir, manifest, undetermined);
    const total = { ...current };
    for (const key of CAP_KEYS) total[key] += manifest.budget[key];
    const plan: AddPackPlan = {
      schemaVersion: ADD_PACK_PLAN_SCHEMA_VERSION,
      kind: "m3l-groundwork/add-pack-plan",
      cliVersion: resolveCliVersion(),
      generatedAt: new Date().toISOString(),
      targetDir,
      origin,
      requiredMode,
      reinstall: options.reinstall,
      tokens,
      pack: {
        name: manifest.name,
        description: manifest.description,
        modes: manifest.modes,
        budget: manifest.budget,
        requires: manifest.requires ?? null,
        wiring: manifest.wiring,
        adoptNotes: manifest.adoptNotes ?? null,
        setupSteps: manifest.setupSteps ?? null,
      },
      fileConflicts,
      wiringObservations,
      requires,
      caps: {
        current,
        pack: manifest.budget,
        total,
        limits: CAP_LIMITS,
        overCap: CAP_KEYS.filter((key) => total[key] > CAP_LIMITS[key]),
      },
      installation,
      undetermined,
    };
    return {
      pack,
      plan,
      status: PACK_STATUS_LABELS[installation.status],
      divergent: fileConflicts.filter((c) => c.status === "divergent").length,
    };
  });

  const addPackDir = join(targetDir, STAGED_ADD_PACK_DIR);
  const staging = planStagedPackDirs(packs, addPackDir, tokens);
  assertAddPackWriteScope(targetDir, [
    ...staging.paths,
    ...names.map((name) => join(addPackDir, name, ADD_PACK_PLAN_FILE)),
  ]);
  const skill = inspectCustomizeSkill(targetDir);
  assertNotSymlink(join(targetDir, ".groundwork"));
  assertNotSymlink(addPackDir);
  for (const name of names) assertNotSymlink(join(addPackDir, name));

  const staged: string[] = [];
  const lines: string[] = [];
  for (const [index, { pack, plan, status, divergent }] of planned.entries()) {
    const name = pack.manifest.name;
    const stagingPack = staging.packs[index];
    assert.ok(stagingPack?.name === name, "add-pack: plan out of order");
    const target: StagingTarget = {
      groundworkDir: addPackDir,
      dirName: name,
      noun: `pack "${name}"`,
      plural: false,
    };
    let record: StagedPack;
    try {
      prepareStaging(target);
      record = stageAtomically(target, (newDir) => {
        const result = writeStagedPack(
          stagingPack,
          newDir,
          `${STAGED_ADD_PACK_DIR}/${name}`,
        );
        // Last: plan.json's presence means this pack's staging completed.
        writeFileSync(
          join(newDir, ADD_PACK_PLAN_FILE),
          serializePlan(name, { ...plan, staged: result }),
          { flag: "wx" },
        );
        return result;
      });
    } catch (cause) {
      throw stagingFailure(name, cause, staged, names.slice(index));
    }
    staged.push(name);
    lines.push(
      `add-pack ${name}: staged ${STAGED_ADD_PACK_DIR}/${name}/ (${status}; ${String(record.files.length)} file(s), ${String(divergent)} conflict(s))`,
    );
  }

  for (const line of lines) console.log(line);
  const summary = formatCapsSummary(
    current,
    packs.map(({ manifest }) => ({
      name: manifest.name,
      budget: manifest.budget,
    })),
    "project:",
  );
  console.log(
    summary.overCap
      ? paint(process.stdout, "warning", summary.text)
      : summary.text,
  );
  const list = names.join(" ");
  console.log(
    skill === "current"
      ? `next: run /customize add-pack ${list}`
      : `next: update the groundwork plugin (or replace .claude/skills/customize/ with the current copy), then run /customize add-pack ${list}`,
  );
}

/**
 * The error for a staging failure on pack `name`: the root failure's
 * message plus which packs were staged and which were not, that the rest of
 * `.groundwork/` was not touched, and the `--add-pack` re-run. An
 * `AssertionError` (a bug) stays one -- a new one, the original as `cause`;
 * an `AggregateError` (restore also failed: its message names the parked
 * copy) stays one, with the same `errors` and itself as `cause`; anything
 * else becomes an `Error` with the root failure (looking through staging's
 * adopt-flavoured wrapper) as `cause`.
 */
function stagingFailure(
  name: string,
  cause: unknown,
  staged: readonly string[],
  notStaged: readonly string[],
): Error {
  const which = `${staged.length > 0 ? `staged: ${staged.join(", ")}` : "no pack was staged"}; not staged: ${notStaged.join(", ")}`;
  if (cause instanceof assert.AssertionError) {
    const error = new assert.AssertionError({
      message: `${cause.message}; ${which}`,
    });
    error.cause = cause;
    return error;
  }
  const root = isIncompleteStagingError(cause) ? cause.cause : cause;
  const reason = root instanceof Error ? root.message : String(root);
  const message = `could not stage pack "${name}" (${reason}); ${which}; the rest of .groundwork/ was not touched -- fix the cause and re-run with --add-pack ${notStaged.join(" ")}`;
  return cause instanceof AggregateError
    ? new AggregateError(cause.errors, message, { cause })
    : new Error(message, { cause: root });
}
