/**
 * Copies `templates/core` into a target directory, applying token
 * substitution to both file contents and path segments (so a token in a
 * directory or file NAME, not just its content, is honored).
 */
import {
  readdirSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join, relative, dirname, extname } from "node:path";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

// Extensions copied byte-for-byte, never text-decoded -- token substitution
// only makes sense for text content.
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico"]);

export interface EmitResult {
  filesWritten: string[];
}

/** Recursively copies `sourceDir` into `targetDir`, applying `tokens`. */
export function emitTemplate(
  sourceDir: string,
  targetDir: string,
  tokens: TokenTable,
): EmitResult {
  const filesWritten: string[] = [];
  walk(sourceDir, sourceDir, targetDir, tokens, filesWritten);
  return { filesWritten };
}

function walk(
  root: string,
  currentSourceDir: string,
  targetRoot: string,
  tokens: TokenTable,
  filesWritten: string[],
): void {
  for (const entry of readdirSync(currentSourceDir, { withFileTypes: true })) {
    const sourcePath = join(currentSourceDir, entry.name);
    const relPath = applyTokens(relative(root, sourcePath), tokens);
    const targetPath = join(targetRoot, relPath);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      walk(root, sourcePath, targetRoot, tokens, filesWritten);
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });

    if (BINARY_EXTENSIONS.has(extname(entry.name))) {
      copyFileSync(sourcePath, targetPath);
    } else {
      const content = readFileSync(sourcePath, "utf8");
      writeFileSync(targetPath, applyTokens(content, tokens));
    }

    filesWritten.push(relPath);
  }
}
