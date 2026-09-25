/**
 * Compares `templates/core` (after token substitution) against a target
 * directory, file by file, without writing anything. `package.json` and any
 * `tsconfig*.json` get a key-level comparison rather than a whole-file one --
 * a whole-file conflict on `package.json` is a useless finding, since the
 * answer is always a merge, never "pick one file wholesale".
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import { parseJsonc } from "./jsonc.js";
import { isRecord } from "./merge-json.js";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

type ConflictStatus = "absent" | "identical" | "divergent";

export interface FileConflict {
  relPath: string;
  status: ConflictStatus;
  /** Present only for a key-level comparison (package.json / tsconfig*.json): the top-level keys that differ. */
  keyDiffs: string[] | undefined;
}

function isKeyLevelJsonFile(relPath: string): boolean {
  const name = basename(relPath);
  return name === "package.json" || /^tsconfig(\..+)?\.json$/.test(name);
}

function compareJsonKeys(
  baselineContent: string,
  targetContent: string,
): string[] | undefined {
  const baseline = parseJsonc(baselineContent);
  const target = parseJsonc(targetContent);
  if (!baseline.ok || !target.ok) {
    return undefined;
  }
  // Valid JSON need not be an object (`null`, a number, an array): a key-level
  // compare is meaningless there, so take the same whole-file fallback as an
  // unparseable file.
  const baselineValue = baseline.value;
  const targetValue = target.value;
  if (!isRecord(baselineValue) || !isRecord(targetValue)) {
    return undefined;
  }
  const keys = new Set([
    ...Object.keys(baselineValue),
    ...Object.keys(targetValue),
  ]);
  const diffs: string[] = [];
  for (const key of keys) {
    if (
      JSON.stringify(baselineValue[key]) !== JSON.stringify(targetValue[key])
    ) {
      diffs.push(key);
    }
  }
  return diffs;
}

function compareFile(
  relPath: string,
  baselineContent: string,
  targetPath: string,
): FileConflict {
  if (!existsSync(targetPath)) {
    return { relPath, status: "absent", keyDiffs: undefined };
  }

  const targetContent = readFileSync(targetPath, "utf8");

  if (isKeyLevelJsonFile(relPath)) {
    const keyDiffs = compareJsonKeys(baselineContent, targetContent);
    if (keyDiffs !== undefined) {
      return {
        relPath,
        status: keyDiffs.length === 0 ? "identical" : "divergent",
        keyDiffs,
      };
    }
    // Fall through to a whole-file compare if either side failed to parse.
  }

  return {
    relPath,
    status: baselineContent === targetContent ? "identical" : "divergent",
    keyDiffs: undefined,
  };
}

function walkTemplate(
  root: string,
  currentDir: string,
  targetDir: string,
  tokens: TokenTable,
  results: FileConflict[],
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const sourcePath = join(currentDir, entry.name);
    const relPath = restoreDotfilePath(
      applyTokens(relative(root, sourcePath), tokens),
    );

    if (entry.isDirectory()) {
      walkTemplate(root, sourcePath, targetDir, tokens, results);
      continue;
    }

    const baselineContent = applyTokens(
      readFileSync(sourcePath, "utf8"),
      tokens,
    );
    results.push(
      compareFile(relPath, baselineContent, join(targetDir, relPath)),
    );
  }
}

/** Compares every file `templates/core` would emit against what `targetDir` already has. */
export function planConflicts(
  templateRoot: string,
  targetDir: string,
  tokens: TokenTable,
): FileConflict[] {
  const results: FileConflict[] = [];
  walkTemplate(templateRoot, templateRoot, targetDir, tokens, results);
  return results;
}
