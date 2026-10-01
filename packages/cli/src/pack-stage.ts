// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Adopt mode's staging of every pack under `templates/packs/`: each pack's
 * manifest and `files/` tree are copied into `.groundwork/packs/<name>/`,
 * every file under an inert `<path>.staged` name, so `/customize`'s Step 0
 * can install a pack from a self-contained copy -- after confirmation --
 * without any toolchain globbing the project ever picking a staged file up.
 * All packs are written together to a temporary sibling directory and
 * swapped in by rename, so `packs/` is never half-written -- the same
 * lifecycle `baseline-stage.ts` uses (both build on `staging.ts`).
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathContained } from "./emit.js";
import type { Pack } from "./packs.js";
import {
  STAGED_SUFFIX,
  clearStaging,
  collectTemplateFiles,
  findStagedPathCollision,
  prepareStaging,
  stageAtomically,
  stagedNameFor,
  toPosixPath,
  writeStagedBytes,
} from "./staging.js";
import type { StagingTarget } from "./staging.js";
import type { TokenTable } from "./tokens.js";

/** The staging directory's name under `.groundwork/`. */
const PACKS_DIR_NAME = "packs";

/** Each staged pack's subdirectory holding its `files/` tree. */
const PACK_FILES_DIR = "files";

/**
 * The project-relative directory every pack is staged under; a pack's own
 * staging directory is `${STAGED_PACKS_DIR}/<name>`.
 *
 * @example
 * ```ts
 * const dir = `${STAGED_PACKS_DIR}/quality`; // ".groundwork/packs/quality"
 * ```
 */
export const STAGED_PACKS_DIR: string = `.groundwork/${PACKS_DIR_NAME}`;

/**
 * The install name of a pack's manifest; it is staged as
 * `pack.json` + `.staged` beside the pack's `files/` directory.
 *
 * @example
 * ```ts
 * const staged = `${STAGED_PACK_MANIFEST}.staged`; // "pack.json.staged"
 * ```
 */
export const STAGED_PACK_MANIFEST = "pack.json";

/**
 * One staged pack file: its install path, its staged name, and the sha256 of
 * the staged bytes, so `/customize` can verify the copy it installs.
 *
 * @example
 * ```ts
 * const file: StagedPackFile = {
 *   path: ".claude/hooks/guard-readonly-bash.mjs",
 *   staged: ".claude/hooks/guard-readonly-bash.mjs.staged",
 *   sha256: "e3b0c442...", // hex digest of the staged bytes
 * };
 * ```
 */
export interface StagedPackFile {
  /** The project-relative path the file installs to (for the manifest: `pack.json`). */
  path: string;
  /** The staged file's name: `path` + `.staged`, relative to the pack's `files/` directory (for the manifest: to the pack's own directory). */
  staged: string;
  /** Lowercase hex sha256 of the staged bytes. */
  sha256: string;
}

/**
 * One staged pack, as recorded in `inventory.json`'s `stagedPacks`.
 *
 * @example
 * ```ts
 * const pack: StagedPack = {
 *   name: "quality",
 *   dir: ".groundwork/packs/quality",
 *   suffix: ".staged",
 *   manifest: { path: "pack.json", staged: "pack.json.staged", sha256: "…" },
 *   files: [{ path: "bin/check-file-budget.mjs", staged: "bin/check-file-budget.mjs.staged", sha256: "…" }],
 * };
 * ```
 */
export interface StagedPack {
  /** The pack's manifest name, also its directory name under {@link STAGED_PACKS_DIR}. */
  name: string;
  /** The pack's project-relative staging directory, `/`-separated: `.groundwork/packs/<name>`. */
  dir: string;
  /** The suffix every staged name carries: `.staged`. */
  suffix: string;
  /** The staged `pack.json`, at `<dir>/pack.json.staged`. */
  manifest: StagedPackFile;
  /** The pack's `files/` tree, each at `<dir>/files/<staged>`, sorted by `path`. */
  files: StagedPackFile[];
}

/** One pack's validated plan: everything later steps need, read once from the caller's `Pack`. */
interface PlannedPack {
  readonly name: string;
  readonly manifestBytes: Buffer;
  readonly files: readonly { path: string; sourcePath: string }[];
}

