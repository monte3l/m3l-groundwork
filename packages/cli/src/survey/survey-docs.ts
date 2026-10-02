// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Indexes human-facing docs and guidelines: `CONTRIBUTING.md`, a
 * `docs/contributing/` tree, ADR/decision/RFC directories, style guides, and
 * the README's own heading outline. This is an index (path, size, headings)
 * so `/customize`'s Step 0 (the adopt-mode reconcile step in `/customize`)
 * knows what exists and where to read it in full --
 * it never inlines a doc's content itself, which would make the survey's
 * own output as large as the docs it's indexing.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkBounded } from "./fs-walk.js";
import { guardedExists, guardedRead } from "./internal/read-guard.js";
import type { DocFile, DocsSurvey } from "./types.js";

const NAMED_ROOT_CANDIDATES = ["README.md", "CONTRIBUTING.md"];

const NAMED_DIR_CANDIDATES = [
  "docs/contributing",
  "docs/adr",
  "docs/decisions",
  "docs/rfcs",
  "decisions",
  "adr",
];

function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#{1,3}\s*/, "").trim());
}

/**
 * Indexes one doc. Its size comes from `statSync`, which needs no read
 * permission on the file itself, so an unreadable doc keeps its entry with
 * empty `headings` (and is recorded); a doc that cannot even be stat'ed is
 * left out (and recorded).
 */
function indexFile(path: string, undetermined: string[]): DocFile | undefined {
  const sizeBytes = guardedRead(path, () => statSync(path).size, undetermined);
  if (sizeBytes === undefined) return undefined;
  const content = guardedRead(
    path,
    () => readFileSync(path, "utf8"),
    undetermined,
  );
  return {
    path,
    sizeBytes,
    headings: content === undefined ? [] : extractHeadings(content),
  };
}

function collectRootMarkdown(dir: string, undetermined: string[]): DocFile[] {
  const paths: string[] = [];
  for (const name of NAMED_ROOT_CANDIDATES) {
    const path = join(dir, name);
    if (guardedExists(path, undetermined)) paths.push(path);
  }
  for (const entry of walkBounded(dir, 0, undetermined)) {
    if (!entry.isDirectory && /^STYLE.*\.md$/i.test(entry.relPath)) {
      paths.push(entry.path);
    }
  }
  return indexAll(paths, undetermined);
}

function collectNamedDirectories(
  dir: string,
  undetermined: string[],
): DocFile[] {
  const paths: string[] = [];
  for (const relDir of NAMED_DIR_CANDIDATES) {
    const absDir = join(dir, relDir);
    if (!guardedExists(absDir, undetermined)) continue;
    for (const entry of walkBounded(absDir, 2, undetermined)) {
      if (!entry.isDirectory && entry.relPath.endsWith(".md")) {
        paths.push(entry.path);
      }
    }
  }
  return indexAll(paths, undetermined);
}

function indexAll(paths: readonly string[], undetermined: string[]): DocFile[] {
  const found: DocFile[] = [];
  for (const path of paths) {
    const file = indexFile(path, undetermined);
    if (file !== undefined) found.push(file);
  }
  return found;
}

/**
 * Indexes docs/guideline files at `dir`. Offline, read-only, index-only --
 * no full content. A doc or doc directory that exists but cannot be read
 * (`EACCES`/`EPERM`) is recorded in `undetermined` (an unreadable doc keeps
 * its entry with empty `headings`); any other read failure throws, naming
 * the path, with the original failure as `cause`.
 *
 * @example
 * ```ts
 * import { surveyDocs } from "./survey-docs.js";
 *
 * const undetermined: string[] = [];
 * const docs = surveyDocs("/path/to/project", undetermined);
 * console.log(docs.files.map((file) => file.path), undetermined);
 * ```
 */
export function surveyDocs(dir: string, undetermined: string[]): DocsSurvey {
  return {
    files: [
      ...collectRootMarkdown(dir, undetermined),
      ...collectNamedDirectories(dir, undetermined),
    ],
  };
}
