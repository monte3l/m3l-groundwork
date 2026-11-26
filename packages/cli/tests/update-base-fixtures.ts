// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures of the update-base and check-update suites: hand-built
 * template trees and the `TemplateHistory` that records them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TemplateHistory } from "../src/template-history.js";

/** sha256 hex of `data`. */
export function sha(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Writes `files` (relative path to content) under `root`. */
export function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** The history `core` map of `files`: each path to the sha256 of its content. */
export function hashesOf(
  files: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, sha(content)]),
  );
}

/** A history whose `versions` each record only a core tree. */
export function coreHistory(
  versions: Readonly<Record<string, Readonly<Record<string, string>>>>,
): TemplateHistory {
  return {
    schemaVersion: 1,
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, files]) => [
        version,
        { core: hashesOf(files), packs: {} },
      ]),
    ),
    blobs: {},
  };
}
