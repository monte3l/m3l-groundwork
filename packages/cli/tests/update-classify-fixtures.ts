// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures of the update-classify, theirs-tree and check-update
 * suites: a real fresh bootstrap (baseline, packs, skill, lock and base
 * snapshots) and helpers that simulate an older release.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitTemplate } from "../src/emit.js";
import {
  BASE_DIR,
  BASE_SUFFIX,
  LOCK_FILE,
  buildLock,
  readLock,
  serializeLock,
} from "../src/lock.js";
import type { Lock } from "../src/lock.js";
import { templatesCoreDir } from "../src/main.js";
import { installPack, loadPack } from "../src/packs.js";
import { installCustomizeSkill } from "../src/plugin.js";
import { recordFreshBootstrap } from "../src/record-bootstrap.js";
import type { RecordedPack } from "../src/record-bootstrap.js";
import type { TemplateHistory } from "../src/template-history.js";

export const TOKENS = { PROJECT_NAME: "acme", YEAR: "2026" };

/** An empty template history. */
export const EMPTY_HISTORY: TemplateHistory = {
  schemaVersion: 1,
  versions: {},
  blobs: {},
};

/** sha256 hex of `data`. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** What fresh mode does: baseline, packs, skill, then the lock record. */
export function bootstrapFresh(dir: string, packs: string[] = []): Lock {
  const coreResult = emitTemplate(templatesCoreDir(), dir, TOKENS);
  const recorded: RecordedPack[] = packs.map((name) => {
    const pack = loadPack(name);
    const result = installPack(pack, dir, TOKENS);
    return {
      manifest: pack.manifest,
      filesWritten: result.filesWritten,
      wiringApplied: result.wiringApplied,
    };
  });
  const skill = installCustomizeSkill(dir);
  recordFreshBootstrap({
    targetDir: dir,
    tokens: TOKENS,
    coreFiles: coreResult.filesWritten,
    skillFiles: skill.filesWritten,
    packs: recorded,
  });
  return readLockOrThrow(dir);
}

export function readLockOrThrow(dir: string): Lock {
  const read = readLock(dir);
  if (!("lock" in read)) throw new Error("fixture: no lock was recorded");
  return read.lock;
}

/**
 * Simulates the project having been installed from an older release in
 * which `path` held `oldText`: the base snapshot and the lock's hash say
 * so, and (unless `edited` is given) the project file holds it untouched.
 * `edited`, when given, is what the project file holds instead.
 */
export function simulateOlder(
  dir: string,
  path: string,
  oldText: string,
  edited?: string,
  baseVersion = "1.0.0",
): void {
  const basePath = join(dir, BASE_DIR, `${path}${BASE_SUFFIX}`);
  mkdirSync(dirname(basePath), { recursive: true });
  writeFileSync(basePath, oldText);
  writeFileSync(join(dir, path), edited ?? oldText);
  const lock = readLockOrThrow(dir);
  writeFileSync(
    join(dir, LOCK_FILE),
    serializeLock(
      buildLock({
        baseVersion,
        origin: lock.origin,
        tokens: lock.tokens,
        via: lock.via,
        updatedAt: lock.updatedAt,
        skip: lock.skip,
        files: lock.files.map((file) =>
          file.path === path ? { ...file, baseSha256: sha256(oldText) } : file,
        ),
      }),
    ),
  );
}

export function readText(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}
