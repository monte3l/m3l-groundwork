// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Serializes a survey + conflict plan + pack survey into
 * `.groundwork/inventory.json` -- the machine-readable handoff
 * `/customize`'s Step 0 (the adopt-mode reconcile step in `/customize`)
 * reads instead of re-deriving the survey itself.
 * Schema-versioned so a future CLI release can tell an old inventory apart
 * from a current one; `/customize` must tolerate an older inventory
 * rather than crash on one -- `schemaVersion: 1` predates packs (no `packs`
 * field), `schemaVersion` below 3 predates the harness grade (no
 * `harnessGrade`/`harnessConformance`), and `schemaVersion` below 4 predates
 * the toolchain grade (no `toolchainGrade`/`toolchainConformance`), and
 * `schemaVersion` below 5 predates staged baseline additions (no
 * `stagedBaseline`) -- `/customize` then falls back to reading absent files
 * from `templateRoot`. From schema 5 on, each staged file is an inert copy
 * named `<path>` + `stagedBaseline.suffix` (`.staged`) and carries the sha256
 * of its staged bytes, so `/customize` can verify a copy before installing it.
 * Schema 5 also carries `stagedPacks`, added additively without a version
 * bump: every pack staged the same inert way under `.groundwork/packs/<name>/`
 * (`pack-stage.ts`), its manifest included. No published release has
 * written schema 5 yet; an inventory without `stagedPacks` came only from an
 * unreleased development build, which staged packs unsuffixed at the same
 * location.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StagedBaselineFile } from "./baseline-stage.js";
import type { CapCounts } from "./caps.js";
import type { FileConflict } from "./conflicts.js";
import { summarizeHarnessConformance } from "./harness/conformance.js";
import type { HarnessConformance } from "./harness/conformance.js";
import type { HarnessGrade } from "./harness/types.js";
import type { ModeDetection } from "./mode.js";
import type { StagedPack } from "./pack-stage.js";
import type { PackWiring } from "./packs.js";
import { toPosixPath } from "./staging.js";
import type { ProjectSurvey } from "./survey/survey.js";
import { summarizeToolchainConformance } from "./toolchain/conformance.js";
import type { ToolchainConformance } from "./toolchain/conformance.js";
import type { ToolchainGrade } from "./toolchain/types.js";

export const INVENTORY_SCHEMA_VERSION = 5;

/**
 * Where adopt mode staged the baseline files the project lacks entirely
 * (`baseline-stage.ts`), and how each staged copy is named.
 *
 * @example
 * ```ts
 * const stagedBaseline: StagedBaseline = {
 *   dir: ".groundwork/baseline",
 *   suffix: ".staged",
 *   files: [{ path: "eslint.config.js", staged: "eslint.config.js.staged", sha256: "…" }],
 * };
 * ```
 */
export interface StagedBaseline {
  /** The staging directory, relative to the project root (e.g. `.groundwork/baseline`). */
  dir: string;
  /** The suffix every staged file name carries (`.staged`), so no toolchain glob ever matches one. */
  suffix: string;
  /** The staged files: install path, staged name relative to `dir`, and sha256 of the staged bytes. */
  files: StagedBaselineFile[];
}

export interface PackSurvey {
  name: string;
  modes: string[];
  budget: CapCounts;
  /** File collisions a pack's `files/` tree would have against the target -- the same shape `conflicts` uses for `templates/core`. */
  fileConflicts: FileConflict[];
  /** The pack's declared wiring, verbatim and unapplied -- adopt mode never applies it. */
  wiring: PackWiring;
  /** Index-level facts about how the wiring would land, never a verdict. */
  wiringObservations: string[];
  adoptNotes: string | undefined;
}

export interface Inventory {
  schemaVersion: number;
  cliVersion: string;
  generatedAt: string;
  modeSignal: string;
  /** The template tree's absolute path, in the platform's native form (not normalized). */
  templateRoot: string;
  /** The adopted project's absolute path, in the platform's native form (not normalized). */
  targetDir: string;
  /** The project survey; its paths are native, not normalized. */
  survey: ProjectSurvey;
  /** Baseline-vs-project file collisions; every `relPath` uses `/` on every platform (normalized by `buildInventory`). */
  conflicts: FileConflict[];
  /** Per-pack surveys; every `fileConflicts[].relPath` uses `/` on every platform, like `conflicts`. */
  packs: PackSurvey[];
  /** Wiring integrity and rubric quality of the project's existing harness. Absent when schemaVersion is below 3. */
  harnessGrade: HarnessGrade;
  /** How far the existing harness has drifted from the baseline's -- information, never a defect. Absent when schemaVersion is below 3. */
  harnessConformance: HarnessConformance;
  /** Wiring integrity and rubric quality of the project's TypeScript toolchain. Absent when schemaVersion is below 4. */
  toolchainGrade: ToolchainGrade;
  /** How far the project's toolchain files have drifted from the baseline's -- information, never a defect. Absent when schemaVersion is below 4. */
  toolchainConformance: ToolchainConformance;
  /** The "absent" baseline files, copied verbatim as inert `<path>.staged` copies for `/customize` to install from. Absent when schemaVersion is below 5; `dir` is project-relative, and `dir` and every `files[].path`/`files[].staged` use `/` on every platform. */
  stagedBaseline: StagedBaseline;
  /** Every pack, staged as inert `.staged` copies (manifest included) under `.groundwork/packs/<name>/` for `/customize` to install from after confirmation; one entry per pack, `dir` project-relative, and `dir` and every `path`/`staged` use `/` on every platform. Absent from inventories written before pack staging became inert (see the module header). */
  stagedPacks: StagedPack[];
}

