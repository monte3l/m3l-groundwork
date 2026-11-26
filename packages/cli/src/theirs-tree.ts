// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The "theirs" side of an update: the project the running CLI would
 * bootstrap today, built in a private temp directory through the same code
 * paths fresh mode runs (baseline, packs, then the `/customize` skill).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAsset, toPosixPath } from "./assets.js";
import { emitTemplate } from "./emit.js";
import { installPack, listPackNames, loadPack, packsRootDir } from "./packs.js";
import { installCustomizeSkill } from "./plugin.js";
import type { TokenTable } from "./tokens.js";

/**
 * Who placed a file: the baseline (`core`), the `/customize` skill
 * (`skill`) or a pack (`pack:<name>`).
 *
 * @example
 * ```ts
 * const source: FileSource = "pack:quality";
 * ```
 */
export type FileSource = "core" | "skill" | `pack:${string}`;

/**
 * What {@link buildTheirsTree} needs: the token table to apply, the packs to
 * install (in order), and optional overrides of the running CLI's
 * `templates/core` and `templates/packs`.
 *
 * @example
 * ```ts
 * const input: TheirsTreeInput = { tokens: { PROJECT_NAME: "acme" }, packNames: ["quality"] };
 * ```
 */
export interface TheirsTreeInput {
  readonly tokens: TokenTable;
  readonly packNames: readonly string[];
  readonly coreDir?: string | undefined;
  readonly packsRoot?: string | undefined;
}

/**
 * A built theirs tree: its directory, the source of every file written
 * (keyed by `/`-separated project path), the requested packs this CLI no
 * longer ships, and an idempotent `cleanup()` that removes the directory.
 *
 * @example
 * ```ts
 * const theirs: TheirsTree = buildTheirsTree({ tokens, packNames: [] });
 * theirs.cleanup();
 * ```
 */
export interface TheirsTree {
  readonly dir: string;
  readonly sources: ReadonlyMap<string, FileSource>;
  readonly missingPacks: readonly string[];
  readonly cleanup: () => void;
}

function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Records every written path under its `/`-separated form. */
function record(
  sources: Map<string, FileSource>,
  paths: readonly string[],
  source: FileSource,
): void {
  for (const path of paths) sources.set(toPosixPath(path), source);
}

/**
 * Builds, in a fresh `m3l-theirs-*` directory under `os.tmpdir()`, exactly
 * what a fresh bootstrap with `packNames` would write today. A pack the CLI
 * no longer ships is listed in `missingPacks` instead of failing the build.
 * A file a pack writes is attributed to the pack even when the baseline
 * wrote it first; a file a pack only merged wiring into stays `core`. Any
 * failure removes the directory (best effort) before rethrowing the
 * original error. The caller must call `cleanup()` (preferably in a
 * `finally`); `cleanup()` throws when the directory cannot be removed, so
 * the caller can report what was left behind.
 *
 * @throws the underlying emit or install error when the tree cannot be
 *   built (for instance an unreadable `templates/core`), never an error
 *   from the removal that follows it.
 *
 * @example
 * ```ts
 * import { buildTheirsTree } from "./theirs-tree.js";
 *
 * const theirs = buildTheirsTree({ tokens: { PROJECT_NAME: "acme" }, packNames: ["quality"] });
 * try {
 *   console.log(theirs.sources.get("package.json")); // "core"
 * } finally {
 *   theirs.cleanup();
 * }
 * ```
 */
export function buildTheirsTree(input: TheirsTreeInput): TheirsTree {
  const coreDir =
    input.coreDir ??
    resolveAsset({ repo: "templates/core", local: "templates/core" });
  const packsRoot = input.packsRoot ?? packsRootDir();
  const dir = mkdtempSync(join(tmpdir(), "m3l-theirs-"));
  const sources = new Map<string, FileSource>();
  const missingPacks: string[] = [];
  try {
    record(
      sources,
      emitTemplate(coreDir, dir, input.tokens).filesWritten,
      "core",
    );
    const shipped = new Set(listPackNames(packsRoot));
    for (const name of input.packNames) {
      if (!shipped.has(name)) {
        missingPacks.push(name);
        continue;
      }
      const result = installPack(loadPack(name, packsRoot), dir, input.tokens);
      record(sources, result.filesWritten, `pack:${name}`);
    }
    record(sources, installCustomizeSkill(dir).filesWritten, "skill");
  } catch (error) {
    try {
      removeTree(dir);
    } catch {
      // Best effort: the build failure is what the caller must see, so a
      // failing removal never replaces it.
    }
    throw error;
  }
  return {
    dir,
    sources,
    missingPacks,
    cleanup: () => {
      removeTree(dir);
    },
  };
}
