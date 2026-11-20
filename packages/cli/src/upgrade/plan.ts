// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's plan step, minus its writes: {@link renderRelease}
 * renders this CLI's release (baseline plus the manifest's packs, with the
 * manifest's tokens) into a temporary directory and builds the manifest it
 * would record, and {@link computePlan} compares the project against both
 * manifests, read-only, and classifies every baseline path and JSON key with
 * {@link classifyAll}. This module never imports `main.ts` (which will import
 * it), so the template roots are parameters.
 */
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPosixPath } from "../assets.js";
import { emitTemplate } from "../emit.js";
import {
  buildManifest,
  isProjectRelativePath,
  parseJsonKeys,
  sha256Hex,
} from "../manifest.js";
import type { JsonKeysResult, Manifest } from "../manifest.js";
import { installPack, listPackNames, loadPack } from "../packs.js";
import { isAbsentError } from "../survey/internal/read-guard.js";
import { REQUIRED_TOKEN_KEYS } from "../tokens.js";
import { classifyAll } from "./classify.js";
import type { Recorded, UpgradeClass } from "./classify.js";

/**
 * A release rendered by {@link renderRelease}: the temporary directory that
 * holds it, the manifest a fresh bootstrap of it would record, and the one
 * way to remove the directory.
 *
 * @example
 * ```ts
 * import type { RenderedRelease } from "./upgrade/plan.js";
 *
 * const describe = (release: RenderedRelease): string =>
 *   `${String(Object.keys(release.manifest.files).length)} files in ${release.dir}`;
 * ```
 */
export interface RenderedRelease {
  /** The absolute path of the temporary directory holding the release. */
  readonly dir: string;
  /** The manifest built from the rendered files, packs included. */
  readonly manifest: Manifest;
  /**
   * Removes {@link RenderedRelease.dir} recursively; safe to call twice, and
   * never throws: a failed removal warns on stderr, naming the leftover
   * directory.
   */
  readonly dispose: () => void;
}

/**
 * The three hashes an entry carries, each an own property only when it
 * exists. A type alias, not an interface, so an entry stays assignable to
 * `Record<string, unknown>` (an interface has no implicit index signature).
 */
type EntryHashes = {
  readonly recordedSha256?: string;
  readonly currentSha256?: string;
  readonly nextSha256?: string;
};

/**
 * One classified file of an {@link UpgradePlan}. Each hash is present only
 * when it exists: `recordedSha256` from the project's manifest,
 * `currentSha256` from the project file, `nextSha256` from the new release.
 * Module-private: a consumer names it as `UpgradePlan["files"][number]`.
 *
 * @example
 * ```ts
 * import type { UpgradePlan } from "./upgrade/plan.js";
 *
 * const entry: UpgradePlan["files"][number] = { path: "CLAUDE.md", class: "add", nextSha256: "0".repeat(64) };
 * ```
 */
type PlanEntry = {
  readonly path: string;
  readonly class: UpgradeClass;
} & EntryHashes;

/**
 * One classified JSON key of an {@link UpgradePlan}, named by its JSON
 * Pointer. The hashes follow {@link PlanEntry}'s presence rule.
 * Module-private: a consumer names it as
 * `UpgradePlan["jsonKeys"][string][number]`.
 *
 * @example
 * ```ts
 * import type { UpgradePlan } from "./upgrade/plan.js";
 *
 * const entry: UpgradePlan["jsonKeys"][string][number] = { pointer: "/scripts/test", class: "add", nextSha256: "0".repeat(64) };
 * ```
 */
type JsonKeyEntry = {
  readonly pointer: string;
  readonly class: UpgradeClass;
} & EntryHashes;

/**
 * The result of {@link computePlan}: plain JSON (no `Map`, no `undefined`),
 * deterministic for the same inputs. `files` is sorted by path in code-unit
 * order; `jsonKeys` maps a JSON file's path to its entries sorted by pointer
 * and holds only files with at least one recorded or next pointer. A file's
 * own class in `files` is what decides its fate; its `jsonKeys` entries only
 * matter when the file is present in the project and holds a JSON object.
 *
 * @example
 * ```ts
 * import type { UpgradePlan } from "./upgrade/plan.js";
 *
 * const conflicts = (plan: UpgradePlan): string[] =>
 *   plan.files.filter((e) => e.class.startsWith("conflict")).map((e) => e.path);
 * ```
 */
