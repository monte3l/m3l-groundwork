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
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPosixPath } from "../assets.js";
import { emitTemplate } from "../emit.js";
import { parseJsonc } from "../jsonc.js";
import { buildManifest, flattenJsonKeys, sha256Hex } from "../manifest.js";
import type { Manifest } from "../manifest.js";
import { installPack, listPackNames, loadPack } from "../packs.js";
import { isAbsentError } from "../survey/internal/read-guard.js";
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
  /** Removes {@link RenderedRelease.dir} recursively; safe to call twice. */
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
 * and holds only files with at least one recorded or next pointer.
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

/** Removes `dir`, reporting (never throwing) a failure as text for the caller's message. */
function removeQuietly(dir: string): string {
  try {
    rmSync(dir, { recursive: true, force: true });
    return "";
  } catch (cleanupError) {
    // Best effort: the render failure is the error worth throwing, so a
    // failed cleanup is reported in its message rather than replacing it.
    const detail =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    return `; the temporary directory ${dir} could not be removed -- delete it by hand (${detail})`;
  }
}

/**
 * Renders the release this CLI ships for `manifest`: the baseline under
 * `templatesDir`, then each of `manifest.packs` in order from `packsRoot`,
 * all with `manifest.tokens` (never the current year), into a new
 * `groundwork-upgrade-*` directory under `tmpRoot` (the OS temp directory by
 * default). Its manifest is built as fresh mode builds one, stamped with
 * `cliVersion`. Writes nothing outside that directory.
 *
 * @param params - The project's manifest, this CLI's version, the template
 *   roots and an optional parent for the temporary directory.
 * @returns The rendered release; call `dispose` when done with it.
 * @throws `Error` naming a pack recorded in the manifest but missing from
 *   this release, before anything is written; `Error` with the original
 *   failure as `cause` on any other failure, after removing the temporary
 *   directory.
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
  const available = new Set(listPackNames(packsRoot));
  for (const name of manifest.packs) {
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
    for (const name of manifest.packs) {
      const pack = loadPack(name, packsRoot);
      files.push(...installPack(pack, dir, manifest.tokens).filesWritten);
    }
    next = buildManifest({
      targetDir: dir,
      cliVersion,
      tokens: manifest.tokens,
      packs: manifest.packs,
      files: [...new Set(files.map(toPosixPath))],
    });
  } catch (cause) {
    const leftover = removeQuietly(dir);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `could not render the ${cliVersion} release: ${detail}${leftover}`,
      { cause },
    );
  }

  const rendered = dir;
  return {
    dir: rendered,
    manifest: next,
    dispose: (): void => {
      rmSync(rendered, { recursive: true, force: true });
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

/** Refuses a path that is absolute, backslashed or has an empty, `.` or `..` segment. */
function assertInsideProject(relPath: string): void {
  const segments = relPath.split("/");
  if (
    relPath.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(
      `refusing to plan ${JSON.stringify(relPath)}: not a relative, /-separated path inside the project`,
    );
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
  assertInsideProject(relPath);
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

/** The current per-key hashes of a JSON file, `{}` when it is absent. */
function currentJsonKeys(
  relPath: string,
  bytes: Buffer | undefined,
): Record<string, string> {
  if (bytes === undefined) return {};
  const parsed = parseJsonc(bytes.toString("utf8"));
  // The parser's message is not chained: it can quote the file's text.
  if (!parsed.ok) {
    throw new Error(`could not parse ${relPath} in the project as JSON`);
  }
  return flattenJsonKeys(parsed.value);
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

/**
 * Classifies every baseline path and JSON key of the project at `targetDir`
 * against its `manifest` and the rendered `release`. Strictly read-only: the
 * paths are the union of both manifests' `files` (a project-only file is
 * never listed), each read by `lstat` per component without following a
 * link. JSON keys cover every file in either manifest's `jsonKeys`, the
 * current keys parsed from the project file (none when it is absent); every
 * recorded key counts as `emitted`.
 *
 * @param params - The project root, its manifest, the rendered release and
 *   this CLI's version.
 * @returns The plan, sorted and plain-JSON-serialisable.
 * @throws `Error` naming the path when a managed file or an ancestor
 *   directory is a symlink, a non-directory ancestor or a non-regular file
 *   sits where a file is expected, a recorded path leaves the project, a
 *   file cannot be read (the failure as `cause`), or a JSON file does not
 *   parse (no `cause`: the parser's message can quote the file).
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
  const bytesByPath = new Map<string, Buffer>();
  const read = (relPath: string): Buffer | undefined => {
    if (bytesByPath.has(relPath)) return bytesByPath.get(relPath);
    const bytes = readProjectFile(targetDir, relPath, checkedDirs);
    if (bytes !== undefined) bytesByPath.set(relPath, bytes);
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
    toCliVersion: cliVersion,
    tokens: { ...manifest.tokens },
    packs: [...manifest.packs],
    files,
    // fromEntries defines own data properties, so a `__proto__` path stays a key.
    jsonKeys: Object.fromEntries(jsonKeys),
  };
}
