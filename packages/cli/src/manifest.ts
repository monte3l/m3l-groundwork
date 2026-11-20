// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The install manifest, `.groundwork/manifest.json`: the one record of what
 * the CLI emitted into a project -- the CLI version, the token table, the
 * installed packs, a sha256 per file and a sha256 per top-level/depth-2 key
 * of the JSON files packs merge into. Fresh mode writes it once the baseline
 * and every pack are on disk; adopt mode never touches it; the planned
 * upgrade mode reads it as the merge base (`.claude/rules/upgrade-mode.md`).
 *
 * Parsing is strict: the file is tracked, so anything but the exact schema
 * is refused with a {@link ManifestError} rather than guessed at.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { assertDirectoryComponent, assertFileDestination } from "./fs-guard.js";
import { parseJsonc } from "./jsonc.js";
import { isPrototypeSensitiveKey } from "./merge-json.js";
import { isAbsentError } from "./survey/internal/read-guard.js";

/**
 * The manifest schema this CLI reads and writes. A manifest declaring any
 * other version is refused by {@link parseManifest}.
 *
 * @example
 * ```ts
 * import { MANIFEST_SCHEMA_VERSION } from "./manifest.js";
 *
 * MANIFEST_SCHEMA_VERSION; // 1
 * ```
 */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Where the manifest lives, relative to the project root, `/`-separated.
 *
 * @example
 * ```ts
 * import { MANIFEST_RELATIVE_PATH } from "./manifest.js";
 *
 * console.log(`wrote ${MANIFEST_RELATIVE_PATH}`);
 * ```
 */
export const MANIFEST_RELATIVE_PATH = ".groundwork/manifest.json";

/**
 * One recorded file: the sha256 of its bytes (64 lowercase hex characters)
 * and how it came to hold them -- `emitted` straight from the baseline or a
 * pack, `merged` when the recorded bytes differ from what the CLI would emit
 * (written by the planned upgrade stamp step). Reached by consumers as
 * `Manifest["files"][string]`.
 */
interface ManifestFileEntry {
  sha256: string;
  origin: "emitted" | "merged";
}

/**
 * The parsed `.groundwork/manifest.json`. Every path key is relative to the
 * project root and `/`-separated; `jsonKeys` maps a JSON file's path to
 * {@link flattenJsonKeys}'s output for it.
 *
 * @example
 * ```ts
 * import type { Manifest } from "./manifest.js";
 *
 * const manifest: Manifest = {
 *   schemaVersion: 1,
 *   cliVersion: "1.2.3",
 *   tokens: { PROJECT_NAME: "widgets", YEAR: "2026" },
 *   packs: [],
 *   files: {},
 *   jsonKeys: {},
 * };
 * ```
 */
export interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  cliVersion: string;
  tokens: Record<string, string>;
  packs: string[];
  files: Record<string, ManifestFileEntry>;
  jsonKeys: Record<string, Record<string, string>>;
}

/**
 * A manifest that cannot be built, parsed, read or written. Carries the
 * underlying failure as `cause` where there is one.
 *
 * @example
 * ```ts
 * import { ManifestError, readManifest } from "./manifest.js";
 *
 * try {
 *   readManifest("/work/app");
 * } catch (error) {
 *   if (error instanceof ManifestError) console.error(error.message);
 * }
 * ```
 */
export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

/**
 * The sha256 of `data` as 64 lowercase hex characters. A string is hashed as
 * its UTF-8 bytes, so it agrees with the same text read from disk.
 *
 * @example
 * ```ts
 * import { sha256Hex } from "./manifest.js";
 *
 * sha256Hex("abc"); // "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
 * ```
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` as JSON text with every object's keys sorted, so two values equal
 * as JSON give the same text whatever their key order. `JSON.stringify`
 * returns `undefined` for a bare `undefined`, function or symbol; that is
 * passed through for the caller to skip.
 */
