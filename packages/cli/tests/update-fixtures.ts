// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures of the `--update` staging suites: an "older release"
 * project with one upstream change per update category, and a reader for the
 * staged tree.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  BASE_DIR,
  BASE_SUFFIX,
  buildLock,
  LOCK_FILE,
  serializeLock,
} from "../src/lock.js";
import type { LockFile } from "../src/lock.js";
import type { TemplateHistory } from "../src/template-history.js";
import { templatesCoreDir } from "../src/main.js";
import { restoreDotfilePath } from "../src/assets.js";
import {
  bootstrapFresh,
  readLockOrThrow,
  readText,
  sha256,
  simulateOlder,
} from "./update-classify-fixtures.js";

export const RUNNING = "99.0.0";

/** The history `core` hashes of the running CLI's `templates/core`. */
export function currentCoreHashes(): Record<string, string> {
  const base = templatesCoreDir();
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(base, full).split("\\").join("/");
        out[restoreDotfilePath(rel)] = sha256(readFileSync(full, "utf8"));
      }
    }
  };
  walk(base);
  return out;
}

export function historyWith(
  core: Record<string, string>,
  version = "1.0.0",
): { history: TemplateHistory } {
  return {
    history: {
      schemaVersion: 1,
      versions: { [version]: { core, packs: {} } },
      blobs: {},
    },
  };
}

/** `runUpdate`'s deps for an update from 1.0.0 to RUNNING. */
export function updateDeps(): {
  history: { history: TemplateHistory };
  runningVersion: string;
} {
  // The release history knows nothing of ADDED, so a project without it
  // (and without a lock entry) has it classified as an add.
  const core = currentCoreHashes();
  delete core[ADDED];
  return { history: historyWith(core), runningVersion: RUNNING };
}

