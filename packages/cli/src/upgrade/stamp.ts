// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's stamp step: {@link stampUpgrade} records an applied
 * upgrade in `.groundwork/manifest.json`. It reads the manifest and the
 * `plan.json` the `--upgrade` step staged, re-hashes the plan's paths from
 * disk and writes the manifest, and nothing else. It never renders the
 * release: the plan's hashes are the record of what the release holds.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANIFEST_RELATIVE_PATH,
  isProjectRelativePath,
  parseJsonKeys,
  readManifest,
  sha256Hex,
  writeManifest,
} from "../manifest.js";
import type { JsonKeysResult, Manifest } from "../manifest.js";
import { isPrototypeSensitiveKey } from "../merge-json.js";
import type { UpgradeClass } from "./classify.js";
import { UPGRADE_PLAN_FILE, UPGRADE_RELATIVE_DIR } from "./paths.js";
import { readProjectFile, sameTokens } from "./project-read.js";

/** The plan schema this step reads: the one `--upgrade` stages. */
const PLAN_SCHEMA_VERSION = 1;

/** `plan.json`'s path relative to the project root, as messages name it. */
const PLAN_RELATIVE_PATH = `${UPGRADE_RELATIVE_DIR}/${UPGRADE_PLAN_FILE}`;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A semantic version, with an optional `-prerelease` and `+build` suffix. */
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Every class, keyed so a new {@link UpgradeClass} is a compile error here
 * until it is placed: the plan's `class` fields are checked against it.
 */
const CLASSES: Readonly<Record<UpgradeClass, true>> = {
  current: true,
  "local-only": true,
  "safe-update": true,
  "conflict-3way": true,
  add: true,
  "conflict-2way": true,
  "user-deleted": true,
  remove: true,
  "orphan-edited": true,
  gone: true,
};

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "fromCliVersion",
  "toCliVersion",
  "tokens",
  "packs",
  "files",
  "jsonKeys",
  "legacy",
  "staged",
]);
const FILE_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "path",
  "class",
  "recordedSha256",
  "currentSha256",
  "nextSha256",
]);
const STAGED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "path",
  "staged",
  "sha256",
]);
const JSON_KEY_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "pointer",
  "class",
  "recordedSha256",
  "currentSha256",
  "nextSha256",
]);

/** Why a stamp was refused. `code` tells the cases apart; see {@link UpgradeStampError}. */
type UpgradeStampErrorCode =
  "no-manifest" | "no-plan" | "invalid-plan" | "stale-plan" | "unreadable-file";

/**
 * A stamp {@link stampUpgrade} refused, writing nothing. `code` says why:
 * `no-manifest` (the project has no `.groundwork/manifest.json`), `no-plan`
 * (nothing at `.groundwork/upgrade/plan.json`), `invalid-plan` (`plan.json`
 * is not a regular file, cannot be read, is not JSON or fails validation) or
 * `stale-plan` (the plan was computed against another manifest: another CLI
 * version, tokens or packs, or an entry whose `recordedSha256` no longer
 * matches the manifest) or `unreadable-file` (a JSON file the plan lists is
 * present but does not parse, or is too deep to hash; the failure as
 * `cause`). The message names `plan.json`, the manifest or the project path,
 * and never quotes file text, a hash or a token value.
 *
 * @example
 * ```ts
 * import { UpgradeStampError, stampUpgrade } from "./upgrade/stamp.js";
 *
 * try {
 *   stampUpgrade({ targetDir: "/work/app" });
 * } catch (error) {
 *   if (error instanceof UpgradeStampError && error.code === "no-plan") {
 *     console.error("run --upgrade first");
 *   }
 * }
 * ```
 */
export class UpgradeStampError extends Error {
  override readonly name = "UpgradeStampError";
  readonly code: UpgradeStampErrorCode;

