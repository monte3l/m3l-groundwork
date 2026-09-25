// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Loads pack manifests from `templates/packs/<name>/pack.json` and installs
 * a pack's files + JSON wiring into a freshly-bootstrapped project. Adopt
 * mode never calls `installPack` -- it surveys packs into the report
 * (`observeWiring`, `stagePackFiles`) and defers installation to
 * `/customize`, which reads a project's real gate runner before translating
 * a pack's wiring (see inventory.ts).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveAsset } from "./assets.js";
import type { CapCounts } from "./caps.js";
import { emitTemplate } from "./emit.js";
import { parseJsonc } from "./jsonc.js";
import {
  isRecord,
  mergePackageScripts,
  mergeSettingsHooks,
  mergeSettingsTopLevel,
  mergeVerifySteps,
} from "./merge-json.js";
import type {
  SettingsHooksFragment,
  SettingsTopLevelFragment,
  VerifyStepAddition,
} from "./merge-json.js";
import type { TokenTable } from "./tokens.js";

export interface PackWiring {
  settings: SettingsHooksFragment;
  /** Top-level `.claude/settings.json` keys that aren't hook registrations (`statusLine`). Optional: packs that only register hooks omit it. */
  settingsTopLevel?: SettingsTopLevelFragment;
  packageScripts: Record<string, string>;
  verifySteps: VerifyStepAddition[];
}

export interface PackManifest {
  schemaVersion: number;
  name: string;
  description: string;
  modes: string[];
  budget: CapCounts;
  requires: { paths: string[] } | undefined;
  wiring: PackWiring;
  adoptNotes: string | undefined;
}

export interface Pack {
  manifest: PackManifest;
  filesDir: string;
}

/** `templates/packs`, resolved the same way `templatesCoreDir()` resolves `templates/core`. */
export function packsRootDir(): string {
  return resolveAsset({ repo: "templates/packs", local: "templates/packs" });
}

/** Names of every pack directory that has a `pack.json` under `root`, sorted for deterministic install order. `root` defaults to `templates/packs`, overridable for tests. */
export function listPackNames(root: string = packsRootDir()): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, entry.name, "pack.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

/** A pack's own `name` becomes a path segment under `.groundwork/packs/`, so it must be a bare lowercase identifier: no separators, no `..`. */
const PACK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const CAP_KEYS = [
  "agents",
  "skills",
  "hooks",
  "workflows",
  "scripts",
] as const satisfies readonly (keyof CapCounts)[];

/** True when `budget` has an own non-negative integer for every {@link CapCounts} key (one read per key). */
function isValidBudget(budget: unknown): budget is CapCounts {
  if (!isRecord(budget)) return false;
  return CAP_KEYS.every((key) => {
    if (!Object.hasOwn(budget, key)) return false;
    const value: unknown = budget[key];
    return Number.isInteger(value) && (value as number) >= 0;
  });
}

/** Loads and validates one pack's manifest from under `root` (default `templates/packs`, overridable for tests). Throws, naming the available packs, if unknown or malformed. */
export function loadPack(name: string, root: string = packsRootDir()): Pack {
  const packDir = join(root, name);
  const manifestPath = join(packDir, "pack.json");

  if (!existsSync(manifestPath)) {
    const available = listPackNames(root);
    throw new Error(
      `unknown pack "${name}" -- available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
  }

  const parsed = parseJsonc(readFileSync(manifestPath, "utf8"));
  if (!parsed.ok) {
    throw new Error(
      `pack "${name}": pack.json failed to parse -- ${parsed.error}`,
    );
  }

  const manifest = parsed.value as PackManifest;
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `pack "${name}": unsupported pack.json schemaVersion ${JSON.stringify(manifest.schemaVersion)}`,
    );
  }
  const manifestName: unknown = manifest.name;
  if (
    typeof manifestName !== "string" ||
    !PACK_NAME_PATTERN.test(manifestName)
  ) {
    throw new Error(
      `pack "${name}": pack.json's pack name ${JSON.stringify(manifestName)} must match ${String(PACK_NAME_PATTERN)} (a bare lowercase identifier, no path separators)`,
    );
  }
  const modes: unknown = manifest.modes;
  if (
    !Array.isArray(modes) ||
    modes.length === 0 ||
    !modes.every((mode) => typeof mode === "string")
  ) {
    throw new Error(
      `pack "${name}": pack.json's modes must be a non-empty array of strings`,
    );
  }
  const wiring: unknown = manifest.wiring;
  if (!isRecord(wiring)) {
    throw new Error(`pack "${name}": pack.json's wiring must be an object`);
  }
  const budget: unknown = manifest.budget;
  if (!isValidBudget(budget)) {
    throw new Error(
      `pack "${name}": pack.json's budget must set ${CAP_KEYS.join(", ")} to non-negative integers`,
    );
  }
  // stagePackFiles keys its staging path (and its rmSync cleanup) on
  // manifest.name, so a mismatch would let two pack directories collide.
  if (manifestName !== name) {
    throw new Error(
      `pack "${name}": pack.json's name "${manifestName}" does not match its directory name "${name}"`,
    );
  }

  return { manifest, filesDir: join(packDir, "files") };
}

