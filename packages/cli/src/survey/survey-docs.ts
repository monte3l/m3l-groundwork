/**
 * Indexes human-facing docs and guidelines: `CONTRIBUTING.md`, a
 * `docs/contributing/` tree, ADR/decision/RFC directories, style guides, and
 * the README's own heading outline. This is an index (path, size, headings)
 * so `/customize`'s Step 0 knows what exists and where to read it in full --
 * it never inlines a doc's content itself, which would make the survey's
 * own output as large as the docs it's indexing.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkBounded } from "./fs-walk.js";
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

function indexFile(path: string): DocFile {
  const content = readFileSync(path, "utf8");
  return {
    path,
    sizeBytes: statSync(path).size,
    headings: extractHeadings(content),
  };
}

function collectRootMarkdown(dir: string): DocFile[] {
  const found: DocFile[] = [];
  for (const name of NAMED_ROOT_CANDIDATES) {
    const path = join(dir, name);
    if (existsSync(path)) found.push(indexFile(path));
  }
  for (const entry of walkBounded(dir, 0)) {
    if (!entry.isDirectory && /^STYLE.*\.md$/i.test(entry.relPath)) {
      found.push(indexFile(entry.path));
    }
  }
  return found;
}

function collectNamedDirectories(dir: string): DocFile[] {
  const found: DocFile[] = [];
  for (const relDir of NAMED_DIR_CANDIDATES) {
    const absDir = join(dir, relDir);
    if (!existsSync(absDir)) continue;
    for (const entry of walkBounded(absDir, 2)) {
      if (!entry.isDirectory && entry.relPath.endsWith(".md")) {
        found.push(indexFile(entry.path));
      }
    }
  }
  return found;
}

/** Indexes docs/guideline files at `dir`. Offline, read-only, index-only -- no full content. */
export function surveyDocs(dir: string): DocsSurvey {
  return {
    files: [...collectRootMarkdown(dir), ...collectNamedDirectories(dir)],
  };
}