  constructor(
    code: UpgradeStampErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/**
 * What {@link stampUpgrade} wrote: the new manifest and how its `files`
 * entries compare with the old manifest's. `updated` counts paths whose entry
 * is new or changed (an origin that moved to `merged` included), `kept` paths
 * whose entry is unchanged (paths the plan does not list included) and
 * `dropped` paths whose entry was removed. JSON key entries are not counted.
 *
 * @example
 * ```ts
 * import type { StampResult } from "./upgrade/stamp.js";
 *
 * const summary = (r: StampResult): string =>
 *   `${String(r.updated)} updated, ${String(r.kept)} kept, ${String(r.dropped)} dropped`;
 * ```
 */
export interface StampResult {
  manifest: Manifest;
  updated: number;
  kept: number;
  dropped: number;
}

/** The hashes one plan entry carries, each only when present. */
interface PlanHashes {
  readonly recordedSha256?: string;
  readonly nextSha256?: string;
}

/** One validated `plan.json` `files` entry. */
interface StampFileEntry extends PlanHashes {
  readonly path: string;
  readonly class: UpgradeClass;
}

/** One validated `plan.json` `jsonKeys` entry. */
interface StampJsonKeyEntry extends PlanHashes {
  readonly pointer: string;
  readonly class: UpgradeClass;
}

/** The fields of a validated `plan.json` the stamp uses. */
interface StampPlan {
  readonly fromCliVersion: string;
  readonly toCliVersion: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly packs: readonly string[];
  readonly files: readonly StampFileEntry[];
  readonly jsonKeys: ReadonlyMap<string, readonly StampJsonKeyEntry[]>;
}

function invalidPlan(detail: string): UpgradeStampError {
  return new UpgradeStampError(
    "invalid-plan",
    `invalid ${PLAN_RELATIVE_PATH}: ${detail} -- re-run --upgrade to stage a new plan`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The own entries of `value` as a `Map`, which must be a plain object (`field`
 * names it), refusing a prototype-sensitive key and, when `allowed` is given,
 * any key outside it.
 */
function objectMap(
  value: unknown,
  field: string,
  allowed?: ReadonlySet<string>,
): Map<string, unknown> {
  if (!isPlainObject(value)) throw invalidPlan(`${field} must be an object`);
  const map = new Map(Object.entries(value));
  for (const key of map.keys()) {
    if (isPrototypeSensitiveKey(key)) {
      throw invalidPlan(`${field} holds a forbidden key`);
    }
    if (allowed !== undefined && !allowed.has(key)) {
      // The key is not echoed: it is text read from the file.
      throw invalidPlan(`${field} has an unknown key`);
    }
  }
  return map;
}

/** A semantic version string; the value is never quoted in the refusal. */
function versionString(value: unknown, field: string): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw invalidPlan(`${field} must be a semantic version`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw invalidPlan(`${field} must be a non-empty string`);
  }
  return value;
}

function arrayOf(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidPlan(`${field} must be an array`);
  return value;
}

function parseClass(value: unknown, field: string): UpgradeClass {
  if (typeof value !== "string" || !Object.hasOwn(CLASSES, value)) {
    throw invalidPlan(`${field}.class is not an upgrade class`);
  }
  return value as UpgradeClass;
}

/** The optional hashes of an entry, each checked when present. */
function parseHashes(entry: Map<string, unknown>, field: string): PlanHashes {
  const result: { recordedSha256?: string; nextSha256?: string } = {};
  for (const key of [
    "recordedSha256",
    "currentSha256",
    "nextSha256",
  ] as const) {
    if (!entry.has(key)) continue;
    const value = entry.get(key);
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw invalidPlan(`${field}.${key} must be 64 lowercase hex characters`);
    }
    if (key !== "currentSha256") result[key] = value;
  }
  return result;
}

function parseFileEntries(value: unknown): StampFileEntry[] {
  const seen = new Set<string>();
  return arrayOf(value, "files").map((raw, index) => {
    const field = `files[${String(index)}]`;
    const entry = objectMap(raw, field, FILE_ENTRY_KEYS);
    const path = nonEmptyString(entry.get("path"), `${field}.path`);
    if (!isProjectRelativePath(path)) {
      throw invalidPlan(
        `${field}.path is not a relative, /-separated path inside the project`,
      );
    }
    if (seen.has(path)) {
      throw invalidPlan(`files lists ${JSON.stringify(path)} twice`);
    }
    seen.add(path);
    return {
      path,
      class: parseClass(entry.get("class"), field),
      ...parseHashes(entry, field),
    };
  });
}

function parseJsonKeyEntries(value: unknown): Map<string, StampJsonKeyEntry[]> {
  const result = new Map<string, StampJsonKeyEntry[]>();
  for (const [path, list] of objectMap(value, "jsonKeys")) {
    if (!isProjectRelativePath(path)) {
      throw invalidPlan(
        "jsonKeys holds a path that is not a relative, /-separated path inside the project",
      );
    }
    const seen = new Set<string>();
    const field = `jsonKeys[${JSON.stringify(path)}]`;
    const entries = arrayOf(list, field).map((raw, index) => {
      const entryField = `${field}[${String(index)}]`;
      const entry = objectMap(raw, entryField, JSON_KEY_ENTRY_KEYS);
      const pointer = nonEmptyString(
        entry.get("pointer"),
        `${entryField}.pointer`,
      );
      if (!pointer.startsWith("/") || seen.has(pointer)) {
        throw invalidPlan(
          `${entryField}.pointer must be a JSON Pointer listed once`,
        );
      }
      seen.add(pointer);
      return {
        pointer,
        class: parseClass(entry.get("class"), entryField),
        ...parseHashes(entry, entryField),
      };
    });
    result.set(path, entries);
  }
  return result;
}

function parseStaged(value: unknown): void {
  arrayOf(value, "staged").forEach((raw, index) => {
    const field = `staged[${String(index)}]`;
    const entry = objectMap(raw, field, STAGED_ENTRY_KEYS);
    for (const key of STAGED_ENTRY_KEYS) {
      if (typeof entry.get(key) !== "string") {
        throw invalidPlan(`${field}.${key} must be a string`);
      }
    }
  });
}

/**
 * Validates a parsed `plan.json` strictly, naming the field at fault and
 * never a value read from the file other than a path.
 */
function validatePlan(document: unknown): StampPlan {
  const top = objectMap(document, "the plan", TOP_LEVEL_KEYS);
  if (top.get("schemaVersion") !== PLAN_SCHEMA_VERSION) {
    throw invalidPlan(
      `unsupported schemaVersion (this CLI reads ${String(PLAN_SCHEMA_VERSION)})`,
    );
  }
  const legacy = top.get("legacy");
  if (legacy === true) {
    throw invalidPlan(
      "it is a legacy plan (no manifest), which this CLI cannot stamp yet",
    );
  }
  if (legacy !== false) throw invalidPlan("legacy must be false");
  const fromCliVersion = versionString(
    top.get("fromCliVersion"),
    "fromCliVersion",
  );
  const toCliVersion = versionString(top.get("toCliVersion"), "toCliVersion");
  const tokens: Record<string, string> = {};
  for (const [key, value] of objectMap(top.get("tokens"), "tokens")) {
    if (typeof value !== "string") {
      // The token name is not echoed: it is text read from the file.
      throw invalidPlan("tokens holds a non-string value");
    }
    tokens[key] = value;
  }
  const packs = arrayOf(top.get("packs"), "packs").map((pack) => {
    if (typeof pack !== "string") {
      throw invalidPlan("packs must be an array of strings");
    }
    return pack;
  });
  const files = parseFileEntries(top.get("files"));
  const jsonKeys = parseJsonKeyEntries(top.get("jsonKeys"));
  parseStaged(top.get("staged"));
  return { fromCliVersion, toCliVersion, tokens, packs, files, jsonKeys };
}

/**
 * Reads `plan.json`, `lstat` first: the staging directory and the plan must
 * be a real directory and a regular file, never a symlink. Read, parse and
 * validation fail separately, and no parser message is chained, since it can
 * quote the file.
 */
function readPlan(targetDir: string): StampPlan {
  const dir = join(targetDir, UPGRADE_RELATIVE_DIR);
  const path = join(dir, UPGRADE_PLAN_FILE);
  let text: string;
  try {
    const dirStat = lstatSync(dir, { throwIfNoEntry: false });
    if (dirStat !== undefined && !dirStat.isDirectory()) {
      throw invalidPlan(
        `${UPGRADE_RELATIVE_DIR} is a symlink or not a directory -- it must be a real directory`,
      );
    }
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) {
      throw new UpgradeStampError(
        "no-plan",
        `${targetDir} has no ${PLAN_RELATIVE_PATH}: no plan to stamp -- run --upgrade first`,
      );
    }
    if (!stat.isFile()) {
      throw invalidPlan(
        "it is a symlink, a directory or another non-regular file -- it must be a regular file",
      );
    }
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof UpgradeStampError) throw cause;
    throw new UpgradeStampError(
      "invalid-plan",
      `could not read ${PLAN_RELATIVE_PATH}`,
      { cause },
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // The SyntaxError is not chained: its message can quote the text.
    throw invalidPlan("not valid JSON");
  }
  return validatePlan(document);
}

/** A pack list as fresh mode records it: de-duplicated, sorted, one string. */
const packKey = (packs: readonly string[]): string =>
  [...new Set(packs)].sort().join("\n");

/**
 * Refuses a plan computed against another manifest than `manifest`: another
 * CLI version (a stale plan, or one already stamped), other tokens (no value
 * is named), other packs, or an entry whose `recordedSha256` is not the
 * manifest's hash for it (a missing `recordedSha256` needs a missing manifest
 * entry). The per-entry check names the path, never a hash.
 */
function assertPlanMatches(manifest: Manifest, plan: StampPlan): void {
  if (plan.fromCliVersion !== manifest.cliVersion) {
    throw new UpgradeStampError(
      "stale-plan",
      `${PLAN_RELATIVE_PATH} is stale or already stamped: it was computed from CLI version ${plan.fromCliVersion}, but ${MANIFEST_RELATIVE_PATH} records ${manifest.cliVersion} -- re-run --upgrade`,
    );
  }
  if (!sameTokens(plan.tokens, manifest.tokens)) {
    throw new UpgradeStampError(
      "stale-plan",
      `${PLAN_RELATIVE_PATH} was computed with tokens that differ from those ${MANIFEST_RELATIVE_PATH} records -- re-run --upgrade`,
    );
  }
  if (packKey(plan.packs) !== packKey(manifest.packs)) {
    throw new UpgradeStampError(
      "stale-plan",
      `${PLAN_RELATIVE_PATH} was computed with packs that differ from those ${MANIFEST_RELATIVE_PATH} records -- re-run --upgrade`,
    );
  }
  const staleEntry = (path: string): UpgradeStampError =>
    new UpgradeStampError(
      "stale-plan",
      `${PLAN_RELATIVE_PATH} is stale: its entry for ${JSON.stringify(path)} no longer matches ${MANIFEST_RELATIVE_PATH} -- re-run --upgrade`,
    );
  for (const entry of plan.files) {
    const recorded = Object.hasOwn(manifest.files, entry.path)
      ? manifest.files[entry.path]?.sha256
      : undefined;
    if (entry.recordedSha256 !== recorded) throw staleEntry(entry.path);
  }
  for (const [path, entries] of plan.jsonKeys) {
    const keys = Object.hasOwn(manifest.jsonKeys, path)
      ? manifest.jsonKeys[path]
      : undefined;
    for (const entry of entries) {
      const recorded =
        keys !== undefined && Object.hasOwn(keys, entry.pointer)
          ? keys[entry.pointer]
          : undefined;
      if (entry.recordedSha256 !== recorded) throw staleEntry(path);
    }
  }
}

type FileRecord = Manifest["files"][string];

/** `old` with its hash kept and its origin `merged`, or none. */
const asMerged = (old: FileRecord | undefined): FileRecord | undefined =>
  old === undefined ? undefined : { sha256: old.sha256, origin: "merged" };

/**
 * `old` kept under the new release (the base invariant): unchanged when its
 * hash is the new release's (`next`), else its hash marked `merged`, since
 * the manifest has one `cliVersion` and the old release's base can no longer
 * be rebuilt. An already-merged entry stays as it is.
 */
const keepOld = (
  old: FileRecord | undefined,
  next: string | undefined,
): FileRecord | undefined =>
  old !== undefined && old.sha256 === next ? old : asMerged(old);

/**
 * The new entry for one plan file, or `undefined` for none. `disk` is the
 * file's current hash (`undefined` when absent), `old` its old manifest entry.
 * Every kept entry goes through {@link keepOld}, so the next upgrade compares
 * a file kept with the old release's hash two-way.
 */
function stampFile(
  entry: StampFileEntry,
  disk: string | undefined,
  old: FileRecord | undefined,
): FileRecord | undefined {
  switch (entry.class) {
    case "gone":
      return disk === undefined ? undefined : keepOld(old, entry.nextSha256);
    case "orphan-edited":
    case "local-only":
      return keepOld(old, entry.nextSha256);
    case "user-deleted":
      return asMerged(old);
    case "remove":
      return disk === undefined ? undefined : asMerged(old);
    case "current":
    case "add":
    case "safe-update":
    case "conflict-2way":
    case "conflict-3way":
      if (disk === undefined) return keepOld(old, entry.nextSha256);
      if (disk === entry.nextSha256) return { sha256: disk, origin: "emitted" };
      if (disk === entry.recordedSha256 && old !== undefined) {
        return keepOld(old, entry.nextSha256);
      }
      return { sha256: disk, origin: "merged" };
  }
}

/**
 * The per-key hashes of a present JSON file, or `undefined` when it is not a
 * JSON object (its old keys stand).
 *
 * @throws {@link UpgradeStampError} `unreadable-file` when it does not parse
 *   or is too deep to hash. The parser's message is never chained (it can
 *   quote the file); a hashing failure (a `RangeError`) is.
 */
function diskJsonKeys(
  path: string,
  bytes: Buffer,
): Record<string, string> | undefined {
  const unreadable = (cause: unknown): UpgradeStampError =>
    new UpgradeStampError(
      "unreadable-file",
      `could not hash the JSON keys of ${path}`,
      { cause },
    );
  let parsed: JsonKeysResult;
  try {
    parsed = parseJsonKeys(bytes.toString("utf8"));
  } catch (cause) {
    throw unreadable(cause);
  }
  if (!parsed.ok) throw unreadable(new Error(`${path} is not valid JSON`));
  return parsed.isObject ? parsed.keys : undefined;
}

/**
 * The new pointer hashes of one JSON file the plan lists. `disk` is `null`
 * for an absent file and `undefined` for one that is not a JSON object. An
 * absent file drops the pointers the release no longer has and keeps the
 * rest; a non-object keeps every old hash; an object records `N` where the
 * key equals it, drops a key absent from both, and keeps the rest.
 */
function stampJsonKeys(
  entries: readonly StampJsonKeyEntry[],
  disk: Readonly<Record<string, string>> | null | undefined,
  old: Readonly<Record<string, string>>,
): Record<string, string> {
  const result = new Map(Object.entries(old));
  if (disk === undefined) return Object.fromEntries(result);
  for (const entry of entries) {
    const current =
      disk !== null && Object.hasOwn(disk, entry.pointer)
        ? disk[entry.pointer]
        : undefined;
    if (current !== undefined && current === entry.nextSha256) {
      result.set(entry.pointer, current);
    } else if (current === undefined && entry.nextSha256 === undefined) {
      result.delete(entry.pointer);
    }
  }
  return Object.fromEntries(result);
}

const sameRecord = (a: FileRecord, b: FileRecord): boolean =>
  a.sha256 === b.sha256 && a.origin === b.origin;

/**
 * Records an applied upgrade: reads `<targetDir>/.groundwork/manifest.json`
 * and the plan `--upgrade` staged in `.groundwork/upgrade/plan.json`,
 * re-hashes every path the plan lists from disk and writes the new manifest
 * with `writeManifest`. Nothing else is written. The new manifest has the
 * plan's `toCliVersion`, the same tokens and packs, and per plan file (`D`
 * the disk hash, `R` the plan's `recordedSha256`, `N` its `nextSha256`):
 * `gone` drops the entry when the file is absent and keeps it when a file is
 * there; `orphan-edited` and `local-only` keep it; `user-deleted` keeps it;
 * `remove` drops it once the file is absent and keeps it otherwise; every
 * other class keeps the old entry (or none) when the file is absent, records
 * `{N, emitted}` when `D == N`, keeps the old entry when `D == R` (the change
 * is not applied yet) and records `{D, merged}` otherwise. **Base
 * invariant:** a kept entry whose hash is not the new release's (or with no
 * new release hash) is recorded as `{old hash, merged}`, since the manifest
 * has one `cliVersion` and the old release's base can no longer be rebuilt;
 * `user-deleted` and a present `remove` are always marked `merged`. Per JSON
 * key: a present JSON-object file records `N` where the key equals it, drops
 * a key absent from both the release and the file, and keeps the rest; an
 * absent file drops the keys the release no longer has and keeps the rest; a
 * present non-object keeps every old hash. JSON keys carry no origin, so a
 * key kept with its old hash stays a 3-way base under the new `cliVersion`
 * until a schema change adds a per-key origin. A file's key entry is dropped
 * once it holds no key, or with the file's entry. Paths and keys the plan
 * does not list are kept unchanged. Everything is computed before the
 * manifest is written.
 *
 * @param params - The project root.
 * @returns The new manifest and the counts of updated, kept and dropped
 *   file entries.
 * @throws {@link UpgradeStampError} with `code` `no-manifest` or `no-plan`
 *   when either is missing; `invalid-plan` when `plan.json` is not a regular
 *   file, cannot be read, is not JSON or fails validation (a version that is
 *   not a semantic version, an unknown key anywhere); `stale-plan` when it
 *   was computed against another CLI version, tokens or packs, or an entry's
 *   `recordedSha256` is not the manifest's hash for it; `unreadable-file`
 *   when a listed JSON file is present but does not parse or is too deep to
 *   hash, with `cause`. All
 *   before anything is written. The `ManifestError` from reading or writing
 *   the manifest, unchanged. An `Error` naming the path when a listed file or
 *   an ancestor is a symlink or not a regular file, or cannot be read.
 *
 * @example
 * ```ts
 * import { stampUpgrade } from "./upgrade/stamp.js";
 *
 * const { manifest, updated, kept, dropped } = stampUpgrade({ targetDir: "/work/app" });
 * console.log(`${manifest.cliVersion}: ${String(updated)} updated, ${String(kept)} kept, ${String(dropped)} dropped`);
 * ```
 */
export function stampUpgrade(params: {
  readonly targetDir: string;
}): StampResult {
  const { targetDir } = params;
  const manifest = readManifest(targetDir);
  if (manifest === undefined) {
    throw new UpgradeStampError(
      "no-manifest",
      `${targetDir} has no ${MANIFEST_RELATIVE_PATH}, so there is no record to stamp`,
    );
  }
  const plan = readPlan(targetDir);
  assertPlanMatches(manifest, plan);

  const checkedDirs = new Set<string>();
  const files = new Map(Object.entries(manifest.files));
  const droppedPaths = new Set<string>();
  for (const entry of plan.files) {
    const bytes = readProjectFile(targetDir, entry.path, checkedDirs, "stamp");
    const disk = bytes === undefined ? undefined : sha256Hex(bytes);
    const next = stampFile(entry, disk, files.get(entry.path));
    if (next === undefined) {
      if (files.delete(entry.path)) droppedPaths.add(entry.path);
    } else {
      files.set(entry.path, next);
    }
  }

  const jsonKeys = new Map(Object.entries(manifest.jsonKeys));
  for (const [path, entries] of plan.jsonKeys) {
    const bytes = readProjectFile(targetDir, path, checkedDirs, "stamp");
    const disk = bytes === undefined ? null : diskJsonKeys(path, bytes);
    const keys = stampJsonKeys(entries, disk, jsonKeys.get(path) ?? {});
    if (Object.keys(keys).length === 0) jsonKeys.delete(path);
    else jsonKeys.set(path, keys);
  }
  // A file whose entry was dropped takes its key hashes with it.
  for (const path of droppedPaths) jsonKeys.delete(path);

  const stamped: Manifest = {
    schemaVersion: manifest.schemaVersion,
    cliVersion: plan.toCliVersion,
    tokens: { ...manifest.tokens },
    packs: [...manifest.packs],
    files: Object.fromEntries(files),
    jsonKeys: Object.fromEntries(jsonKeys),
  };
  writeManifest(targetDir, stamped);

  let updated = 0;
  let kept = 0;
  let dropped = 0;
  for (const [path, old] of Object.entries(manifest.files)) {
    const now = files.get(path);
    if (now === undefined) dropped += 1;
    else if (sameRecord(old, now)) kept += 1;
  }
  for (const [path, now] of files) {
    const old = Object.hasOwn(manifest.files, path)
      ? manifest.files[path]
      : undefined;
    if (old === undefined || !sameRecord(old, now)) updated += 1;
  }
  return { manifest: stamped, updated, kept, dropped };
}
