// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Fresh mode's closing record of what it bootstrapped: a byte-identical
 * `.base` copy of every file it wrote under `.groundwork/base/`, the
 * `.groundwork/installed-packs.json` ledger when a `--pack` was installed,
 * and `.groundwork/groundwork.lock.json` last -- the lock's presence means
 * the record is complete.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { toPosixPath } from "./assets.js";
import {
  assertDirectoryComponent,
  assertFileDestination,
  FRESH_SYMLINK_ADVICE,
} from "./fs-guard.js";
import { resolveCliVersion } from "./inventory.js";
import type { LockFile } from "./lock.js";
import {
  BASE_DIR,
  BASE_SUFFIX,
  buildLock,
  LOCK_FILE,
  serializeLock,
} from "./lock.js";
import { isPrototypeSensitiveKey, isRecord } from "./merge-json.js";
import { LEDGER_PATH, LEDGER_SCHEMA_VERSION } from "./pack-installation.js";
import { packManifestSha256 } from "./packs.js";
import type { PackManifest } from "./packs.js";
import { stagedNameFor } from "./staging.js";
import type { TokenTable } from "./tokens.js";

/**
 * One installed pack as {@link recordFreshBootstrap} needs it.
 *
 * @example
 * ```ts
 * import { loadPack } from "./packs.js";
 * import type { RecordedPack } from "./record-bootstrap.js";
 *
 * const recorded: RecordedPack = {
 *   manifest: loadPack("quality").manifest,
 *   filesWritten: [".editorconfig"],
 *   wiringApplied: [],
 * };
 * ```
 */
export interface RecordedPack {
  readonly manifest: PackManifest;
  readonly filesWritten: readonly string[];
  readonly wiringApplied: readonly string[];
}

/** What fresh mode wrote, by writer. Paths are relative to the target. */
interface FreshRecordInput {
  readonly targetDir: string;
  readonly tokens: TokenTable;
  readonly coreFiles: readonly string[];
  readonly skillFiles: readonly string[];
  readonly packs: readonly RecordedPack[];
}

/** The sibling the lock is written to before being renamed into place. */
const TEMP_LOCK_FILE = `${LOCK_FILE}.tmp`;

/**
 * The lock's update skip list for a fresh bootstrap: the README is tokenized
 * and the project's to rewrite, so updates leave it alone.
 */
const FRESH_LOCK_SKIP: readonly string[] = ["README.md"];

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Native-separator absolute path of a `/`-separated project-relative one. */
function inTarget(targetDir: string, relPath: string): string {
  return join(targetDir, ...relPath.split("/"));
}

function writeFileCreatingDirs(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** Why `text` is not a ledger this run may merge into, or `undefined`. */
function ledgerDefect(value: unknown): string | undefined {
  if (!isRecord(value)) return "not a JSON object";
  if (value["schemaVersion"] !== LEDGER_SCHEMA_VERSION) {
    return `schemaVersion is not ${String(LEDGER_SCHEMA_VERSION)}`;
  }
  const packs = Object.hasOwn(value, "packs") ? value["packs"] : undefined;
  if (!Array.isArray(packs)) return "packs is not an array";
  for (const entry of packs as unknown[]) {
    const name = isRecord(entry) ? entry["name"] : undefined;
    if (typeof name === "string" && isPrototypeSensitiveKey(name)) {
      return `a pack is named ${JSON.stringify(name)}`;
    }
  }
  return undefined;
}

/**
 * The existing ledger's top-level object, `undefined` when there is none.
 * Throws an `Error` naming {@link LEDGER_PATH} and "not a valid ledger" on
 * invalid JSON or a {@link ledgerDefect}; the parser's own error is not
 * chained, since its message can quote the content.
 */
function readExistingLedger(
  targetDir: string,
): Record<string, unknown> | undefined {
  const path = inTarget(targetDir, LEDGER_PATH);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  let value: unknown;
  let defect: string | undefined;
  try {
    value = JSON.parse(text);
    defect = ledgerDefect(value);
  } catch {
    defect = "invalid JSON";
  }
  if (defect !== undefined || !isRecord(value)) {
    throw new Error(
      `${LEDGER_PATH} in ${targetDir} is not a valid ledger (${defect ?? "not a JSON object"}) -- fix or remove it, then re-run with --fresh --force`,
    );
  }
  return value;
}

/**
 * `existing`'s packs with each same-name entry replaced by its `fresh` one
 * (in place, once), entries this run did not install kept untouched, and
 * the remaining fresh entries appended. A same-name duplicate already in
 * the ledger collapses into the replaced entry: only its first occurrence
 * survives, as the fresh one.
 */
function mergeLedgerPacks(
  existing: readonly unknown[],
  fresh: readonly { readonly name: string }[],
): unknown[] {
  const pending = new Map(fresh.map((entry) => [entry.name, entry]));
  const placed = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of existing) {
    const name = isRecord(entry) ? entry["name"] : undefined;
    const replacement =
      typeof name === "string" ? pending.get(name) : undefined;
    if (replacement === undefined) {
      merged.push(entry);
    } else if (!placed.has(replacement.name)) {
      merged.push(replacement);
      placed.add(replacement.name);
    }
  }
  for (const entry of fresh) {
    if (!placed.has(entry.name)) merged.push(entry);
  }
  return merged;
}

function hashOf(hashes: ReadonlyMap<string, string>, path: string): string {
  const hash = hashes.get(path);
  if (hash === undefined) {
    throw new Error(`record-bootstrap: no hash recorded for ${path}`);
  }
  return hash;
}

