// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The base record (`.groundwork/groundwork.lock.json`) a bootstrap writes so a
 * later update has a three-way base: which version of the baseline was
 * emitted, with which tokens, and every file it placed with the sha256 of the
 * content it placed. {@link buildLock} canonicalizes, {@link serializeLock}
 * prints one field per line, {@link parseLock} is strict and throws, and
 * {@link readLock} is the lenient project read (see its TSDoc for what it
 * reports rather than throws).
 */
import { isPrototypeSensitiveKey, isRecord } from "./merge-json.js";
import { projectEntry, readProjectFile } from "./pack-installation.js";

/**
 * The lock file's path, relative to the project root.
 *
 * @example
 * ```ts
 * import { join } from "node:path";
 * const lockPath = join("/path/to/project", LOCK_FILE);
 * ```
 */
export const LOCK_FILE = ".groundwork/groundwork.lock.json";

/**
 * The directory, relative to the project root, that holds the base copy of
 * every locked file (each named with {@link BASE_SUFFIX}).
 *
 * @example
 * ```ts
 * const baseCopy = `${BASE_DIR}/eslint.config.js${BASE_SUFFIX}`;
 * ```
 */
export const BASE_DIR = ".groundwork/base";

/**
 * The suffix every base copy under {@link BASE_DIR} carries, so no
 * extension-based glob matches it.
 *
 * @example
 * ```ts
 * const baseName = `src/index.ts${BASE_SUFFIX}`; // "src/index.ts.base"
 * ```
 */
export const BASE_SUFFIX = ".base";

/**
 * The only lock schema version this CLI reads and writes.
 *
 * @example
 * ```ts
 * if (lock.schemaVersion === LOCK_SCHEMA_VERSION) console.log("current lock");
 * ```
 */
export const LOCK_SCHEMA_VERSION = 1;

const LOCK_KIND = "m3l-groundwork/lock";
const ORIGINS = ["fresh", "adopt"] as const;
const STATUSES = ["installed", "kept", "declined", "removed"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE = /^(?:core|skill|pack:[a-z0-9][a-z0-9._-]*)$/;

/**
 * One file the lock records: its project-relative `/`-separated `path`, who
 * placed it (`core`, `skill` or `pack:<name>`), the sha256 of the content
 * placed (`null` when none was), and what became of it.
 *
 * @example
 * ```ts
 * const file: LockFile = {
 *   path: "eslint.config.js",
 *   source: "core",
 *   baseSha256: null,
 *   status: "installed",
 * };
 * ```
 */
export interface LockFile {
  readonly path: string;
  readonly source: string;
  readonly baseSha256: string | null;
  readonly status: (typeof STATUSES)[number];
}

/**
 * The whole lock, in the key order {@link serializeLock} prints.
 *
 * @example
 * ```ts
 * const read = readLock("/path/to/project");
 * if ("lock" in read) console.log(read.lock.baseVersion);
 * ```
 */
export interface Lock {
  readonly schemaVersion: typeof LOCK_SCHEMA_VERSION;
  readonly kind: typeof LOCK_KIND;
  readonly baseVersion: string;
  readonly origin: (typeof ORIGINS)[number];
  readonly tokens: Readonly<Record<string, string>>;
  readonly via: string;
  readonly updatedAt: string;
  readonly skip: readonly string[];
  readonly files: readonly LockFile[];
}

/** A lock that failed {@link parseLock}'s validation. */
class LockParseError extends Error {
  override readonly name = "LockParseError";
}

function byPath(a: LockFile, b: LockFile): number {
  if (a.path < b.path) return -1;
  return a.path > b.path ? 1 : 0;
}

function canonicalFile(file: LockFile): LockFile {
  return {
    path: file.path,
    source: file.source,
    baseSha256: file.baseSha256,
    status: file.status,
  };
}

/**
 * Builds a schema-1 lock from its fields, in canonical key order, with
 * `files` sorted by `path` (code-unit order). Does not validate: a lock
 * that must be trusted goes through {@link parseLock}.
 *
 * @example
 * ```ts
 * const lock = buildLock({
 *   baseVersion: "1.5.0",
 *   origin: "fresh",
 *   tokens: { PROJECT_NAME: "acme" },
 *   via: "fresh",
 *   updatedAt: new Date().toISOString(),
 *   skip: [],
 *   files: [],
 * });
 * ```
 */
export function buildLock(fields: Omit<Lock, "schemaVersion" | "kind">): Lock {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    kind: LOCK_KIND,
    baseVersion: fields.baseVersion,
    origin: fields.origin,
    tokens: { ...fields.tokens },
    via: fields.via,
    updatedAt: fields.updatedAt,
    skip: [...fields.skip],
    files: fields.files.map(canonicalFile).sort(byPath),
  };
}

/**
 * The lock's file text: `JSON.stringify(lock, null, 2)` plus one trailing
 * newline, so every field sits on its own line (no line holds both a path
 * and a digest).
 *
 * @example
 * ```ts
 * import { writeFileSync } from "node:fs";
 * writeFileSync("/path/to/project/.groundwork/groundwork.lock.json", serializeLock(lock));
 * ```
 */