export interface UpgradePlan {
  readonly schemaVersion: 1;
  readonly fromCliVersion: string;
  readonly toCliVersion: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly packs: readonly string[];
  readonly files: readonly PlanEntry[];
  readonly jsonKeys: Readonly<Record<string, readonly JsonKeyEntry[]>>;
}

/** The schema of the plan {@link computePlan} returns. */
const PLAN_SCHEMA_VERSION = 1;

/** A thrown value as text: an `Error`'s message, anything else stringified. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Packs as fresh mode installs and records them: de-duplicated, sorted. */
function normalisePacks(packs: readonly string[]): string[] {
  return [...new Set(packs)].sort();
}

/**
 * Refuses a token table whose keys are not exactly {@link REQUIRED_TOKEN_KEYS},
 * each a non-empty string. The message names keys only, never a value.
 */
function assertManifestTokens(tokens: Readonly<Record<string, string>>): void {
  const required: ReadonlySet<string> = new Set(REQUIRED_TOKEN_KEYS);
  const problems: string[] = [];
  for (const key of REQUIRED_TOKEN_KEYS) {
    const value: unknown = Object.hasOwn(tokens, key) ? tokens[key] : undefined;
    if (value === undefined) {
      problems.push(`${key} is missing`);
    } else if (typeof value !== "string" || value === "") {
      problems.push(`${key} is empty`);
    }
  }
  for (const key of Object.keys(tokens)) {
    if (!required.has(key))
      problems.push(`${JSON.stringify(key)} is unexpected`);
  }
  if (problems.length > 0) {
    throw new Error(
      `the manifest's tokens must be exactly ${REQUIRED_TOKEN_KEYS.join(" and ")}, each a non-empty string: ${problems.join("; ")}`,
    );
  }
}

/** Removes `dir`, reporting (never throwing) a failure as text for the caller's message. */
function removeQuietly(dir: string): string {
  try {
    rmSync(dir, { recursive: true, force: true });
    return "";
  } catch (cleanupError) {
    // Best effort: the render failure is the error worth throwing, so a
    // failed cleanup is reported in its message rather than replacing it.
    return `; the temporary directory ${dir} could not be removed -- delete it by hand (${errorText(cleanupError)})`;
  }
}

/**
 * Renders the release this CLI ships for `manifest`: the baseline under
 * `templatesDir`, then the manifest's packs from `packsRoot` in sorted,
 * de-duplicated order (as fresh mode installs them), all with
 * `manifest.tokens` (never the current year), into a new
 * `groundwork-upgrade-*` directory under `tmpRoot` (the OS temp directory by
 * default). Its manifest is built as fresh mode builds one, stamped with
 * `cliVersion`. Writes nothing outside that directory. The directory stays
 * until `dispose` is called: a forgotten `dispose` leaks the rendered tree
 * under the temp directory, and a process killed mid-render can leave a
 * partial one behind.
 *
 * @param params - The project's manifest, this CLI's version, the template
 *   roots and an optional parent for the temporary directory.
 * @returns The rendered release; call `dispose` when done with it.
 * @throws `Error` naming the offending keys (never a value) when
 *   `manifest.tokens` is not exactly `PROJECT_NAME` and `YEAR`, each a
 *   non-empty string, and `Error` naming a pack recorded in the manifest but
 *   missing from this release; both before anything is created.
 * @throws `Error` with the original failure as `cause` when the temporary
 *   directory cannot be created, or when rendering fails, after removing the
 *   directory (a failed removal is named in the message).
 *
 * @example
 * ```ts
 * import { renderRelease } from "./upgrade/plan.js";
 *
 * const release = renderRelease({ manifest, cliVersion: "1.4.0", templatesDir, packsRoot });
 * try {
 *   console.log(Object.keys(release.manifest.files).length);
 * } finally {
 *   release.dispose();
 * }
 * ```
 */