/** Resolves this CLI package's own `package.json`, relative to this module's runtime location. */
function defaultPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "package.json");
}

/**
 * Resolves this CLI package's own declared version. `packageJsonPath`
 * defaults to this module's own `package.json` -- overridable so callers
 * (and tests) can exercise the missing-file/unparseable/non-string-version
 * fallbacks without needing a broken real package.json on disk.
 */
export function resolveCliVersion(
  packageJsonPath: string = defaultPackageJsonPath(),
): string {
  if (!existsSync(packageJsonPath)) {
    return "unknown";
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface BuildInventoryParams {
  detection: ModeDetection;
  templateRoot: string;
  targetDir: string;
  survey: ProjectSurvey;
  conflicts: FileConflict[];
  packs: PackSurvey[];
  harnessGrade: HarnessGrade;
  toolchainGrade: ToolchainGrade;
  stagedBaseline: StagedBaseline;
  stagedPacks: StagedPack[];
}

/**
 * Returns new `FileConflict` objects whose `relPath` uses `/`, leaving the
 * caller's array and objects untouched (main.ts keeps the native form for
 * real file operations).
 */
function toPosixConflicts(conflicts: readonly FileConflict[]): FileConflict[] {
  return conflicts.map((c) => ({ ...c, relPath: toPosixPath(c.relPath) }));
}

/**
 * Builds the inventory object. Does not write anything -- see `writeInventory`.
 *
 * Exactly these paths use `/` on every platform: each `conflicts[].relPath`
 * and each `packs[].fileConflicts[].relPath`, normalized here once with
 * {@link toPosixPath}, plus `stagedBaseline.dir` (built by the caller as a
 * `/`-joined literal) and each `stagedBaseline.files[].path`/`.staged`
 * (already normalized by `stageBaselineAdditions` with the same
 * {@link toPosixPath}, so the conflict and staged paths agree), and
 * `stagedPacks` (passed through verbatim: `stagePacks` builds each `dir` as
 * a `/`-joined literal and normalizes every `path`/`staged` the same way).
 * The harness/toolchain conformance
 * summaries are computed from the normalized conflict paths. Every other
 * path -- `templateRoot`, `targetDir`, and every path inside `survey` -- is
 * passed through in the platform's native form. The caller's `conflicts` and
 * `packs` are never mutated; new objects are returned.
 *
 * @example
 * ```ts
 * const inventory = buildInventory({ detection, templateRoot, targetDir, survey,
 *   conflicts, packs, harnessGrade, toolchainGrade, stagedBaseline, stagedPacks });
 * inventory.conflicts[0]?.relPath; // "src/index.ts", even on Windows
 * ```
 */
export function buildInventory(params: BuildInventoryParams): Inventory {
  const conflicts = toPosixConflicts(params.conflicts);
  const packs = params.packs.map((pack): PackSurvey => ({
    ...pack,
    fileConflicts: toPosixConflicts(pack.fileConflicts),
  }));
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    cliVersion: resolveCliVersion(),
    generatedAt: new Date().toISOString(),
    modeSignal: params.detection.signal,
    templateRoot: params.templateRoot,
    targetDir: params.targetDir,
    survey: params.survey,
    conflicts,
    packs,
    harnessGrade: params.harnessGrade,
    harnessConformance: summarizeHarnessConformance(conflicts),
    toolchainGrade: params.toolchainGrade,
    toolchainConformance: summarizeToolchainConformance(conflicts),
    stagedBaseline: params.stagedBaseline,
    stagedPacks: params.stagedPacks,
  };
}

/**
 * Writes `inventory.json` into `groundworkDir`, creating it if needed.
 *
 * The write is atomic: the JSON goes to `inventory.json.tmp` first and is
 * renamed over `inventory.json` only once complete, so a reader never sees a
 * half-written file. On failure -- creating `groundworkDir` included -- the
 * temp file is removed (best effort: a
 * failed removal only warns, naming the temp file), any existing
 * `inventory.json` is left untouched, and an `Error` is thrown, with the
 * original failure as its `cause`, saying `.groundwork/` is incomplete and
 * the CLI should be re-run.
 *
 * @example
 * ```ts
 * const path = writeInventory(inventory, ".groundwork");
 * // path: ".groundwork/inventory.json"
 * ```
 */
export function writeInventory(
  inventory: Inventory,
  groundworkDir: string,
): string {
  const path = join(groundworkDir, "inventory.json");
  const tmpPath = `${path}.tmp`;
  try {
    mkdirSync(groundworkDir, { recursive: true });
    // Remove whatever already sits at the temp path (a crashed run's
    // leftover, or a symlink planted there), then create it exclusively:
    // "wx" fails rather than following a symlink raced in between.
    rmSync(tmpPath, { force: true });
    writeFileSync(tmpPath, `${JSON.stringify(inventory, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(tmpPath, path);
  } catch (cause) {
    try {
      rmSync(tmpPath, { force: true });
    } catch (cleanupError) {
      // Best effort: the write failure below is the error worth reporting,
      // so a failed cleanup only warns, naming the leftover file.
      console.warn(
        `warning: could not remove the temporary file ${tmpPath} -- delete it by hand (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
      );
    }
    throw new Error(
      `writing ${path} failed, so .groundwork/ is incomplete -- fix the cause and re-run the CLI`,
      { cause },
    );
  }
  return path;
}