export function serializeLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function assertNoPrototypeKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      assertNoPrototypeKeys(item, `${where}[${String(index)}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (isPrototypeSensitiveKey(key)) {
      throw new LockParseError(
        `${where} uses the prototype-sensitive key ${JSON.stringify(key)}`,
      );
    }
    assertNoPrototypeKeys(value[key], `${where}.${key}`);
  }
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = field(record, key);
  if (typeof value !== "string") {
    throw new LockParseError(`${where}.${key} must be a string`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new LockParseError(`${what} must be one of ${allowed.join(", ")}`);
  }
  return match;
}

function relativePath(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new LockParseError(`${what} must be a string`);
  }
  const bad =
    value.includes("\\") ||
    value.includes(":") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..");
  if (bad) {
    throw new LockParseError(
      `${what} ${JSON.stringify(value)} is not a relative /-separated path without empty, . or .. segments`,
    );
  }
  return value;
}

function parseTokens(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new LockParseError("tokens must be an object");
  const tokens: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const token = value[key];
    if (typeof token !== "string") {
      throw new LockParseError(`tokens.${key} must be a string`);
    }
    tokens[key] = token;
  }
  return tokens;
}

function parseSkip(value: unknown): string[] {
  if (!Array.isArray(value)) throw new LockParseError("skip must be an array");
  return value.map((item: unknown, index) =>
    relativePath(item, `skip[${String(index)}]`),
  );
}

function parseFile(value: unknown, index: number): LockFile {
  const where = `files[${String(index)}]`;
  if (!isRecord(value)) throw new LockParseError(`${where} must be an object`);
  const path = relativePath(field(value, "path"), `${where}.path`);
  const source = stringField(value, "source", where);
  if (!SOURCE.test(source)) {
    throw new LockParseError(
      `${where}.source must be core, skill or pack:<name>`,
    );
  }
  const baseSha256 = field(value, "baseSha256");
  if (
    baseSha256 !== null &&
    (typeof baseSha256 !== "string" || !SHA256.test(baseSha256))
  ) {
    throw new LockParseError(
      `${where}.baseSha256 must be null or a lowercase 64-hex sha256`,
    );
  }
  const status = oneOf(field(value, "status"), STATUSES, `${where}.status`);
  return { path, source, baseSha256, status };
}

function parseFiles(value: unknown): LockFile[] {
  if (!Array.isArray(value)) throw new LockParseError("files must be an array");
  const files = value.map((item: unknown, index) => parseFile(item, index));
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new LockParseError(
        `files lists ${JSON.stringify(file.path)} more than once`,
      );
    }
    seen.add(file.path);
  }
  return files;
}

/**
 * Parses and validates lock text. Strict: throws an `Error` naming the
 * offending field on invalid JSON, a non-object, a wrong `kind`, a
 * `schemaVersion` other than {@link LOCK_SCHEMA_VERSION}, an unknown `origin`
 * or `status`, a non-string field or token, an absolute or escaping path (in
 * `files` or `skip`), a duplicate path, an unknown `source`, a `baseSha256`
 * that is neither `null` nor a lowercase 64-hex sha256, or a
 * `__proto__`/`constructor`/`prototype` key at any level. The JSON parser's
 * own message is not repeated, since it can quote the content.
 *
 * @example
 * ```ts
 * import { readFileSync } from "node:fs";
 * const lock = parseLock(readFileSync("/path/to/project/.groundwork/groundwork.lock.json", "utf8"));
 * ```
 */
export function parseLock(text: string): Lock {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's SyntaxError is deliberately not chained: its message can
    // quote the lock's content.
    throw new LockParseError("the lock is not valid JSON");
  }
  if (!isRecord(value)) throw new LockParseError("the lock must be an object");
  assertNoPrototypeKeys(value, "the lock");
  if (field(value, "kind") !== LOCK_KIND) {
    throw new LockParseError(`kind must be ${JSON.stringify(LOCK_KIND)}`);
  }
  if (field(value, "schemaVersion") !== LOCK_SCHEMA_VERSION) {
    throw new LockParseError(
      `schemaVersion must be ${String(LOCK_SCHEMA_VERSION)}`,
    );
  }
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    kind: LOCK_KIND,
    baseVersion: stringField(value, "baseVersion", "the lock"),
    origin: oneOf(field(value, "origin"), ORIGINS, "origin"),
    tokens: parseTokens(field(value, "tokens")),
    via: stringField(value, "via", "the lock"),
    updatedAt: stringField(value, "updatedAt", "the lock"),
    skip: parseSkip(field(value, "skip")),
    files: parseFiles(field(value, "files")),
  };
}

/**
 * Reads the project's lock leniently: no lock file (or no `.groundwork/`)
 * is `{ absent: true }`; a symlinked or non-regular lock file, one behind a
 * symlinked `.groundwork/`, an unreadable file, or content
 * {@link parseLock} rejects is a `note` naming {@link LOCK_FILE}. Any other
 * (unexpected) error is rethrown unchanged.
 *
 * @example
 * ```ts
 * const read = readLock("/path/to/project");
 * if ("note" in read) console.warn(read.note);
 * else if ("lock" in read) console.log(read.lock.files.length);
 * ```
 */
export function readLock(
  targetDir: string,
):
  | { readonly lock: Lock }
  | { readonly absent: true }
  | { readonly note: string } {
  if (projectEntry(targetDir, LOCK_FILE).kind === "absent") {
    return { absent: true };
  }
  const read = readProjectFile(targetDir, LOCK_FILE);
  if (!read.ok) return { note: `${read.reason} -- the lock was ignored` };
  try {
    return { lock: parseLock(read.text) };
  } catch (error) {
    if (!(error instanceof LockParseError)) throw error;
    return { note: `${LOCK_FILE} is invalid (${error.message}) -- ignored` };
  }
}