export function renderRelease(params: {
  readonly manifest: Manifest;
  readonly cliVersion: string;
  readonly templatesDir: string;
  readonly packsRoot: string;
  readonly tmpRoot?: string;
}): RenderedRelease {
  const { manifest, cliVersion, templatesDir, packsRoot } = params;
  assertManifestTokens(manifest.tokens);
  const packs = normalisePacks(manifest.packs);
  const available = new Set(listPackNames(packsRoot));
  for (const name of packs) {
    if (!available.has(name)) {
      throw new Error(
        `pack "${name}" is recorded in the manifest but missing from this release (${cliVersion})`,
      );
    }
  }

  const root = params.tmpRoot ?? tmpdir();
  let dir: string;
  try {
    dir = mkdtempSync(join(root, "groundwork-upgrade-"));
  } catch (cause) {
    throw new Error(`could not create a temporary directory under ${root}`, {
      cause,
    });
  }

  let next: Manifest;
  try {
    const files = [
      ...emitTemplate(templatesDir, dir, manifest.tokens).filesWritten,
    ];
    for (const name of packs) {
      const pack = loadPack(name, packsRoot);
      files.push(...installPack(pack, dir, manifest.tokens).filesWritten);
    }
    next = buildManifest({
      targetDir: dir,
      cliVersion,
      tokens: manifest.tokens,
      packs,
      files: [...new Set(files.map(toPosixPath))],
    });
  } catch (cause) {
    const leftover = removeQuietly(dir);
    throw new Error(
      `could not render the ${cliVersion} release: ${errorText(cause)}${leftover}`,
      { cause },
    );
  }

  const rendered = dir;
  return {
    dir: rendered,
    manifest: next,
    dispose: (): void => {
      try {
        rmSync(rendered, { recursive: true, force: true });
      } catch (error) {
        // Never throw from cleanup: a caller's `finally { dispose() }` must
        // not mask the error that got it there.
        console.warn(
          `warning: could not remove the temporary directory ${rendered} -- delete it by hand (${errorText(error)})`,
        );
      }
    },
  };
}

/** `lstat` without following a link; `undefined` when nothing is there. */
function inspect(abs: string, relPath: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false });
  } catch (cause) {
    if (isAbsentError(cause)) return undefined;
    throw new Error(`could not inspect ${relPath} in the project`, { cause });
  }
}

/**
 * The bytes of the project file at `relPath`, or `undefined` when it (or an
 * ancestor directory) is missing. Each component is `lstat`ed and never
 * followed: a symlink anywhere on the way, a non-directory ancestor or a
 * non-regular file is refused, naming the path.
 */
function readProjectFile(
  targetDir: string,
  relPath: string,
  checkedDirs: Set<string>,
): Buffer | undefined {
  if (!isProjectRelativePath(relPath)) {
    throw new Error(
      `refusing to plan ${JSON.stringify(relPath)}: not a relative, /-separated path inside the project`,
    );
  }
  const segments = relPath.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    const dirRel = segments.slice(0, depth).join("/");
    if (checkedDirs.has(dirRel)) continue;
    const stat = inspect(join(targetDir, dirRel), dirRel);
    if (stat === undefined) return undefined;
    // `lstat` never reports a symlink as a directory, so this refuses both.
    if (!stat.isDirectory()) {
      throw new Error(
        `refusing to plan ${relPath}: ${dirRel} is a symlink or not a directory -- replace it with a real directory`,
      );
    }
    checkedDirs.add(dirRel);
  }
  const abs = join(targetDir, relPath);
  const stat = inspect(abs, relPath);
  if (stat === undefined) return undefined;
  if (!stat.isFile()) {
    throw new Error(
      `refusing to plan ${relPath}: it is a symlink, a directory or another non-regular file -- replace it with a regular file`,
    );
  }
  try {
    return readFileSync(abs);
  } catch (cause) {
    throw new Error(`could not read ${relPath} in the project`, { cause });
  }
}

/**
 * The current per-key hashes of a JSON file, `{}` when it is absent. A file
 * that does not parse, or parses to anything but an object, is refused
 * naming the path with no `cause`: the parser's message can quote the file.
 */