/**
 * Throws, before fresh mode's first write, when the record's destinations
 * are unsafe: `.groundwork` or `.groundwork/base` a symlink or a
 * non-directory, or the lock, its temporary sibling or the ledger path a
 * symlink or a directory; or
 * when an existing ledger is not one this run can merge into (invalid
 * JSON, a `schemaVersion` other than 1, a non-array `packs`, or an entry
 * named `__proto__`/`constructor`/`prototype`). Nothing is written either
 * way.
 *
 * @throws `Error` naming the offending path, ending with the fresh-mode
 *   retry advice (for a bad ledger: naming it and "not a valid ledger").
 *
 * @example
 * ```ts
 * import { assertSafeRecordDestination } from "./record-bootstrap.js";
 *
 * assertSafeRecordDestination("/work/app"); // throws on a symlinked .groundwork
 * ```
 */
export function assertSafeRecordDestination(targetDir: string): void {
  assertDirectoryComponent(
    join(targetDir, ".groundwork"),
    FRESH_SYMLINK_ADVICE,
  );
  assertDirectoryComponent(inTarget(targetDir, BASE_DIR), FRESH_SYMLINK_ADVICE);
  assertFileDestination(inTarget(targetDir, LOCK_FILE), FRESH_SYMLINK_ADVICE);
  assertFileDestination(
    inTarget(targetDir, TEMP_LOCK_FILE),
    FRESH_SYMLINK_ADVICE,
  );
  assertFileDestination(inTarget(targetDir, LEDGER_PATH), FRESH_SYMLINK_ADVICE);
  readExistingLedger(targetDir);
}

/**
 * Records a fresh bootstrap. Each written path is attributed to `core`,
 * `skill` or `pack:<name>` (a pack's own file wins over a baseline file at
 * the same path; a file a pack only merged into stays `core`), its current
 * bytes are hashed and copied to `.groundwork/base/<path>.base`, then the
 * ledger (only when `packs` is non-empty) and finally the lock are written.
 * A previous lock is removed first and a previous `.groundwork/base/`
 * replaced, so a re-record that fails midway leaves no lock claiming a
 * complete record. An existing ledger is merged by pack name: this run's
 * packs replace same-name entries, other entries are kept untouched, and
 * with no packs the file is left byte-identical.
 *
 * @returns How many files the lock records.
 * @throws The underlying filesystem error, unwrapped -- the caller words
 *   the retry advice.
 *
 * @example
 * ```ts
 * import { recordFreshBootstrap } from "./record-bootstrap.js";
 *
 * const count = recordFreshBootstrap({
 *   targetDir: "/work/app",
 *   tokens: { PROJECT_NAME: "app" },
 *   coreFiles: ["package.json"],
 *   skillFiles: [".claude/skills/customize/SKILL.md"],
 *   packs: [],
 * });
 * console.log(`recorded ${String(count)} files`);
 * ```
 */
export function recordFreshBootstrap(input: FreshRecordInput): number {
  const { targetDir, tokens, coreFiles, skillFiles, packs } = input;
  const sources = new Map<string, string>();
  for (const path of coreFiles) sources.set(toPosixPath(path), "core");
  for (const path of skillFiles) sources.set(toPosixPath(path), "skill");
  for (const { manifest, filesWritten } of packs) {
    for (const path of filesWritten) {
      sources.set(toPosixPath(path), `pack:${manifest.name}`);
    }
  }

  // The lock goes first: its presence must keep meaning "record complete".
  // force only ignores a missing file; any other failure propagates.
  const lockPath = inTarget(targetDir, LOCK_FILE);
  rmSync(lockPath, { force: true });
  rmSync(inTarget(targetDir, BASE_DIR), { recursive: true, force: true });

  const files: LockFile[] = [];
  const hashes = new Map<string, string>();
  // buildLock sorts the entries by path.
  for (const [path, source] of sources) {
    const bytes = readFileSync(inTarget(targetDir, path));
    writeFileCreatingDirs(
      inTarget(targetDir, stagedNameFor(`${BASE_DIR}/${path}`, BASE_SUFFIX)),
      bytes,
    );
    const baseSha256 = sha256(bytes);
    hashes.set(path, baseSha256);
    files.push({ path, source, baseSha256, status: "installed" });
  }

  const cliVersion = resolveCliVersion();
  const now = new Date().toISOString();
  if (packs.length > 0) {
    const fresh = packs.map(({ manifest, filesWritten, wiringApplied }) => ({
      name: manifest.name,
      installedAt: now,
      via: "fresh",
      cliVersion,
      manifestSha256: packManifestSha256(manifest),
      files: filesWritten.map((raw) => {
        const path = toPosixPath(raw);
        return { path, sha256: hashOf(hashes, path) };
      }),
      wiring: { applied: [...wiringApplied], skipped: [] },
      dropped: [],
    }));
    const existing = readExistingLedger(targetDir);
    const existingPacks = existing?.["packs"];
    const ledger = {
      ...existing,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      packs: Array.isArray(existingPacks)
        ? mergeLedgerPacks(existingPacks as unknown[], fresh)
        : fresh,
    };
    writeFileCreatingDirs(
      inTarget(targetDir, LEDGER_PATH),
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
  }

  const lock = buildLock({
    baseVersion: cliVersion,
    origin: "fresh",
    tokens: { ...tokens },
    via: "fresh",
    updatedAt: now,
    skip: FRESH_LOCK_SKIP,
    files,
  });
  // Written to a sibling and renamed into place, so a torn write never
  // leaves a partial lock; on failure the sibling is removed too.
  const tempLock = inTarget(targetDir, TEMP_LOCK_FILE);
  try {
    writeFileCreatingDirs(tempLock, serializeLock(lock));
    renameSync(tempLock, lockPath);
  } catch (error) {
    try {
      rmSync(tempLock, { force: true });
    } catch {
      // Best effort: the write/rename failure above is the error to report.
    }
    throw error;
  }
  return files.length;
}