/** Drops `path` from the project and from its lock (so an update adds it). */
export function forgetFile(dir: string, path: string): void {
  rmSync(join(dir, path));
  const lock = readLockOrThrow(dir);
  writeFileSync(
    join(dir, LOCK_FILE),
    serializeLock(
      buildLock({
        baseVersion: lock.baseVersion,
        origin: lock.origin,
        tokens: lock.tokens,
        via: lock.via,
        updatedAt: lock.updatedAt,
        skip: lock.skip,
        files: lock.files.filter((file) => file.path !== path),
      }),
    ),
  );
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Every file the scenario touched, with the pristine (theirs) text. */
export interface Scenario {
  readonly pristine: string;
  readonly theirs: (path: string) => string;
}

export const TAKE = "lefthook.yml";
export const TEXT_MERGE = "eslint.config.js";
export const TEXT_CONFLICT = "vitest.config.ts";
export const JSON_MERGE = "package.json";
export const JSON_CONFLICT = "knip.json";
export const BINARY = "commitlint.config.js";
export const ADDED = "pnpm-workspace.yaml";

/**
 * Bootstraps `project` as installed from 1.0.0, then makes one upstream change
 * per category: a clean take, a clean text merge (different hunks), a text
 * conflict (same line), a clean JSON merge, a JSON key conflict, a non-UTF-8
 * local edit (review), and a file the project lacks (add).
 */
export function olderProject(project: string, pristineDir: string): Scenario {
  bootstrapFresh(pristineDir);
  bootstrapFresh(project);
  const theirs = (path: string): string => readText(pristineDir, path);

  simulateOlder(project, TAKE, "older: true\n");

  const swapFirstLine = (text: string, line: string): string =>
    [line, ...text.split("\n").slice(1)].join("\n");
  const mergeBase = swapFirstLine(theirs(TEXT_MERGE), "// old header");
  simulateOlder(project, TEXT_MERGE, mergeBase, `${mergeBase}// mine\n`);

  const conflictTheirs = theirs(TEXT_CONFLICT);
  simulateOlder(
    project,
    TEXT_CONFLICT,
    swapFirstLine(conflictTheirs, "// base line"),
    swapFirstLine(conflictTheirs, "// my line"),
  );

  const pkg = JSON.parse(theirs(JSON_MERGE)) as Record<string, unknown>;
  const pkgBase = { ...pkg, oldUpstream: 1 };
  simulateOlder(
    project,
    JSON_MERGE,
    json(pkgBase),
    json({ ...pkgBase, localKey: 2 }),
  );

  const knip = JSON.parse(theirs(JSON_CONFLICT)) as Record<string, unknown>;
  const withSchema = (schema: string): string =>
    json({ ...knip, $schema: schema });
  simulateOlder(
    project,
    JSON_CONFLICT,
    withSchema("https://example.com/base.json"),
    withSchema("https://example.com/mine.json"),
  );

  simulateOlder(project, BINARY, "// old commitlint\n");
  writeFileSync(
    join(project, BINARY),
    Buffer.from([0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28]),
  );

  forgetFile(project, ADDED);
  return { pristine: pristineDir, theirs };
}

export interface PlanFile {
  path: string;
  action: string;
  default: string;
  conflicts?: number;
  keyDiffs?: { pointer: string; resolution: string }[];
  staged: { theirs?: string; merged?: string; base?: string };
}

export interface UpdatePlan {
  schemaVersion: number;
  kind: string;
  cliVersion: string;
  generatedAt: string;
  targetDir: string;
  origin: string;
  requiredMode: string;
  base: { version: string; source: string; lockSha256: string | null };
  tokens: Record<string, string>;
  merge: { tool: string; gitVersion: string | null };
  files: PlanFile[];
  packs: {
    name: string;
    ledgerVersion: string | null;
    outdated: boolean;
    wiring: { added: unknown[]; removed: unknown[]; changed: unknown[] };
  }[];
  migrations: string[];
  skill: { status: string; files: string[] };
  summary: Record<string, number>;
  undetermined: string[];
  staged: { files: { path: string; staged: string; sha256: string }[] };
}

export const UPDATE_DIR = ".groundwork/update";

export function readPlan(project: string): UpdatePlan {
  return JSON.parse(
    readFileSync(join(project, UPDATE_DIR, "plan.json"), "utf8"),
  ) as UpdatePlan;
}

/** Every file under `<project>/.groundwork/update/`, relative to it. */
export function stagedFiles(project: string): string[] {
  const root = join(project, UPDATE_DIR);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export function planEntry(plan: UpdatePlan, path: string): PlanFile {
  const entry = plan.files.find((file) => file.path === path);
  if (entry === undefined) throw new Error(`plan has no entry for ${path}`);
  return entry;
}

export function readStaged(project: string, rel: string): string {
  return readFileSync(join(project, UPDATE_DIR, rel), "utf8");
}

/** Rewrites the project's lock files through `change`. */
export function changeLockFiles(
  dir: string,
  change: (files: readonly LockFile[]) => LockFile[],
): void {
  const lock = readLockOrThrow(dir);
  writeFileSync(
    join(dir, LOCK_FILE),
    serializeLock(
      buildLock({
        baseVersion: lock.baseVersion,
        origin: lock.origin,
        tokens: lock.tokens,
        via: lock.via,
        updatedAt: lock.updatedAt,
        skip: lock.skip,
        files: change(lock.files),
      }),
    ),
  );
}

/**
 * A file the 1.0.0 release shipped: present in the project with `text`, in
 * the lock (hash verified by a `.groundwork/base` snapshot) and unchanged.
 */
export function seedLegacyFile(dir: string, path: string, text: string): void {
  writeFileSync(join(dir, path), text);
  const snapshot = join(dir, BASE_DIR, `${path}${BASE_SUFFIX}`);
  mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, text);
  changeLockFiles(dir, (files) => [
    ...files,
    { path, source: "core", baseSha256: sha256(text), status: "installed" },
  ]);
}

/**
 * Turns `paths` (as left by `olderProject`) into files whose base is known
 * only from the template history: the lock records no hash, the snapshot is
 * removed, and the history's 1.0.0 `core` carries the old text as a blob.
 */
export function moveBaseToHistory(
  dir: string,
  paths: readonly string[],
): { history: TemplateHistory } {
  const core = currentCoreHashes();
  delete core[ADDED];
  const blobs: Record<string, string> = {};
  for (const path of paths) {
    const snapshot = join(dir, BASE_DIR, `${path}${BASE_SUFFIX}`);
    const text = readFileSync(snapshot, "utf8");
    rmSync(snapshot);
    core[path] = sha256(text);
    blobs[sha256(text)] = text;
  }
  changeLockFiles(dir, (files) =>
    files.map((file) =>
      paths.includes(file.path) ? { ...file, baseSha256: null } : file,
    ),
  );
  return {
    history: {
      schemaVersion: 1,
      versions: { "1.0.0": { core, packs: {} } },
      blobs,
    },
  };
}