function currentJsonKeys(
  relPath: string,
  bytes: Buffer | undefined,
): Record<string, string> {
  if (bytes === undefined) return {};
  let parsed: JsonKeysResult;
  try {
    parsed = parseJsonKeys(bytes.toString("utf8"));
  } catch (cause) {
    // Only hashing can throw here (a parse failure is returned): a stack
    // overflow on a deeply nested value, whose message holds no file text.
    throw new Error(
      `could not hash the JSON keys of ${relPath} in the project`,
      {
        cause,
      },
    );
  }
  if (!parsed.ok) {
    throw new Error(`could not parse ${relPath} in the project as JSON`);
  }
  if (!parsed.isObject) {
    throw new Error(
      `refusing to plan ${relPath}: it must hold a JSON object -- restore its top-level object`,
    );
  }
  return parsed.keys;
}

/** A record's own entries as a `Map`, so a `__proto__` key stays ordinary. */
function toMap<V>(
  record: Readonly<Record<string, V>> | undefined,
): Map<string, V> {
  return new Map(record === undefined ? [] : Object.entries(record));
}

/** The three optional hashes, each spread in only when present. */
function hashes(
  recorded: string | undefined,
  current: string | undefined,
  next: string | undefined,
): EntryHashes {
  return {
    ...(recorded !== undefined ? { recordedSha256: recorded } : {}),
    ...(current !== undefined ? { currentSha256: current } : {}),
    ...(next !== undefined ? { nextSha256: next } : {}),
  };
}

/** An own-property read of `record[key]`, never reaching the prototype. */
function own<V>(
  record: Readonly<Record<string, V>>,
  key: string,
): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Whether two token tables hold the same keys with the same values. */
function sameTokens(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, i) => key === bKeys[i] && own(a, key) === own(b, key))
  );
}

/**
 * Refuses a `release` that was not rendered for this plan: another CLI
 * version than `cliVersion`, other tokens than the manifest's (no value is
 * named), or another sorted, de-duplicated pack list.
 */
function assertReleaseMatches(
  manifest: Manifest,
  release: RenderedRelease,
  cliVersion: string,
): void {
  const next = release.manifest;
  if (next.cliVersion !== cliVersion) {
    throw new Error(
      `the release was rendered for CLI version ${next.cliVersion}, not ${cliVersion} -- render it with this CLI's version`,
    );
  }
  if (!sameTokens(next.tokens, manifest.tokens)) {
    throw new Error(
      "the release was rendered with other tokens than the manifest's -- render it from the same manifest",
    );
  }
  const recordedPacks = normalisePacks(manifest.packs);
  const releasePacks = normalisePacks(next.packs);
  if (recordedPacks.join("\n") !== releasePacks.join("\n")) {
    throw new Error(
      `the release was rendered with packs ${JSON.stringify(releasePacks)}, but the manifest records ${JSON.stringify(recordedPacks)} -- render it from the same manifest`,
    );
  }
}

/** Refuses a `targetDir` that does not exist or is not a directory. */
function assertProjectDirectory(targetDir: string): void {
  let stat: Stats;
  try {
    stat = statSync(targetDir);
  } catch (cause) {
    throw new Error(
      `the project directory ${targetDir} does not exist or cannot be inspected`,
      { cause },
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`the project path ${targetDir} is not a directory`);
  }
}

/**
 * Classifies every baseline path and JSON key of the project at `targetDir`
 * against its `manifest` and the rendered `release`. Strictly read-only, and
 * the plan depends only on these inputs (the project tree, the manifest, the
 * release): no clock, no environment. The paths are the union of both
 * manifests' `files` (a project-only file is never listed); each is read
 * once (its absence included) after an `lstat` of every component that
 * refuses a symlink. That walk is check-then-read: a component swapped for a
 * link between the `lstat` and the read is followed, and the later apply
 * step's hash and drift check is the backstop (the same accepted race
 * `plugin.ts` documents). JSON keys cover every file with at least one key in
 * either manifest's `jsonKeys`; a file with none is never parsed. Every
 * recorded key counts as `emitted`. The file's own class wins: its key
 * entries only matter when the file is present and holds a JSON object.
 *
 * @param params - The project root, its manifest, the rendered release and
 *   this CLI's version.
 * @returns The plan, sorted and plain-JSON-serialisable; `toCliVersion` and
 *   `packs` come from the release's manifest.
 * @throws `Error` naming `targetDir` when it is missing or not a directory.
 * @throws `Error` when the release was rendered for another CLI version,
 *   with other tokens or with other packs than the manifest's.
 * @throws `Error` naming the path when a managed file or an ancestor
 *   directory is a symlink, a non-directory ancestor or a non-regular file
 *   sits where a file is expected, a recorded path leaves the project, a
 *   file cannot be inspected or read (the failure as `cause`), a JSON file
 *   does not parse or holds no object (no `cause`: the parser's message can
 *   quote the file), or hashing its keys fails (the engine's `RangeError` as
 *   `cause`).
 *
 * @example
 * ```ts
 * import { computePlan, renderRelease } from "./upgrade/plan.js";
 *
 * const release = renderRelease({ manifest, cliVersion: "1.4.0", templatesDir, packsRoot });
 * try {
 *   const plan = computePlan({ targetDir: "/work/app", manifest, release, cliVersion: "1.4.0" });
 *   console.log(plan.files.filter((e) => e.class === "safe-update").length);
 * } finally {
 *   release.dispose();
 * }
 * ```
 */