function readJsonOrThrow(path: string): unknown {
  const parsed = parseJsonc(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    throw new Error(`${path} failed to parse -- ${parsed.error}`);
  }
  return parsed.value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Serializes `bin/lib/verify-steps.packs.json` to match exactly what
 * Prettier would produce for this shape: every field one per line except
 * `cmd`, whose short array of strings Prettier collapses onto a single
 * line when it fits within printWidth. `JSON.stringify(value, null, 2)`
 * never collapses an array, so writing this file through the generic
 * `writeJson` would fail `prettier --check` on every install. This printer
 * is scoped to exactly the one shape `VerifyStepAddition[]` has -- it is
 * not a general JSON formatter.
 */
function writeVerifyStepsPacksJson(
  path: string,
  steps: VerifyStepAddition[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  if (steps.length === 0) {
    writeFileSync(path, "[]\n");
    return;
  }
  const lines = ["["];
  steps.forEach((step, index) => {
    const comma = index < steps.length - 1 ? "," : "";
    lines.push(
      "  {",
      `    "id": ${JSON.stringify(step.id)},`,
      `    "group": ${JSON.stringify(step.group)},`,
      `    "name": ${JSON.stringify(step.name)},`,
      `    "cmd": [${step.cmd.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      `  }${comma}`,
    );
  });
  lines.push("]");
  writeFileSync(path, lines.join("\n") + "\n");
}

export interface PackInstallResult {
  filesWritten: string[];
  budget: CapCounts;
}

/**
 * Installs one pack into a target directory that already has the baseline
 * emitted (fresh mode only). Copies `files/` via the existing `emitTemplate`
 * unchanged, checks `requires.paths` against the just-emitted tree, then
 * applies the pack's three JSON wiring merges.
 */
export function installPack(
  pack: Pack,
  targetDir: string,
  tokens: TokenTable,
): PackInstallResult {
  const { manifest, filesDir } = pack;

  for (const relPath of manifest.requires?.paths ?? []) {
    if (!existsSync(join(targetDir, relPath))) {
      throw new Error(
        `pack "${manifest.name}" requires "${relPath}", which is missing from the target -- install the baseline first`,
      );
    }
  }

  const { filesWritten } = emitTemplate(filesDir, targetDir, tokens);

  const settingsPath = join(targetDir, ".claude", "settings.json");
  const existingSettings = existsSync(settingsPath)
    ? readJsonOrThrow(settingsPath)
    : {};
  let settings: unknown = existingSettings;
  // Only touch the hooks block when the pack registers hooks: merging an empty
  // fragment would still write an empty `hooks: {}` into a settings file that
  // had none.
  if (Object.keys(manifest.wiring.settings).length > 0) {
    settings = mergeSettingsHooks(settings, manifest.wiring.settings);
  }
  settings = mergeSettingsTopLevel(
    settings,
    manifest.wiring.settingsTopLevel ?? {},
  );
  writeJson(settingsPath, settings);

  if (Object.keys(manifest.wiring.packageScripts).length > 0) {
    const pkgPath = join(targetDir, "package.json");
    const pkg = readJsonOrThrow(pkgPath) as Record<string, unknown>;
    const { scripts, collisions } = mergePackageScripts(
      pkg["scripts"] as Record<string, string> | undefined,
      manifest.wiring.packageScripts,
    );
    if (collisions.length > 0) {
      throw new Error(
        `pack "${manifest.name}": package.json script collision(s): ${collisions.map((c) => c.name).join(", ")}`,
      );
    }
    pkg["scripts"] = scripts;
    writeJson(pkgPath, pkg);
  }

  if (manifest.wiring.verifySteps.length > 0) {
    const stepsPath = join(targetDir, "bin", "lib", "verify-steps.packs.json");
    const existingSteps = existsSync(stepsPath)
      ? readJsonOrThrow(stepsPath)
      : [];
    writeVerifyStepsPacksJson(
      stepsPath,
      mergeVerifySteps(existingSteps, manifest.wiring.verifySteps),
    );
  }

  return { filesWritten, budget: manifest.budget };
}

/**
 * Copies a pack's `pack.json` + `files/` tree, unmodified, into
 * `<groundworkDir>/packs/<name>/` -- adopt mode's staging area. `/customize`
 * installs from this self-contained copy rather than from `templateRoot`
 * (an absolute path that may not exist by the time it runs). Token
 * substitution is a no-op here (`{}`): staging a project's real name into
 * pack content is `/customize`'s job, not this offline copy's.
 */
export function stagePackFiles(pack: Pack, groundworkDir: string): string[] {
  const destDir = join(groundworkDir, "packs", pack.manifest.name);
  // Clear a previous staging first, so a file a newer pack version dropped
  // doesn't linger beside the current payload.
  rmSync(join(destDir, "files"), { recursive: true, force: true });
  const { filesWritten } = emitTemplate(
    pack.filesDir,
    join(destDir, "files"),
    {},
  );
  writeJson(join(destDir, "pack.json"), pack.manifest);
  return [...filesWritten.map((f) => join("files", f)), "pack.json"];
}

/**
 * Index-level, adopt-mode-only facts about how a pack's wiring would land
 * against a real project's current `.claude/settings.json` and
 * `bin/lib/verify-steps.packs.json` -- never a verdict on whether it will
 * work. That verdict is a judgment call for `/customize`'s Step 0 (the
 * adopt-mode reconcile step in `/customize`) to make after reading the
 * project's real gate runner and hook config.
 */
export function observeWiring(
  targetDir: string,
  manifest: PackManifest,
): string[] {
  const observations: string[] = [];

  const settingsPath = join(targetDir, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    observations.push("no .claude/settings.json found");
  } else {
    const parsed = parseJsonc(readFileSync(settingsPath, "utf8"));
    if (!parsed.ok || !isRecord(parsed.value)) {
      observations.push(".claude/settings.json exists but could not be parsed");
    } else {
      const hooks = parsed.value["hooks"];
      for (const event of Object.keys(manifest.wiring.settings)) {
        const existingEntries = isRecord(hooks) ? hooks[event] : undefined;
        observations.push(
          Array.isArray(existingEntries) && existingEntries.length > 0
            ? `.claude/settings.json already has a "${event}" entry (${existingEntries.length} registration(s))`
            : `.claude/settings.json has no "${event}" entry yet`,
        );
      }
      for (const key of Object.keys(manifest.wiring.settingsTopLevel ?? {})) {
        observations.push(
          key in parsed.value
            ? `.claude/settings.json already sets a top-level "${key}" -- installing this pack would collide with it, so replacing it is a decision for the user`
            : `.claude/settings.json has no top-level "${key}" yet`,
        );
      }
    }
  }

  if (existsSync(join(targetDir, ".claude", "settings.local.json"))) {
    observations.push(
      ".claude/settings.local.json is present and may shadow a merged hook entry",
    );
  }

  if (manifest.wiring.verifySteps.length > 0) {
    const stepsPath = join(targetDir, "bin", "lib", "verify-steps.packs.json");
    observations.push(
      existsSync(stepsPath)
        ? "bin/lib/verify-steps.packs.json exists"
        : "no bin/lib/verify-steps.packs.json found -- no bin/verify.mjs-shaped gate runner detected",
    );
  }

  return observations;
}