function canonicalJson(value: unknown): string | undefined {
  const text: unknown = JSON.stringify(value, (_key, v: unknown) =>
    isPlainObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  return typeof text === "string" ? text : undefined;
}

/**
 * Flattens a parsed JSON document into per-key hashes: a top-level key whose
 * value is not a plain object is recorded as `"a"`; a top-level plain object
 * contributes one `"a.b"` entry per own key instead (and nothing when it is
 * empty). Each value -- an array or a deeper object included -- is hashed
 * whole, as the sha256 of its key-sorted JSON text, so the result is
 * independent of key order and source whitespace. A non-object input (an
 * array, a scalar, `null`, `undefined`) gives `{}`; a key whose value has no
 * JSON form (`undefined`) is omitted, as `JSON.stringify` omits it.
 *
 * @example
 * ```ts
 * import { flattenJsonKeys } from "./manifest.js";
 *
 * flattenJsonKeys({ name: "x", scripts: { build: "tsc" } });
 * // { name: sha256('"x"'), "scripts.build": sha256('"tsc"') }
 * ```
 */
export function flattenJsonKeys(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const entries: [string, string][] = [];
  const record = (key: string, v: unknown): void => {
    const canonical = canonicalJson(v);
    if (canonical !== undefined) entries.push([key, sha256Hex(canonical)]);
  };
  for (const [key, v] of Object.entries(value)) {
    if (isPlainObject(v)) {
      for (const [inner, innerValue] of Object.entries(v)) {
        record(`${key}.${inner}`, innerValue);
      }
    } else {
      record(key, v);
    }
  }
  // fromEntries defines own data properties, so even a `__proto__` key in the
  // input stays an ordinary key here and never reaches a prototype.
  return Object.fromEntries(entries);
}

/** Whether the manifest records per-key hashes for `relPath`. */
function hasJsonKeys(relPath: string): boolean {
  if (relPath === ".claude/settings.json") return true;
  const name = basename(relPath);
  return (
    name === "package.json" ||
    (name.startsWith("tsconfig") && name.endsWith(".json"))
  );
}

/**
 * The inputs to {@link buildManifest}. `files` are project-relative,
 * `/`-separated paths; duplicates are collapsed.
 */
export interface BuildManifestParams {
  targetDir: string;
  cliVersion: string;
  tokens: Readonly<Record<string, string>>;
  packs: readonly string[];
  files: readonly string[];
}

/**
 * Builds a manifest from the files as they are on disk now: each path is
 * hashed from its current bytes (so a pack's later merge into a shared file
 * is what gets recorded) with `origin: "emitted"`, and `package.json`,
 * `tsconfig*.json` (at any depth) and the root `.claude/settings.json` are
 * also parsed as JSONC into {@link flattenJsonKeys} hashes. Files and packs
 * come out sorted and de-duplicated. Writes nothing.
 *
 * @throws {@link ManifestError} naming the path when a file cannot be read
 *   (the read failure chained as `cause`) or a JSON file cannot be parsed.
 *
 * @example
 * ```ts
 * import { buildManifest, writeManifest } from "./manifest.js";
 *
 * const manifest = buildManifest({
 *   targetDir: "/work/app",
 *   cliVersion: "1.2.3",
 *   tokens: { PROJECT_NAME: "app", YEAR: "2026" },
 *   packs: ["harness-extras"],
 *   files: ["package.json", "tsconfig.json"],
 * });
 * writeManifest("/work/app", manifest);
 * ```
 */
export function buildManifest(params: BuildManifestParams): Manifest {
  const files: Record<string, ManifestFileEntry> = {};
  const jsonKeys: Record<string, Record<string, string>> = {};
  const paths = [...new Set(params.files)].sort();
  for (const relPath of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(params.targetDir, relPath));
    } catch (cause) {
      throw new ManifestError(
        `could not read ${relPath} to record it in ${MANIFEST_RELATIVE_PATH}`,
        { cause },
      );
    }
    files[relPath] = { sha256: sha256Hex(bytes), origin: "emitted" };
    if (hasJsonKeys(relPath)) {
      const parsed = parseJsonc(bytes.toString("utf8"));
      // The parser's message is not chained: it can quote the file's text.
      if (!parsed.ok) {
        throw new ManifestError(
          `could not parse ${relPath} as JSON to record it in ${MANIFEST_RELATIVE_PATH}`,
        );
      }
      jsonKeys[relPath] = flattenJsonKeys(parsed.value);
    }
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    cliVersion: params.cliVersion,
    tokens: { ...params.tokens },
    packs: [...new Set(params.packs)].sort(),
    files,
    jsonKeys,
  };
}

/** Prettier's default print width, which the emitted project's `.prettierrc.json` keeps. */
const PRINT_WIDTH = 80;

/**
 * Prints a manifest value as Prettier prints JSON: 2-space indent, objects
 * one key per line in sorted order (`{}` when empty), and a string array on
 * one line when that whole line fits in {@link PRINT_WIDTH} columns, else
 * one element per line. The manifest's shape bounds the depth (at most 3).
 */