function assertSingleSegmentName(name: string): void {
  if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error(
      `stagePacks: pack name ${JSON.stringify(name)} is not a single directory name`,
    );
  }
  if (name.includes(":")) {
    throw new Error(
      `stagePacks: pack name ${JSON.stringify(name)} contains ":", which Windows reads as a drive letter or an alternate data stream`,
    );
  }
}

/**
 * Whether `filesDir` is a directory. A missing path answers `false`; any
 * other `statSync` failure (a permission error, say) becomes a plan-time
 * `Error` naming the pack and the path, with the failure as `cause` -- seen
 * before anything is written, it is a template defect or a permission
 * problem to fix, not an "incomplete, re-run" staging failure.
 */
function isFilesDir(name: string, filesDir: string): boolean {
  try {
    return (
      statSync(filesDir, { throwIfNoEntry: false })?.isDirectory() === true
    );
  } catch (cause) {
    throw new Error(
      `stagePacks: could not inspect pack "${name}"'s files directory ${filesDir}`,
      { cause },
    );
  }
}

function serializeManifest(name: string, manifest: Pack["manifest"]): Buffer {
  // JSON.stringify is typed string but yields undefined for some inputs
  // (a toJSON returning undefined); never write or hash that as text.
  const text: unknown = JSON.stringify(manifest, null, 2);
  if (typeof text !== "string") {
    throw new Error(`stagePacks: pack "${name}"'s manifest is not JSON`);
  }
  return Buffer.from(`${text}\n`);
}

/**
 * Validates and projects every pack before anything is touched. These
 * defects are refused, each with its own `Error` (no `cause`): a pack name
 * that is not a single directory name, contains `:`, or is shared by two
 * packs (also when the two differ only by letter case or Unicode
 * normalization); a missing
 * `filesDir`; two files in one pack installing to the same path; an install
 * path containing `:` (a drive letter or alternate data stream on Windows);
 * a tokenized install path whose staged name would land outside the pack's
 * `files/` staging directory (CWE-22, docs/assurance-case.md); and two
 * staged names in one pack that would land on the same file
 * ({@link findStagedPathCollision}). A `filesDir` that cannot be inspected
 * at all is refused with its failure as `cause` (see `isFilesDir`).
 */
function planPacks(
  packs: readonly Pack[],
  packsDir: string,
  tokens: TokenTable,
): PlannedPack[] {
  const seen = new Set<string>();
  const plan = packs.map(({ manifest, filesDir }): PlannedPack => {
    const name = manifest.name;
    assertSingleSegmentName(name);
    if (seen.has(name)) {
      throw new Error(
        `stagePacks: two packs are named "${name}"; pack names must be unique`,
      );
    }
    seen.add(name);
    if (!isFilesDir(name, filesDir)) {
      throw new Error(
        `stagePacks: pack "${name}"'s files directory ${filesDir} does not exist`,
      );
    }
    const stagedFilesDir = join(packsDir, name, PACK_FILES_DIR);
    const files = [...collectTemplateFiles(filesDir, tokens)]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, sourcePath]) => {
        if (path.includes(":")) {
          throw new Error(
            `stagePacks: pack "${name}"'s file ${toPosixPath(path)} contains ":", which Windows reads as a drive letter or an alternate data stream`,
          );
        }
        const destPath = join(stagedFilesDir, stagedNameFor(path));
        if (!isPathContained(destPath, stagedFilesDir)) {
          throw new Error(
            `stagePacks: staged path ${resolve(destPath)} for pack "${name}"'s ${path} escapes ${resolve(stagedFilesDir)}`,
          );
        }
        return { path, sourcePath };
      });
    const collision = findStagedPathCollision(
      files.map(({ path }) => toPosixPath(stagedNameFor(path))),
    );
    if (collision !== undefined) {
      throw new Error(
        `stagePacks: two of pack "${name}"'s staged files collide: ${collision}; rename one of them under ${filesDir}`,
      );
    }
    return { name, manifestBytes: serializeManifest(name, manifest), files };
  });
  const nameCollision = findStagedPathCollision(plan.map(({ name }) => name));
  if (nameCollision !== undefined) {
    throw new Error(
      `stagePacks: two packs' staging directories collide: ${nameCollision}; pack names must be unique ignoring case and Unicode normalization`,
    );
  }
  return plan;
}

