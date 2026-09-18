/**
 * Serializes a survey + conflict plan into `.groundwork/inventory.json` --
 * the machine-readable handoff `/customize`'s Step 0 reads instead of
 * re-deriving the survey itself. Schema-versioned so a future CLI release
 * can tell an old inventory apart from a current one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileConflict } from "./conflicts.js";
import type { ModeDetection } from "./mode.js";
import type { ProjectSurvey } from "./survey/survey.js";

export const INVENTORY_SCHEMA_VERSION = 1;

export interface Inventory {
  schemaVersion: number;
  cliVersion: string;
  generatedAt: string;
  modeSignal: string;
  templateRoot: string;
  targetDir: string;
  survey: ProjectSurvey;
  conflicts: FileConflict[];
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
