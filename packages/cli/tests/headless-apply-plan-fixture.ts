// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixture for the `--adopt --apply --dry-run` tests: a small legacy
 * project (tsconfig.json diverges from the baseline, the rest is absent), a
 * byte-level tree snapshot, and a helper that completes the survey's pending
 * document into an answers file `--apply` accepts.
 */
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { join, relative } from "node:path";

export const PENDING_REL = ".groundwork/headless/pending.json";
export const INVENTORY_REL = ".groundwork/inventory.json";

export function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function writeProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "legacy", type: "module" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: false } }),
  );
}

/** Every file (and symlink) under `root`, keyed by relative POSIX path, valued by content hash; empty directories are keyed too. */
export function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0 && dir !== root) {
      snapshot.set(`${relative(root, dir).split("\\").join("/")}/`, "dir");
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (lstatSync(abs).isSymbolicLink()) {
        snapshot.set(rel, `link:${readlinkSync(abs)}`);
      } else if (entry.isDirectory()) {
        visit(abs);
      } else {
        snapshot.set(rel, sha256Of(readFileSync(abs)));
      }
    }
  };
  visit(root);
  return snapshot;
}

type Json = Record<string, unknown>;

/**
 * The survey's pending document, completed: kind and runtime chosen, every
 * conflict resolved with `resolution` (default `take`), every addition kept
 * as the survey offered it (`add`), `pending` emptied.
 */
export function completeAnswers(
  pending: Json,
  options: { resolution?: string; addition?: string } = {},
): Json {
  const doc = structuredClone(pending);
  const interview = doc["interview"] as Json;
  interview["kind"] = "library";
  interview["runtime"] = "node";
  const adopt = doc["adopt"] as {
    additions: Json[];
    conflicts: Json[];
  };
  for (const conflict of adopt.conflicts) {
    conflict["resolution"] = options.resolution ?? "take";
  }
  if (options.addition !== undefined) {
    for (const addition of adopt.additions)
      addition["action"] = options.addition;
  }
  doc["pending"] = [];
  return doc;
}