/**
 * The validated plan for one {@link stagePacks} run: every path it would
 * write, plus everything it needs to write them -- each pack's serialized
 * manifest and its files' install paths and sources -- so staging never
 * re-walks a pack's `files/` tree. Built by {@link planPackStaging}.
 *
 * @example
 * ```ts
 * import { planPackStaging, stagePacks } from "./pack-stage.js";
 * const plan = planPackStaging(packs, groundworkDir, tokens);
 * stagePacks(packs, groundworkDir, tokens, plan);
 * ```
 */
export interface PackStagingPlan {
  /** Every path the run writes, under `<groundworkDir>/packs/`: per pack, its `pack.json.staged`, then each `files/<path>.staged`. */
  readonly paths: readonly string[];
  /** Each pack's validated projection, in `packs` order. */
  readonly packs: readonly PlannedPack[];
}

/**
 * Validates `packs` and computes the plan {@link stagePacks} writes from:
 * every path under `<groundworkDir>/packs/` -- each pack's
 * `pack.json.staged` and every `files/<path>.staged` -- and each file's
 * source, so adopt mode can scope-check `paths` before any pack is written
 * and then hand the same plan to {@link stagePacks}. Reads the packs'
 * source trees; writes nothing.
 *
 * @throws The same plan `Error`s as {@link stagePacks}.
 *
 * @example
 * ```ts
 * import { assertAdoptWriteScope } from "./main.js";
 * const plan = planPackStaging(packs, groundworkDir, tokens);
 * assertAdoptWriteScope(targetDir, plan.paths);
 * stagePacks(packs, groundworkDir, tokens, plan);
 * ```
 */
export function planPackStaging(
  packs: readonly Pack[],
  groundworkDir: string,
  tokens: TokenTable,
): PackStagingPlan {
  const packsDir = join(groundworkDir, PACKS_DIR_NAME);
  const planned = planPacks(packs, packsDir, tokens);
  const paths = planned.flatMap(({ name, files }) => [
    join(packsDir, name, stagedNameFor(STAGED_PACK_MANIFEST)),
    ...files.map(({ path }) =>
      join(packsDir, name, PACK_FILES_DIR, stagedNameFor(path)),
    ),
  ]);
  return { paths, packs: planned };
}

/**
 * Every path {@link stagePacks} would write for `packs` -- a thin wrapper
 * returning {@link planPackStaging}'s `paths`. Reads the packs' source
 * trees; writes nothing.
 *
 * @throws The same plan `Error`s as {@link stagePacks}.
 *
 * @example
 * ```ts
 * import { assertAdoptWriteScope } from "./main.js";
 * assertAdoptWriteScope(targetDir, plannedPackStagingPaths(packs, groundworkDir, tokens));
 * ```
 */
export function plannedPackStagingPaths(
  packs: readonly Pack[],
  groundworkDir: string,
  tokens: TokenTable,
): string[] {
  return [...planPackStaging(packs, groundworkDir, tokens).paths];
}

function writePack(plan: PlannedPack, newDir: string): StagedPack {
  const manifestStaged = stagedNameFor(STAGED_PACK_MANIFEST);
  // Relative to newDir, so the containment assertion also covers the name.
  const manifestSha256 = writeStagedBytes(
    "stagePacks",
    plan.manifestBytes,
    newDir,
    join(plan.name, manifestStaged),
  );
  const filesDir = join(newDir, plan.name, PACK_FILES_DIR);
  const files = plan.files.map(({ path, sourcePath }): StagedPackFile => {
    const stagedName = stagedNameFor(path);
    const sha256 = writeStagedBytes(
      "stagePacks",
      readFileSync(sourcePath),
      filesDir,
      stagedName,
    );
    return {
      path: toPosixPath(path),
      staged: toPosixPath(stagedName),
      sha256,
    };
  });
  return {
    name: plan.name,
    dir: `${STAGED_PACKS_DIR}/${plan.name}`,
    suffix: STAGED_SUFFIX,
    manifest: {
      path: STAGED_PACK_MANIFEST,
      staged: manifestStaged,
      sha256: manifestSha256,
    },
    files,
  };
}