export function computePlan(params: {
  readonly targetDir: string;
  readonly manifest: Manifest;
  readonly release: RenderedRelease;
  readonly cliVersion: string;
}): UpgradePlan {
  const { targetDir, manifest, release, cliVersion } = params;
  assertReleaseMatches(manifest, release, cliVersion);
  assertProjectDirectory(targetDir);
  const nextManifest = release.manifest;

  const recorded = toMap<Recorded>(manifest.files);
  const nextFiles = new Map(
    Object.entries(nextManifest.files).map(([p, e]) => [p, e.sha256]),
  );
  const jsonPaths = [
    ...new Set([
      ...Object.keys(manifest.jsonKeys),
      ...Object.keys(nextManifest.jsonKeys),
    ]),
  ].sort((a, b) => (a < b ? -1 : 1));

  const checkedDirs = new Set<string>();
  // Absence is cached too, so each path is read exactly once.
  const bytesByPath = new Map<string, Buffer | undefined>();
  const read = (relPath: string): Buffer | undefined => {
    if (bytesByPath.has(relPath)) return bytesByPath.get(relPath);
    const bytes = readProjectFile(targetDir, relPath, checkedDirs);
    bytesByPath.set(relPath, bytes);
    return bytes;
  };

  const current = new Map<string, string>();
  for (const path of new Set([...recorded.keys(), ...nextFiles.keys()])) {
    const bytes = read(path);
    if (bytes !== undefined) current.set(path, sha256Hex(bytes));
  }

  const files: PlanEntry[] = classifyAll({
    recorded,
    current,
    next: nextFiles,
  }).map((entry) => ({
    path: entry.path,
    class: entry.class,
    ...hashes(
      recorded.get(entry.path)?.sha256,
      current.get(entry.path),
      nextFiles.get(entry.path),
    ),
  }));

  const jsonKeys: [string, JsonKeyEntry[]][] = [];
  for (const path of jsonPaths) {
    const recordedKeys = toMap(own(manifest.jsonKeys, path));
    const nextKeys = toMap(own(nextManifest.jsonKeys, path));
    if (recordedKeys.size === 0 && nextKeys.size === 0) continue;
    const currentKeys = toMap(currentJsonKeys(path, read(path)));
    const entries = classifyAll({
      recorded: new Map(
        [...recordedKeys].map(([pointer, sha256]) => [
          pointer,
          { sha256, origin: "emitted" } as const,
        ]),
      ),
      current: currentKeys,
      next: nextKeys,
    }).map((entry) => ({
      pointer: entry.path,
      class: entry.class,
      ...hashes(
        recordedKeys.get(entry.path),
        currentKeys.get(entry.path),
        nextKeys.get(entry.path),
      ),
    }));
    jsonKeys.push([path, entries]);
  }

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    fromCliVersion: manifest.cliVersion,
    toCliVersion: nextManifest.cliVersion,
    tokens: { ...manifest.tokens },
    packs: [...nextManifest.packs],
    files,
    // fromEntries defines own data properties, so a `__proto__` path stays a key.
    jsonKeys: Object.fromEntries(jsonKeys),
  };
}
