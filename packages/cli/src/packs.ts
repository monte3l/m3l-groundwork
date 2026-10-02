// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Loads pack manifests from `templates/packs/<name>/pack.json` and installs
 * a pack's files + JSON wiring into a freshly-bootstrapped project. Adopt
 * mode never calls `installPack` -- it surveys packs into the report
 * (`observeWiring`; `pack-stage.ts`'s `stagePacks` stages them, inert) and
 * defers installation to `/customize`, which reads a project's real gate
 * runner before translating a pack's wiring (see inventory.ts). Both modes call `loadPack` for every
 * pack they handle (fresh mode: each `--pack`; adopt mode: every pack)
 * before writing anything, and `loadPack` refuses a prototype-sensitive
 * key in `wiring.settings`, `wiring.settingsTopLevel` or
 * `wiring.packageScripts`, so such a pack is neither installed nor staged.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveAsset } from "./assets.js";
import type { CapCounts } from "./caps.js";
import { emitTemplate } from "./emit.js";
import { parseJsonc } from "./jsonc.js";
import {
  probePath,
  readFailure,
  recordedReadCode,
  unreadableNote,
} from "./survey/internal/read-guard.js";
import {
  isPrototypeSensitiveKey,
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

/** The two CLI modes a pack's `modes` may name (see mode.ts). */
const PACK_MODES: readonly string[] = ["fresh", "adopt"];

/** The `bin/lib/verify-steps.mjs` groups a pack's verify step may join. */
const VERIFY_GROUPS: readonly string[] = [
  "format",
  "lint",
  "typecheck",
  "build",
  "test",
];

/** Throws, naming the entry's 0-based `index` and the offending field, when one `wiring.verifySteps[]` entry isn't an object, lacks a string `id`/`name`, lacks a non-empty string-array `cmd`, or names an unknown `group`. Each field is read once into a local before it is checked. */
function assertValidVerifyStep(
  name: string,
  step: unknown,
  index: number,
): void {
  const where = `pack "${name}": pack.json's wiring.verifySteps[${String(index)}]`;
  if (!isRecord(step)) {
    throw new Error(
      `${where} must be an object, got ${String(JSON.stringify(step))}`,
    );
  }
  for (const key of ["id", "name"] as const) {
    const value: unknown = Object.hasOwn(step, key) ? step[key] : undefined;
    if (typeof value !== "string") {
      throw new Error(
        `${where}.${key} must be a string, got ${String(JSON.stringify(value))}`,
      );
    }
  }
  const cmd: unknown = Object.hasOwn(step, "cmd") ? step["cmd"] : undefined;
  if (
    !Array.isArray(cmd) ||
    cmd.length === 0 ||
    !(cmd as unknown[]).every((part) => typeof part === "string")
  ) {
    throw new Error(
      `${where}.cmd must be a non-empty array of strings, got ${String(JSON.stringify(cmd))}`,
    );
  }
  const group: unknown = Object.hasOwn(step, "group")
    ? step["group"]
    : undefined;
  if (typeof group !== "string" || !VERIFY_GROUPS.includes(group)) {
    throw new Error(
      `${where} group ${String(JSON.stringify(group))} must be one of ${VERIFY_GROUPS.join(", ")}`,
    );
  }
}

/**
 * Throws, naming the pack, the field and the key, when one of `fragment`'s own
 * enumerable keys is prototype-sensitive ({@link isPrototypeSensitiveKey}).
 * `Object.keys` sees a `__proto__` key here because `parseJsonc`, like
 * `JSON.parse`, creates it as an ordinary own data property. Only the
 * fragment's own top-level keys are checked: they are the names a merge
 * writes, while everything nested below them is an opaque value.
 */
function assertNoPrototypeSensitiveKeys(
  name: string,
  field: string,
  fragment: Record<string, unknown>,
): void {
  for (const key of Object.keys(fragment)) {
    if (isPrototypeSensitiveKey(key)) {
      throw new Error(
        `pack "${name}": pack.json's wiring.${field} must not use the prototype-sensitive key ${JSON.stringify(key)}`,
      );
    }
  }
}

/**
 * Throws, naming the offending key or value, when `wiring.settings`/`packageScripts` is missing or isn't an object, `verifySteps` is missing or isn't an array, any `verifySteps[]` entry is malformed (see {@link assertValidVerifyStep}), or `settings`, `packageScripts` or (when it is an object) `settingsTopLevel` has a prototype-sensitive own key (see {@link assertNoPrototypeSensitiveKeys}).
 * Those three are the only wiring fields whose keys a merge writes; `verifySteps` ids are values. An absent or non-object `settingsTopLevel` is not rejected here.
 */
function assertValidWiringShape(
  name: string,
  wiring: Record<string, unknown>,
): void {
  for (const key of ["settings", "packageScripts"] as const) {
    const value: unknown = Object.hasOwn(wiring, key) ? wiring[key] : undefined;
    if (!isRecord(value)) {
      throw new Error(
        `pack "${name}": pack.json's wiring.${key} must be an object`,
      );
    }
    assertNoPrototypeSensitiveKeys(name, key, value);
  }
  const topLevel: unknown = Object.hasOwn(wiring, "settingsTopLevel")
    ? wiring["settingsTopLevel"]
    : undefined;
  if (isRecord(topLevel)) {
    assertNoPrototypeSensitiveKeys(name, "settingsTopLevel", topLevel);
  }
  const steps: unknown = Object.hasOwn(wiring, "verifySteps")
    ? wiring["verifySteps"]
    : undefined;
  if (!Array.isArray(steps)) {
    throw new Error(
      `pack "${name}": pack.json's wiring.verifySteps must be an array`,
    );
  }
  (steps as unknown[]).forEach((step, index) => {
    assertValidVerifyStep(name, step, index);
  });
}

/** Loads and validates one pack's manifest from under `root` (default `templates/packs`, overridable for tests). Throws, naming the available packs, if unknown; throws naming the pack and the problem if malformed, including a prototype-sensitive key in its wiring (see {@link assertValidWiringShape}). */
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

  const raw: unknown = parsed.value;
  if (!isRecord(raw)) {
    throw new Error(
      `pack "${name}": pack.json must be an object, got ${String(JSON.stringify(raw))}`,
    );
  }
  const manifest = raw as unknown as PackManifest;
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
  const badMode = modes.find((mode) => !PACK_MODES.includes(mode));
  if (badMode !== undefined) {
    throw new Error(
      `pack "${name}": pack.json's mode ${JSON.stringify(badMode)} must be one of ${PACK_MODES.join(", ")}`,
    );
  }
  const wiring: unknown = manifest.wiring;
  if (!isRecord(wiring)) {
    throw new Error(`pack "${name}": pack.json's wiring must be an object`);
  }
  assertValidWiringShape(name, wiring);
  const budget: unknown = manifest.budget;
  if (!isValidBudget(budget)) {
    throw new Error(
      `pack "${name}": pack.json's budget must set ${CAP_KEYS.join(", ")} to non-negative integers`,
    );
  }
  // pack-stage.ts's stagePacks keys each pack's staging directory on
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
 * Reads `.claude/settings.json` for {@link observeWiring}. A failure that is
 * a fact about the project's own tree -- a permission failure
 * (`EACCES`/`EPERM`), a directory at the path (`EISDIR`), the file vanishing
 * after the exists probe or a dangling symlink (`ENOENT`), a symlink loop
 * (`ELOOP`) -- is recorded as an observation naming the path and errno, and
 * once in `undetermined` (so the adoption report shows it), and `undefined`
 * is returned; any other errno is about the machine and throws, naming the
 * path with the original failure as `cause`.
 */
function readSettingsOrObserve(
  settingsPath: string,
  observations: string[],
  undetermined: string[],
): string | undefined {
  try {
    return readFileSync(settingsPath, "utf8");
  } catch (error) {
    const code = recordedReadCode(error);
    if (code === undefined) throw readFailure(settingsPath, error);
    observations.push(
      `.claude/settings.json (${settingsPath}) exists but could not be read (${code})`,
    );
    // Called once per pack against the same file: record the note once.
    const note = unreadableNote(settingsPath, code);
    if (!undetermined.includes(note)) undetermined.push(note);
    return undefined;
  }
}

/**
 * Whether `path` exists, for {@link observeWiring}. A real `stat`, never
 * `existsSync`, so a file under a directory this process cannot search is
 * not observed as missing: an `EACCES`/`EPERM`/`ELOOP` is recorded as an
 * observation naming the path and errno, and `undefined` is returned so the
 * caller states neither "found" nor "not found". `ENOENT`/`ENOTDIR` answers
 * `false`; any other errno throws (see `probePath`).
 */
function existsOrObserve(
  path: string,
  observations: string[],
): boolean | undefined {
  const probe = probePath(path);
  if (probe.kind === "unresolvable") {
    observations.push(
      `could not check whether ${path} exists (${probe.code}) -- left undetermined, not reported missing`,
    );
    return undefined;
  }
  return probe.kind === "present";
}

/**
 * Index-level, adopt-mode-only facts about how a pack's wiring would land
 * against a real project's current `.claude/settings.json` and
 * `bin/lib/verify-steps.packs.json` -- never a verdict on whether it will
 * work. That verdict is a judgment call for `/customize`'s Step 0 (the
 * adopt-mode reconcile step in `/customize`) to make after reading the
 * project's real gate runner and hook config. A path this process cannot
 * reach (`EACCES`/`EPERM`/`ELOOP`) is observed with its errno, never as
 * "not found". A `.claude/settings.json` that exists but cannot be read for
 * a reason that is a property of the project's tree (`EACCES`/`EPERM`,
 * `EISDIR`, `ENOENT`, `ELOOP`) is observed with its errno and also recorded
 * once in `undetermined` -- adopt mode passes the survey's own list, so the
 * report shows it; any other errno throws.
 *
 * @example
 * ```ts
 * const undetermined: string[] = [];
 * const observations = observeWiring(targetDir, pack.manifest, undetermined);
 * ```
 */
export function observeWiring(
  targetDir: string,
  manifest: PackManifest,
  undetermined: string[] = [],
): string[] {
  const observations: string[] = [];

  const settingsPath = join(targetDir, ".claude", "settings.json");
  const settingsExists = existsOrObserve(settingsPath, observations);
  if (settingsExists === false) {
    observations.push("no .claude/settings.json found");
  } else if (settingsExists) {
    const content = readSettingsOrObserve(
      settingsPath,
      observations,
      undetermined,
    );
    const parsed = content === undefined ? undefined : parseJsonc(content);
    if (parsed === undefined) {
      // Unreadable -- already recorded as an observation.
    } else if (!parsed.ok || !isRecord(parsed.value)) {
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

  if (
    existsOrObserve(
      join(targetDir, ".claude", "settings.local.json"),
      observations,
    ) === true
  ) {
    observations.push(
      ".claude/settings.local.json is present and may shadow a merged hook entry",
    );
  }

  if (manifest.wiring.verifySteps.length > 0) {
    const stepsPath = join(targetDir, "bin", "lib", "verify-steps.packs.json");
    const stepsExist = existsOrObserve(stepsPath, observations);
    if (stepsExist !== undefined) {
      observations.push(
        stepsExist
          ? "bin/lib/verify-steps.packs.json exists"
          : "no bin/lib/verify-steps.packs.json found -- no bin/verify.mjs-shaped gate runner detected",
      );
    }
  }

  return observations;
}