/**
 * Stages every pack in `packs` into `<groundworkDir>/packs/`: for each, its
 * manifest as `<name>/pack.json.staged` (`JSON.stringify(manifest, null, 2)`
 * plus a newline) and every file of its `filesDir` tree as
 * `<name>/files/<path>.staged`, copied byte-for-byte -- no token
 * substitution into content, which is `/customize`'s job at install time.
 * `tokens` only substitutes into install paths (and dotfile names are
 * restored), the same derivation `planConflicts` uses. Recorded `path`/
 * `staged` values use forward slashes; `dir` is the literal
 * `.groundwork/packs/<name>`, whatever `groundworkDir` was passed.
 *
 * What is guaranteed:
 * - The plan is validated first, before anything is deleted or written (or,
 *   when `plan` is passed, was already validated by {@link planPackStaging}
 *   and the packs' trees are not walked again): a pack name that is not a
 *   single directory name, contains `:`, or is used by two packs (ignoring
 *   case and Unicode normalization), a missing `filesDir`, two files in one
 *   pack installing to the same path, an install path containing `:`, a
 *   staged name that would escape its pack's staging directory, or two
 *   staged names in one pack landing on the same file (equal once
 *   NFC-normalized and case-folded, or one a directory prefix of the other)
 *   throws its own
 *   `Error`, leaving `.groundwork/` exactly as it was. A `filesDir` that
 *   cannot be inspected (a permission error) throws a plan `Error` naming
 *   the pack and path, with the failure as `cause`.
 * - Then, still before anything is deleted or written, `groundworkDir` and
 *   `<groundworkDir>/packs` are checked not to be symlinks, and every
 *   `.packs-*` entry of the CLI-owned `groundworkDir` -- work directories a
 *   crashed earlier run left -- is removed (best effort; a failure to remove
 *   one only warns, a failure to list `groundworkDir` throws). `.baseline-*`
 *   entries are left alone.
 * - When `packs` is empty, any previous `packs/` is removed and nothing is
 *   created.
 * - Otherwise every pack is written into one temporary `.packs-*` sibling
 *   directory (each file created exclusively, `wx`) and swapped in by rename
 *   only after every copy succeeded, so `packs/` is never half-written and a
 *   failure leaves any previous `packs/` intact; a previous `packs/` is
 *   replaced wholesale (a pack no longer passed, or a file a pack dropped,
 *   does not linger).
 * - With a previous `packs/`, the swap is two renames: the previous one is
 *   parked inside the temporary directory, then the new one moved into
 *   place. A process killed between the two leaves `packs/` absent and the
 *   previous copy at `.packs-XXXXXX/previous`; the next run's sweep removes
 *   it and regenerates the staging.
 * - If the final swap rename fails, the previous `packs/` is renamed back.
 *   Only if that restore also fails is `packs/` left absent: the previous
 *   staging then survives, parked inside the temporary directory, which is
 *   deliberately not removed (a later run's stale-dir sweep does).
 * - The temporary directory is otherwise always removed; a failure to remove
 *   it only warns, naming its path.
 *
 * @throws `Error` (no re-run advice; no `cause` except for an uninspectable
 * `filesDir`) for an invalid plan, as above; `Error` before any delete or
 * write when `groundworkDir` or
 * `<groundworkDir>/packs` is a symlink; `AggregateError` of the swap and
 * restore failures, naming where the previous `packs/` is parked, when both
 * renames fail; the `AssertionError` itself, unwrapped, if the staged-path
 * containment invariant ever fails while writing; otherwise an `Error` with
 * `cause`, including the cause's message, saying `.groundwork/` is
 * incomplete and the CLI should be re-run.
 *
 * @param plan - The plan {@link planPackStaging} computed for these same
 * `packs`, `groundworkDir` and `tokens`; computed here when omitted.
 *
 * @example
 * ```ts
 * import { listPackNames, loadPack } from "./packs.js";
 * const packs = listPackNames().map((name) => loadPack(name));
 * const staged = stagePacks(packs, "/work/app/.groundwork", { PROJECT_NAME: "app" });
 * // staged[0]: { name: "github", dir: ".groundwork/packs/github", suffix: ".staged", … }
 * ```
 */
export function stagePacks(
  packs: readonly Pack[],
  groundworkDir: string,
  tokens: TokenTable,
  plan: PackStagingPlan = planPackStaging(packs, groundworkDir, tokens),
): StagedPack[] {
  const target: StagingTarget = {
    groundworkDir,
    dirName: PACKS_DIR_NAME,
    noun: "packs",
    plural: true,
  };
  prepareStaging(target);
  if (plan.packs.length === 0) {
    clearStaging(target);
    return [];
  }
  return stageAtomically(target, (newDir) =>
    plan.packs.map((planned) => writePack(planned, newDir)),
  );
}
