// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The update flow's migrations list (`data/migrations.json`): template files
 * a release renamed and pack wiring it removed, each tagged with the CLI
 * version that introduced it, so an update can replay exactly the steps
 * between a project's base version and the running CLI's.
 */
import { readFileSync } from "node:fs";
import { templateMigrationsPath } from "./assets.js";
import { isPrototypeSensitiveKey, isRecord } from "./merge-json.js";
import { compareVersions } from "./pack-installation.js";

/**
 * One migration: `id` is unique across the file, `since` the plain `x.y.z`
 * CLI version that introduced it. `renames` moves a template file (both
 * paths relative, `/`-separated); `removedWiring` names a pack wiring item a
 * release dropped.
 *
 * @example
 * ```ts
 * import type { Migration } from "./migrations.js";
 *
 * const migration: Migration = {
 *   id: "rename-lefthook",
 *   since: "1.6.0",
 *   renames: [{ from: "lefthook.yml", to: ".config/lefthook.yml" }],
 * };
 * ```
 */
export interface Migration {
  readonly id: string;
  readonly since: string;
  readonly renames?: readonly { readonly from: string; readonly to: string }[];
  readonly removedWiring?: readonly {
    readonly pack: string;
    readonly item: string;
  }[];
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

/** Thrown inside validation only; {@link loadMigrations} turns it into a note. */
class InvalidMigrationError extends Error {
  override readonly name = "InvalidMigrationError";
}

function fail(message: string): never {
  throw new InvalidMigrationError(message);
}

/** Narrows `value` to a plain object with no prototype-sensitive key. */
function safeRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${where} is not an object`);
  for (const key of Object.keys(value)) {
    if (isPrototypeSensitiveKey(key)) {
      fail(`${where} has the prototype-sensitive key "${key}"`);
    }
  }
  return value;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    fail(`${where} is not a non-empty string`);
  }
  return value;
}

/** A relative `/`-separated path with no empty, `.`, `..` or prototype-sensitive segment. */
function safePath(value: unknown, where: string): string {
  const path = nonEmptyString(value, where);
  if (path.includes("\\") || path.includes(":")) {
    fail(`${where} "${path}" holds a backslash or colon`);
  }
  for (const segment of path.split("/")) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      isPrototypeSensitiveKey(segment)
    ) {
      fail(`${where} "${path}" is not a safe relative path`);
    }
  }
  return path;
}

/** A non-empty string that is not a prototype-sensitive name. */
function safeName(value: unknown, where: string): string {
  const name = nonEmptyString(value, where);
  if (isPrototypeSensitiveKey(name)) {
    fail(`${where} "${name}" is a prototype-sensitive name`);
  }
  return name;
}

function arrayField(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} is not an array`);
  return value;
}

function parseMigration(raw: unknown, index: number): Migration {
  const where = `migration ${String(index)}`;
  const entry = safeRecord(raw, where);
  const id = nonEmptyString(entry["id"], `${where}'s id`);
  const since = nonEmptyString(entry["since"], `${where}'s since`);
  if (!PLAIN_VERSION.test(since)) {
    fail(`${where}'s since "${since}" is not a plain x.y.z version`);
  }
  const migration: {
    id: string;
    since: string;
    renames?: { from: string; to: string }[];
    removedWiring?: { pack: string; item: string }[];
  } = { id, since };
  if (entry["renames"] !== undefined) {
    migration.renames = arrayField(entry["renames"], `${where}'s renames`).map(
      (item, at) => {
        const rename = safeRecord(item, `${where}'s rename ${String(at)}`);
        return {
          from: safePath(rename["from"], `${where}'s rename from`),
          to: safePath(rename["to"], `${where}'s rename to`),
        };
      },
    );
  }
  if (entry["removedWiring"] !== undefined) {
    migration.removedWiring = arrayField(
      entry["removedWiring"],
      `${where}'s removedWiring`,
    ).map((item, at) => {
      const wiring = safeRecord(item, `${where}'s removedWiring ${String(at)}`);
      return {
        pack: safeName(wiring["pack"], `${where}'s removedWiring pack`),
        item: safeName(wiring["item"], `${where}'s removedWiring item`),
      };
    });
  }
  return migration;
}

function parseMigrations(text: string): Migration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new InvalidMigrationError("the file is not valid JSON", { cause });
  }
  const migrations = arrayField(parsed, "the top level").map(parseMigration);
  const ids = new Set<string>();
  for (const { id } of migrations) {
    if (ids.has(id)) fail(`duplicate migration id "${id}"`);
    ids.add(id);
  }
  return migrations;
}

/**
 * Loads and strictly validates the migrations list at `path` (the shipped
 * `data/migrations.json` by default). It never throws: a missing or
 * unreadable file, invalid JSON, a non-array top level or any invalid entry
 * (a missing, empty or duplicate id; a `since` that is not plain `x.y.z`; an
 * unsafe rename path; a prototype-sensitive key or name) is a `{ note }` the
 * caller reports, and no migration from the file is used.
 *
 * @example
 * ```ts
 * const loaded = loadMigrations();
 * if ("note" in loaded) console.warn(loaded.note);
 * else console.log(loaded.migrations.length);
 * ```
 */
export function loadMigrations(
  path?: string,
): { migrations: Migration[] } | { note: string } {
  let source = path;
  try {
    source ??= templateMigrationsPath();
    return { migrations: parseMigrations(readFileSync(source, "utf8")) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      note: `migrations ${source ?? "(unlocated)"} ignored: ${reason}`,
    };
  }
}

/**
 * The migrations an update from `baseVersion` to `runningVersion` replays:
 * those with `baseVersion < since <= runningVersion`, compared numerically.
 * A version that is not plain `x.y.z` selects nothing.
 *
 * @example
 * ```ts
 * applicableMigrations(migrations, "1.5.0", "1.10.0"); // since in (1.5.0, 1.10.0]
 * ```
 */
export function applicableMigrations(
  migrations: readonly Migration[],
  baseVersion: string,
  runningVersion: string,
): Migration[] {
  return migrations.filter(({ since }) => {
    const afterBase = compareVersions(baseVersion, since);
    const upToRunning = compareVersions(since, runningVersion);
    return (
      afterBase !== undefined &&
      afterBase < 0 &&
      upToRunning !== undefined &&
      upToRunning <= 0
    );
  });
}
