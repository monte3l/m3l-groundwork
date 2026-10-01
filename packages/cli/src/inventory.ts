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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StagedBaselineFile } from "./baseline-stage.js";
import type { CapCounts } from "./caps.js";
import type { FileConflict } from "./conflicts.js";
import { summarizeHarnessConformance } from "./harness/conformance.js";
import type { HarnessConformance } from "./harness/conformance.js";
import type { HarnessGrade } from "./harness/types.js";
import type { ModeDetection } from "./mode.js";
import type { PackWiring } from "./packs.js";
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
  templateRoot: string;
  targetDir: string;
  survey: ProjectSurvey;
  conflicts: FileConflict[];
  packs: PackSurvey[];
  /** Wiring integrity and rubric quality of the project's existing harness. Absent when schemaVersion is below 3. */
  harnessGrade: HarnessGrade;
  /** How far the existing harness has drifted from the baseline's -- information, never a defect. Absent when schemaVersion is below 3. */
  harnessConformance: HarnessConformance;
  /** Wiring integrity and rubric quality of the project's TypeScript toolchain. Absent when schemaVersion is below 4. */
  toolchainGrade: ToolchainGrade;
  /** How far the project's toolchain files have drifted from the baseline's -- information, never a defect. Absent when schemaVersion is below 4. */
  toolchainConformance: ToolchainConformance;
  /** The "absent" baseline files, copied verbatim as inert `<path>.staged` copies for `/customize` to install from. Absent when schemaVersion is below 5; `dir` is project-relative. */
  stagedBaseline: StagedBaseline;
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
}

/** Builds the inventory object. Does not write anything -- see `writeInventory`. */
export function buildInventory(params: BuildInventoryParams): Inventory {
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    cliVersion: resolveCliVersion(),
    generatedAt: new Date().toISOString(),
    modeSignal: params.detection.signal,
    templateRoot: params.templateRoot,
    targetDir: params.targetDir,
    survey: params.survey,
    conflicts: params.conflicts,
    packs: params.packs,
    harnessGrade: params.harnessGrade,
    harnessConformance: summarizeHarnessConformance(params.conflicts),
    toolchainGrade: params.toolchainGrade,
    toolchainConformance: summarizeToolchainConformance(params.conflicts),
    stagedBaseline: params.stagedBaseline,
  };
}

/** Writes `inventory.json` into `groundworkDir`, creating it if needed. */
export function writeInventory(
  inventory: Inventory,
  groundworkDir: string,
): string {
  mkdirSync(groundworkDir, { recursive: true });
  const path = join(groundworkDir, "inventory.json");
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`);
  return path;
}
