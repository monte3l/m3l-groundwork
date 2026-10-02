// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Compares `templates/core` (after token substitution) against a target
 * directory, file by file, without writing anything. `package.json` and any
 * `tsconfig*.json` get a key-level comparison rather than a whole-file one --
 * a whole-file conflict on `package.json` is a useless finding, since the
 * answer is always a merge, never "pick one file wholesale".
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import { parseJsonc } from "./jsonc.js";
import { isRecord } from "./merge-json.js";
import { blockedAbsentNote } from "./survey/internal/blocked-path.js";
import {
  probePath,
  probeSubject,
  readFailure,
  recordedReadCode,
  unreadableNote,
} from "./survey/internal/read-guard.js";
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

/**
 * Appends `note` unless already present: adopt mode passes the survey's own
 * list, and a pack and the baseline can name the same path.
 */
function recordOnce(undetermined: string[], note: string): void {
  if (!undetermined.includes(note)) undetermined.push(note);
}

function compareFile(
  relPath: string,
  baselineContent: string,
  targetPath: string,
  targetDir: string,
  undetermined: string[],
): FileConflict {
  // A real `stat`, never `existsSync`: a file under a directory this process
  // cannot search must not read as "absent" (a clean add `/customize` would
  // then write straight over). Something there this process cannot reach is
  // divergent -- it cannot be shown identical, and adopt mode never
  // overwrites -- with the errno recorded. Any other errno throws.
  const probe = probePath(targetPath);
  if (probe.kind === "absent") {
    // `absent` also covers a dangling symlink at the path or an ancestor
    // (`ENOENT`) and a regular file where an ancestor directory should be
    // (`ENOTDIR`): both are something in the project's tree a write would
    // have to go through, so they are divergent, recorded once, never a
    // silent clean add.
    const note = blockedAbsentNote(targetPath, targetDir);
    if (note === undefined) {
      return { relPath, status: "absent", keyDiffs: undefined };
    }
    recordOnce(undetermined, note);
    return { relPath, status: "divergent", keyDiffs: undefined };
  }
  if (probe.kind === "unresolvable") {
    // A permission failure names the enclosing directory (the `stat` needed
    // search permission there, not on the file), so every baseline file
    // under one locked directory shares a single note; a symlink loop names
    // the path itself.
    recordOnce(
      undetermined,
      unreadableNote(probeSubject(targetPath, probe.code), probe.code),
    );
    return { relPath, status: "divergent", keyDiffs: undefined };
  }

  // A read failure that is a property of the project's tree (a permission
  // failure, a directory where the baseline has a file) is divergent too --
  // it cannot be shown identical -- and is recorded naming the path, so the
  // report never shows "divergent" with no reason behind it.
  let targetContent: string;
  try {
    targetContent = readFileSync(targetPath, "utf8");
  } catch (error) {
    const code = recordedReadCode(error);
    if (code === undefined) throw readFailure(targetPath, error);
    recordOnce(undetermined, unreadableNote(targetPath, code));
    return { relPath, status: "divergent", keyDiffs: undefined };
  }

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
  undetermined: string[],
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const sourcePath = join(currentDir, entry.name);
    const relPath = restoreDotfilePath(
      applyTokens(relative(root, sourcePath), tokens),
    );

    if (entry.isDirectory()) {
      walkTemplate(root, sourcePath, targetDir, tokens, results, undetermined);
      continue;
    }

    const baselineContent = applyTokens(
      readFileSync(sourcePath, "utf8"),
      tokens,
    );
    results.push(
      compareFile(
        relPath,
        baselineContent,
        join(targetDir, relPath),
        targetDir,
        undetermined,
      ),
    );
  }
}

/**
 * Compares every file `templates/core` (or a pack's `files/`) would emit
 * against what `targetDir` already has. A target path this process cannot
 * reach (`EACCES`/`EPERM`/`ELOOP`) is never reported `absent`: it is
 * `divergent`, and a note naming the errno is appended to `undetermined`
 * once (adopt mode passes the survey's own list, so the report shows it) --
 * naming the enclosing directory for a permission failure on the `stat`, the
 * path itself for a symlink loop, or for a permission failure or a
 * directory-where-a-file-was-expected (`EISDIR`) on the read. A dangling
 * symlink at the target path is `divergent` too, recorded naming the path;
 * so is a dangling symlink at one of its ancestors below `targetDir`,
 * recorded once naming that ancestor. A regular file where an enclosing
 * directory should be (`ENOTDIR`) is `divergent`, recorded once naming that
 * blocking ancestor. A genuinely missing path is `absent`; any other errno
 * throws.
 *
 * @example
 * ```ts
 * const undetermined: string[] = [];
 * const conflicts = planConflicts(templateRoot, targetDir, tokens, undetermined);
 * ```
 */
export function planConflicts(
  templateRoot: string,
  targetDir: string,
  tokens: TokenTable,
  undetermined: string[] = [],
): FileConflict[] {
  const results: FileConflict[] = [];
  walkTemplate(
    templateRoot,
    templateRoot,
    targetDir,
    tokens,
    results,
    undetermined,
  );
  return results;
}