function printValue(
  value: unknown,
  indent: number,
  prefix: string,
  suffix: string,
): string {
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) {
    const items = value.map((item) => JSON.stringify(item));
    if (items.length === 0) return "[]";
    const flat = `[${items.join(", ")}]`;
    if ((prefix + flat + suffix).length <= PRINT_WIDTH) return flat;
    const lines = items.map(
      (item, index) => `${pad}${item}${index < items.length - 1 ? "," : ""}`,
    );
    return `[\n${lines.join("\n")}\n${close}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    const lines = keys.map((key, index) => {
      const comma = index < keys.length - 1 ? "," : "";
      const head = `${pad}${JSON.stringify(key)}: `;
      return `${head}${printValue(value[key], indent + 2, head, comma)}${comma}`;
    });
    return `{\n${lines.join("\n")}\n${close}}`;
  }
  return JSON.stringify(value);
}

/**
 * Serializes a manifest deterministically: keys sorted at every level,
 * 2-space indent, one trailing newline, laid out as Prettier would print it
 * so the tracked file passes the project's `prettier --check`. The same
 * manifest gives the same text whatever its key insertion order.
 *
 * @example
 * ```ts
 * import { parseManifest, serializeManifest } from "./manifest.js";
 *
 * const text = serializeManifest(manifest);
 * parseManifest(text); // deep-equals manifest
 * ```
 */
export function serializeManifest(manifest: Manifest): string {
  return `${printValue(manifest, 0, "", "")}\n`;
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "cliVersion",
  "tokens",
  "packs",
  "files",
  "jsonKeys",
]);
const FILE_ENTRY_KEYS: ReadonlySet<string> = new Set(["sha256", "origin"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function invalid(detail: string): ManifestError {
  return new ManifestError(`invalid ${MANIFEST_RELATIVE_PATH}: ${detail}`);
}

/**
 * The own entries of `value`, which must be a plain object (`field` names it
 * in the error), refusing any prototype-sensitive key before it is used.
 */
function objectEntries(value: unknown, field: string): [string, unknown][] {
  if (!isPlainObject(value)) throw invalid(`${field} must be an object`);
  const entries = Object.entries(value);
  for (const [key] of entries) {
    if (isPrototypeSensitiveKey(key)) {
      throw invalid(`${field} holds the forbidden key ${JSON.stringify(key)}`);
    }
  }
  return entries;
}

/** Refuses a recorded path that could leave the project or reads differently per platform. */
function assertRelativePath(path: string, field: string): void {
  const segments = path.split("/");
  if (
    path.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw invalid(
      `${field} holds ${JSON.stringify(path)}, which is not a relative, /-separated path inside the project`,
    );
  }
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, v] of objectEntries(value, field)) {
    if (typeof v !== "string") {
      throw invalid(`${field}.${key} must be a string`);
    }
    result[key] = v;
  }
  return result;
}

function parseFileEntry(value: unknown, field: string): ManifestFileEntry {
  const entries = new Map(objectEntries(value, field));
  for (const key of entries.keys()) {
    if (!FILE_ENTRY_KEYS.has(key)) {
      throw invalid(`${field} has the unknown key ${JSON.stringify(key)}`);
    }
  }
  const sha256 = entries.get("sha256");
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw invalid(`${field}.sha256 must be 64 lowercase hex characters`);
  }
  const origin = entries.get("origin");
  if (origin !== "emitted" && origin !== "merged") {
    throw invalid(`${field}.origin must be "emitted" or "merged"`);
  }
  return { sha256, origin };
}

/**
 * Parses and strictly validates manifest text. Refused, each with a
 * {@link ManifestError} naming the offending field: text that is not JSON;
 * a non-object document; a `schemaVersion` other than
 * {@link MANIFEST_SCHEMA_VERSION}; a missing or ill-typed field; an unknown
 * top-level or file-entry key; a `sha256` that is not 64 lowercase hex
 * characters; an `origin` other than `emitted`/`merged`; a
 * `__proto__`/`constructor`/`prototype` key anywhere; and a path key that is
 * absolute, has an empty, `.` or `..` segment, or contains a backslash. The
 * result is a fresh object built from the validated values only.
 *
 * @example
 * ```ts
 * import { ManifestError, parseManifest } from "./manifest.js";
 *
 * try {
 *   const manifest = parseManifest(text);
 *   console.log(manifest.cliVersion);
 * } catch (error) {
 *   if (error instanceof ManifestError) console.error(error.message);
 * }
 * ```
 */
export function parseManifest(text: string): Manifest {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // The SyntaxError is not chained: its message can quote the text.
    throw invalid("not valid JSON");
  }
  const top = new Map(objectEntries(document, "the manifest"));
  for (const key of top.keys()) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw invalid(`unknown top-level key ${JSON.stringify(key)}`);
    }
  }

  const version = top.get("schemaVersion");
  if (version !== MANIFEST_SCHEMA_VERSION) {
    const shown =
      typeof version === "number" ? String(version) : typeof version;
    throw invalid(
      `unsupported schemaVersion ${shown} (this CLI reads ${String(MANIFEST_SCHEMA_VERSION)})`,
    );
  }

  const cliVersion = top.get("cliVersion");
  if (typeof cliVersion !== "string") {
    throw invalid("cliVersion must be a string");
  }

  const tokens = stringRecord(top.get("tokens"), "tokens");

  const rawPacks = top.get("packs");
  if (
    !Array.isArray(rawPacks) ||
    !rawPacks.every((p): p is string => typeof p === "string")
  ) {
    throw invalid("packs must be an array of strings");
  }

  const files: Record<string, ManifestFileEntry> = {};
  for (const [path, entry] of objectEntries(top.get("files"), "files")) {
    assertRelativePath(path, "files");
    files[path] = parseFileEntry(entry, `files[${JSON.stringify(path)}]`);
  }

  const jsonKeys: Record<string, Record<string, string>> = {};
  for (const [path, keys] of objectEntries(top.get("jsonKeys"), "jsonKeys")) {
    assertRelativePath(path, "jsonKeys");
    const field = `jsonKeys[${JSON.stringify(path)}]`;
    const hashes = stringRecord(keys, field);
    for (const [key, hash] of Object.entries(hashes)) {
      if (!SHA256_PATTERN.test(hash)) {
        throw invalid(`${field}.${key} must be 64 lowercase hex characters`);
      }
    }
    jsonKeys[path] = hashes;
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    cliVersion,
    tokens,
    packs: [...rawPacks],
    files,
    jsonKeys,
  };
}

/** The retry advice the `lstat` guards end a refusal with. */
const MANIFEST_SYMLINK_ADVICE = "replace it with a real directory or file";

/**
 * Writes `manifest` to `<targetDir>/.groundwork/manifest.json`, creating
 * `.groundwork/` if needed. The text is validated with
 * {@link parseManifest} first, so a manifest this CLI could not read back is
 * never written. Refuses (by `lstat`, before any write) a `.groundwork` that
 * is a symlink or not a directory, and a manifest path that is a symlink or a
 * directory, so nothing is written through a link. The write is atomic: the
 * text goes to a temp file in `.groundwork/` that is renamed over the
 * manifest, and the temp file is removed (best effort) on failure.
 *
 * @returns The absolute path written.
 * @throws {@link ManifestError} on any failure, the underlying error as
 *   `cause`; an existing manifest is left untouched.
 *
 * @example
 * ```ts
 * import { buildManifest, writeManifest } from "./manifest.js";
 *
 * writeManifest("/work/app", buildManifest(params));
 * ```
 */
export function writeManifest(targetDir: string, manifest: Manifest): string {
  const dir = join(targetDir, ".groundwork");
  const path = join(dir, "manifest.json");
  const tmpPath = `${path}.tmp`;
  let tmpCreated = false;
  try {
    const text = serializeManifest(manifest);
    parseManifest(text);
    assertDirectoryComponent(dir, MANIFEST_SYMLINK_ADVICE);
    assertFileDestination(path, MANIFEST_SYMLINK_ADVICE);
    mkdirSync(dir, { recursive: true });
    // Clear a crashed run's leftover (or a planted symlink), then create the
    // temp file exclusively: "wx" fails rather than following a link raced in.
    rmSync(tmpPath, { force: true });
    tmpCreated = true;
    writeFileSync(tmpPath, text, { flag: "wx" });
    renameSync(tmpPath, path);
    tmpCreated = false;
  } catch (cause) {
    if (tmpCreated) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Best effort: the write failure below is the error worth reporting.
      }
    }
    if (cause instanceof ManifestError) throw cause;
    throw new ManifestError(`could not write ${path}`, { cause });
  }
  return path;
}

/**
 * Reads and parses `<targetDir>/.groundwork/manifest.json`.
 *
 * @returns The manifest, or `undefined` when no manifest file exists (a
 *   missing `.groundwork/` included).
 * @throws {@link ManifestError} when the file exists but cannot be read
 *   (the read failure as `cause`) or does not parse; never `undefined` for
 *   a present file.
 *
 * @example
 * ```ts
 * import { readManifest } from "./manifest.js";
 *
 * const manifest = readManifest("/work/app");
 * if (manifest === undefined) console.log("legacy project: no manifest");
 * ```
 */
export function readManifest(targetDir: string): Manifest | undefined {
  const path = join(targetDir, ".groundwork", "manifest.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (isAbsentError(cause)) return undefined;
    throw new ManifestError(`could not read ${path}`, { cause });
  }
  return parseManifest(text);
}
