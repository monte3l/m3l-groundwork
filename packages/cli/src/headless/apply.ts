// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The transactional executor behind `--adopt --apply`
 * (`.claude/rules/headless-mode.md`, "Apply is a journal"):
 * {@link applyAdoptActions} carries out the actions `planAdoptActions`
 * returned. Only its dry run is wired (`--adopt --apply --dry-run`, via
 * `./apply-plan.ts`); a writing `--apply` is still to come.
 *
 * Order of a real run: take the apply lock; make sure
 * `.groundwork/headless/.gitignore` exists; roll back a journal an earlier
 * run left behind (only one this uid wrote and no one else can write);
 * verify every staged source and every target (nothing is
 * written until all of them pass); create `.groundwork/headless/txn/` with
 * an owner-only backup of every file to be replaced and the journal, all
 * fsynced (best effort) before the first project write; run each write
 * (each file's bytes fsynced as it is written); fsync the directories the
 * writes created or renamed into; then delete the journal (the commit
 * point), fsync `txn/`, write `.groundwork/headless/applied.json` and
 * remove `txn/` last. A failure before the commit
 * point rolls every landed step back in reverse; a rollback that cannot
 * restore a path keeps `txn/` for the next run to recover. Removing `txn/`
 * always deletes the journal first, so a half-removed `txn/` never holds a
 * journal that would be rolled back again.
 */
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STAGED_BASELINE_DIR,
  STAGED_DIVERGENT_DIR,
} from "../baseline-stage.js";
import { parseJsonc } from "../jsonc.js";
import { isProjectRelativePath, sha256Hex } from "../manifest.js";
import { isPrototypeSensitiveKey, isRecord } from "../merge-json.js";
import { errnoCode } from "../survey/internal/read-guard.js";
import type { AdoptPlanResult } from "./actions.js";
import { foldPath } from "./contract.js";
import { ApplyError } from "./errors.js";
import {
  NotRegularFileError,
  PERMISSION_BITS,
  createFile,
  fsyncPath,
  missingAncestors,
  parseJournal,
  readRegularNoFollow,
  replaceFile,
  serializeJournal,
  undoStep,
  untrustedReason,
  writePathProblem,
} from "./internal/apply-journal.js";
import type {
  InstallOwnership,
  JournalStep,
  RegularFile,
  UndoResult,
  WriteKind,
} from "./internal/apply-journal.js";
import { withApplyLock } from "./lock.js";

type AdoptAction = Extract<AdoptPlanResult, { ok: true }>["actions"][number];

const HEADLESS_DIR = ".groundwork/headless";
const APPLIED_SCHEMA = "groundwork.applied";
const APPLIED_SCHEMA_VERSION = 1;
/** Permission bits for the files this module writes under `.groundwork/headless/`. */
const RECORD_MODE = 0o644;
/**
 * Permission bits for a backup and the journal: owner-only, since a backup
 * may hold a private file's bytes and a recovery trusts only what this
 * process's uid wrote and no one else can write (`untrustedReason`).
 */
const OWNER_ONLY_MODE = 0o600;
/** What `.groundwork/headless/.gitignore` holds: the run's scratch, never to be committed. */
const HEADLESS_GITIGNORE = "txn/\nlock\n";
/** How a refusal that touched nothing ends; a recovery note rewrites it (see `withRecoveryNote`). */
const NOTHING_WRITTEN = " -- nothing was written";

/** One written file, as `applied.json` and the report record it. */
interface ApplyChange {
  readonly path: string;
  readonly action: WriteKind;
  readonly class: "addition" | "conflict";
  readonly sha256Before: string | null;
  readonly sha256After: string;
}

/** What {@link applyAdoptActions} resolves to. */
interface ApplyResult {
  readonly changes: readonly ApplyChange[];
  readonly warnings: readonly string[];
}

/** The write about to run, as {@link ApplyIo.beforeStep} sees it; `index` counts writes only. */
interface ApplyStepInfo {
  readonly index: number;
  readonly path: string;
  readonly kind: WriteKind;
}

/** The one seam into a run: called right before each project write, after verification and the journal. */
interface ApplyIo {
  readonly beforeStep?: (step: ApplyStepInfo) => void | Promise<void>;
}

/** {@link applyAdoptActions}' input. */
interface ApplyAdoptParams {
  readonly root: string;
  readonly actions: readonly AdoptAction[];
  readonly dryRun?: boolean;
  readonly io?: ApplyIo;
}

/** A verified write: the bytes to land, what the target holds now, and the directories it creates. */
interface PreparedStep {
  readonly index: number;
  readonly kind: WriteKind;
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256After: string;
  readonly before: {
    readonly bytes: Buffer;
    readonly sha256: string;
    readonly mode: number;
  } | null;
  readonly createDirs: readonly string[];
}

/**
 * How far an `install-staged` got with its file: `none` (never opened by
 * this run, so whatever is at the path is someone else's), `partial`
 * (opened with exclusive create, not fully written: this run's, whatever
 * it holds) or `complete` (every byte written: this run's only while it
 * still holds those bytes, since the user may edit it before a rollback).
 */
type InstallProgress = "none" | "partial" | "complete";

/** A step that has started writing, for the in-process rollback. */
interface Landed {
  readonly step: JournalStep;
  /** For an `install-staged`: directories actually created, and how far its file got. */
  readonly createdDirs: string[];
  file: InstallProgress;
  /** For a replacing step: whether the rename over the target happened. */
  replaced: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusal(path: string, reason: string, cause?: unknown): ApplyError {
  return new ApplyError(
    `refusing to apply ${path}: ${reason}${NOTHING_WRITTEN}`,
    cause === undefined ? {} : { cause },
  );
}

/** Why a no-follow read failed, in words. */
function readFailure(cause: unknown): string {
  if (cause instanceof NotRegularFileError) return "it is not a regular file";
  const code = errnoCode(cause);
  if (code === "ENOENT") return "it does not exist";
  if (code === "ELOOP") return "it is a symlink";
  return `it cannot be read (${messageOf(cause)})`;
}

/** The staging directory each write kind must read its staged copy from. */
const STAGING_DIR: Readonly<Record<WriteKind, string>> = {
  "install-staged": `.groundwork/${STAGED_BASELINE_DIR}`,
  "take-divergent": `.groundwork/${STAGED_DIVERGENT_DIR}`,
  "merge-keys": `.groundwork/${STAGED_DIVERGENT_DIR}`,
};

/**
 * The staged copy's bytes, once proven to be the file the survey staged: a
 * relative path inside its staging directory with no `.`/`..` segment, a
 * real directory at every component, a regular file at the end (read
 * without following a symlink), and the action's sha256 over the raw bytes.
 */
function verifiedStaged(
  root: string,
  path: string,
  kind: WriteKind,
  stagedPath: string,
  sha256: string,
): Buffer {
  const dir = STAGING_DIR[kind];
  const shown = `staged copy ${JSON.stringify(stagedPath)}`;
  if (!isProjectRelativePath(stagedPath) || !stagedPath.startsWith(`${dir}/`)) {
    throw refusal(path, `${shown} is not a relative path inside ${dir}/`);
  }
  if (missingAncestors(root, stagedPath).length > 0) {
    throw refusal(path, `${shown} does not exist`);
  }
  let bytes: Buffer;
  try {
    bytes = readRegularNoFollow(join(root, stagedPath)).bytes;
  } catch (cause) {
    throw refusal(path, `${shown} is unusable: ${readFailure(cause)}`, cause);
  }
  if (sha256Hex(bytes) !== sha256) {
    throw refusal(
      path,
      `${shown} does not match the sha256 the survey recorded`,
    );
  }
  return bytes;
}

/** The leading indentation `text`'s first key uses, or 2 for a one-line document. */
function indentOf(text: string): string | number {
  return /^\s*\{\r?\n([ \t]+)\S/.exec(text)?.[1] ?? 2;
}

/** `value` serialised in `text`'s indentation, line ending and trailing newline. */
function serializeLike(text: string, value: unknown): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(value, null, indentOf(text)).replaceAll(
    "\n",
    eol,
  );
  return /\r?\n$/.test(text) ? `${body}${eol}` : body;
}

/**
 * The target's JSON with each of `takeKeys` set from the staged copy, kept
 * in the target's indentation, line ending and trailing newline. Refuses a
 * target that starts with a UTF-8 byte order mark (the merged text could
 * not keep it byte for byte), one that is not strict JSON (a JSONC one
 * would lose its comments), a non-object on either side, a target whose
 * unmodified parse does not re-serialise to exactly its original text (an
 * inline array, a duplicate or escaped key, a non-canonical or out-of-range
 * number, a one-line document: a merge would rewrite what it was not asked
 * to touch), a prototype-sensitive key, and a key the staged copy does not
 * hold: a key is never silently skipped.
 */
function mergedJson(
  path: string,
  target: Buffer,
  staged: Buffer,
  takeKeys: readonly string[],
): Buffer {
  const text = target.toString("utf8");
  if (text.startsWith("﻿")) {
    throw refusal(
      path,
      "it starts with a UTF-8 byte order mark (BOM), which a merge cannot keep byte for byte (delegate it instead)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw refusal(
      path,
      parseJsonc(text).ok
        ? "it has comments or trailing commas a merge would drop (delegate it instead)"
        : "it is not valid JSON",
      cause,
    );
  }
  const source = parseJsonc(staged.toString("utf8"));
  if (!isRecord(parsed) || !source.ok || !isRecord(source.value)) {
    throw refusal(path, "the target or its staged copy is not a JSON object");
  }
  for (const key of takeKeys) {
    if (isPrototypeSensitiveKey(key)) {
      throw refusal(
        path,
        `refusing prototype-sensitive key ${JSON.stringify(key)}`,
      );
    }
    if (!Object.hasOwn(source.value, key)) {
      throw refusal(path, `the staged copy has no key ${JSON.stringify(key)}`);
    }
  }
  if (serializeLike(text, parsed) !== text) {
    throw refusal(
      path,
      "its formatting cannot be reproduced byte for byte, so a merge would rewrite more than the keys it takes (delegate it instead)",
    );
  }
  for (const key of takeKeys) {
    parsed[key] = source.value[key];
  }
  return Buffer.from(serializeLike(text, parsed), "utf8");
}

/** Verifies one write action against the staged copy and the tree, writing nothing. */
function prepareStep(
  root: string,
  action: Extract<AdoptAction, { stagedPath: string }>,
  index: number,
  plannedDirs: Set<string>,
): PreparedStep {
  const { path, kind } = action;
  const staged = verifiedStaged(
    root,
    path,
    kind,
    action.stagedPath,
    action.sha256,
  );
  const missing = missingAncestors(root, path);
  if (kind === "install-staged") {
    if (
      missing.length === 0 &&
      lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined
    ) {
      throw refusal(path, "it already exists, and an install never overwrites");
    }
    const createDirs = missing.filter((dir) => !plannedDirs.has(dir));
    for (const dir of createDirs) plannedDirs.add(dir);
    return {
      index,
      kind,
      path,
      bytes: staged,
      sha256After: sha256Hex(staged),
      before: null,
      createDirs,
    };
  }
  let current: { bytes: Buffer; mode: number };
  try {
    current = readRegularNoFollow(join(root, path));
  } catch (cause) {
    throw refusal(path, `the target is unusable: ${readFailure(cause)}`, cause);
  }
  const bytes =
    kind === "merge-keys"
      ? mergedJson(path, current.bytes, staged, action.takeKeys)
      : staged;
  return {
    index,
    kind,
    path,
    bytes,
    sha256After: sha256Hex(bytes),
    before: {
      bytes: current.bytes,
      sha256: sha256Hex(current.bytes),
      mode: current.mode & PERMISSION_BITS,
    },
    createDirs: [],
  };
}

/**
 * Verifies every write action before anything is written: staged copies,
 * targets, duplicate paths (compared after `foldPath`, as a
 * case-insensitive filesystem sees them), a path the answers validator's
 * segment rules refuse, a target under `.groundwork/` or inside a `.git`
 * directory (`writePathProblem`), and a write path that another write needs
 * as a directory. `keep`, `skip` and `delegate` are passed over.
 */
function prepareSteps(
  root: string,
  actions: readonly AdoptAction[],
): PreparedStep[] {
  const steps: PreparedStep[] = [];
  const plannedDirs = new Set<string>();
  const seen = new Set<string>();
  const folded = new Set<string>();
  for (const action of actions) {
    // keep, skip and delegate carry no staged copy and write nothing.
    if (!("stagedPath" in action)) continue;
    const key = foldPath(action.path);
    if (!isProjectRelativePath(action.path) || folded.has(key)) {
      throw refusal(
        action.path,
        "the path is not a relative project path, or is listed twice",
      );
    }
    const problem = writePathProblem(action.path);
    if (problem !== undefined) throw refusal(action.path, problem);
    seen.add(action.path);
    folded.add(key);
    try {
      steps.push(prepareStep(root, action, steps.length, plannedDirs));
    } catch (cause) {
      if (cause instanceof ApplyError) throw cause;
      throw refusal(action.path, messageOf(cause), cause);
    }
  }
  for (const path of seen) {
    if (plannedDirs.has(path)) {
      throw refusal(path, "another write in this plan needs it as a directory");
    }
  }
  return steps;
}

/** Sorts by path in code-point order, as the planner sorts actions (UTF-8 byte order is code-point order). */
function byPath(left: ApplyChange, right: ApplyChange): number {
  return Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  );
}

function changesOf(steps: readonly PreparedStep[]): ApplyChange[] {
  return steps
    .map((step): ApplyChange => ({
      path: step.path,
      action: step.kind,
      class: step.kind === "install-staged" ? "addition" : "conflict",
      sha256Before: step.before?.sha256 ?? null,
      sha256After: step.sha256After,
    }))
    .sort(byPath);
}

function journalStepOf(step: PreparedStep): JournalStep {
  return {
    kind: step.kind,
    path: step.path,
    sha256After: step.sha256After,
    before:
      step.before === null
        ? null
        : {
            sha256: step.before.sha256,
            mode: step.before.mode,
            backup: String(step.index),
          },
    createdDirs: step.createDirs,
  };
}

/** Removes `txn/`, deleting its journal first so a half-removed `txn/` is never rolled back again. */
function removeTxn(txnDir: string): void {
  rmSync(join(txnDir, "journal.json"), { force: true });
  rmSync(txnDir, { recursive: true, force: true });
}

/** `restored ...; already original: ...; kept ...`, omitting an empty part. */
function undoSummary(
  restored: readonly string[],
  unchanged: readonly string[],
  kept: readonly string[],
  keptBy: string,
): string {
  const parts: string[] = [];
  if (restored.length > 0) parts.push(`restored ${restored.join(", ")}`);
  if (unchanged.length > 0) {
    parts.push(`already original: ${unchanged.join(", ")}`);
  }
  if (kept.length > 0) {
    parts.push(
      `kept ${kept.join(", ")} (created by ${keptBy}, but no longer empty)`,
    );
  }
  return parts.join("; ");
}

/** The outcome of undoing a list of steps: leftovers (with reasons) in write order, and what was undone. */
interface UndoReport {
  readonly leftovers: string[];
  readonly reasons: string[];
  readonly restored: string[];
  readonly unchanged: string[];
  readonly kept: string[];
}

/** Undoes `entries` newest first, collecting the report in write order. */
function undoAll(
  entries: readonly {
    readonly path: string;
    readonly undo: () => UndoResult;
  }[],
): UndoReport {
  const report: UndoReport = {
    leftovers: [],
    reasons: [],
    restored: [],
    unchanged: [],
    kept: [],
  };
  for (const { path, undo } of [...entries].reverse()) {
    const result = undo();
    switch (result.status) {
      case "leftover":
        report.leftovers.unshift(path);
        report.reasons.unshift(result.reason);
        break;
      case "restored":
        report.restored.unshift(path);
        report.kept.unshift(...result.keptDirs);
        break;
      case "unchanged":
        report.unchanged.unshift(path);
        report.kept.unshift(...result.keptDirs);
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`unhandled undo result ${String(exhaustive)}`);
      }
    }
  }
  return report;
}

/** One `Error` per leftover reason, aggregated as the cause of a failed recovery. */
function reasonsCause(reasons: readonly string[]): AggregateError {
  return new AggregateError(
    reasons.map((reason) => new Error(reason)),
    `${String(reasons.length)} path(s) could not be restored`,
  );
}

/**
 * Rolls back the journal a previous run left in `txn/`, or removes a `txn/`
 * that holds no journal (a run that died before its first project write,
 * or one past its commit point that could not remove `txn/` or write
 * `applied.json`: its changes may have landed unrecorded, so the warning
 * says to check and record them by hand). Returns the warning to report and
 * the paths it restored, or `undefined` when there was nothing to recover.
 *
 * @throws {@link ApplyError} for a journal that is not exactly the shape
 *   this module writes (refused, touching nothing), for a rollback that
 *   leaves paths unrestored (`leftovers`, `leftoverReasons` and an
 *   `AggregateError` cause with one reason per leftover; the message also
 *   names what it did restore; `txn/` is kept), and for a successful
 *   rollback whose `txn/` cleanup then fails.
 */
function recoverLeftover(root: string): string | undefined {
  const txnDir = join(root, HEADLESS_DIR, "txn");
  const journalPath = join(txnDir, "journal.json");
  const txn = lstatSync(txnDir, { throwIfNoEntry: false });
  if (txn === undefined) return undefined;
  const advice = `inspect ${txnDir}, restore any file it backs up by hand, then remove it and re-run the CLI`;
  if (!txn.isDirectory()) {
    throw new ApplyError(
      `refusing a leftover apply journal directory that is not a directory: ${txnDir} -- ${advice}`,
    );
  }
  if (lstatSync(journalPath, { throwIfNoEntry: false }) === undefined) {
    rmSync(txnDir, { recursive: true, force: true });
    return `removed a leftover ${HEADLESS_DIR}/txn with no journal: the previous run either stopped before its first project write, or got past its commit point (its changes may have landed) and could not finish cleaning up, so they may have landed without being written to ${HEADLESS_DIR}/applied.json -- check that applied.json lists the paths of that run's changes (every successful run overwrites it, so an earlier run's record may be what is there); otherwise check the project for them and record any that landed by hand`;
  }
  let journal: RegularFile;
  try {
    // No-follow: a symlink or a non-file at journal.json is refused here.
    journal = readRegularNoFollow(journalPath);
  } catch (cause) {
    throw new ApplyError(
      `could not read the leftover apply journal ${journalPath} -- ${advice}`,
      { cause },
    );
  }
  const journalDistrust = untrustedReason(journal);
  if (journalDistrust !== undefined) {
    throw new ApplyError(
      `refusing a leftover apply journal this CLI cannot trust: ${journalPath} (${journalDistrust}); nothing was touched -- ${advice}`,
    );
  }
  const steps = parseJournal(journal.bytes.toString("utf8"));
  if (steps === undefined) {
    throw new ApplyError(
      `refusing a leftover apply journal that is not one this CLI wrote: ${journalPath} -- ${advice}`,
    );
  }
  const backupDir = join(txnDir, "backup");
  for (const step of steps) {
    if (step.before === null) continue;
    const backupPath = join(backupDir, step.before.backup);
    const backup = lstatSync(backupPath, { throwIfNoEntry: false });
    // A missing backup is not refused here: the undo reports it as a
    // leftover, or does not need it when the target already holds the original.
    if (backup === undefined) continue;
    // Path-based on purpose: undoReplace verifies the backup's hash against
    // the trusted journal when it reads it.
    const backupDistrust = backup.isFile()
      ? untrustedReason(backup)
      : "it is not a regular file (a symlink or another non-file)";
    if (backupDistrust !== undefined) {
      throw new ApplyError(
        `refusing the leftover apply journal ${journalPath}: its backup ${backupPath} cannot be trusted (${backupDistrust}); nothing was touched -- ${advice}`,
      );
    }
  }
  const report = undoAll(
    steps.map((step) => ({
      path: step.path,
      undo: () => undoStep(root, backupDir, step, "hash"),
    })),
  );
  const summary = undoSummary(
    report.restored,
    report.unchanged,
    report.kept,
    "that apply",
  );
  if (report.leftovers.length > 0) {
    const undone = summary === "" ? "" : ` (for the other steps it ${summary})`;
    throw new ApplyError(
      `could not roll back the leftover apply journal ${journalPath}: ${report.reasons.join("; ")}${undone} -- ${advice}`,
      {
        rolledBack: false,
        leftovers: report.leftovers,
        leftoverReasons: report.reasons,
        cause: reasonsCause(report.reasons),
      },
    );
  }
  const done = `rolled back an interrupted earlier apply from its leftover journal (${String(steps.length)} step(s) checked${summary === "" ? "" : `: ${summary}`})`;
  try {
    removeTxn(txnDir);
  } catch (cause) {
    throw new ApplyError(
      `${done}, but could not clean up ${txnDir} afterwards: ${messageOf(cause)} -- the recovery succeeded and only the cleanup failed; nothing of this run's plan was applied. Remove ${txnDir} by hand, then re-run the CLI`,
      { cause },
    );
  }
  return done;
}

/**
 * Creates `txn/` with an owner-only backup of every file to be replaced,
 * then the journal (its bytes synced by `replaceFile`), and fsyncs the
 * backups, `txn/backup/`, `txn/` and `.groundwork/headless/` so the journal
 * is durable before the first project write (directory syncs are best
 * effort, see `fsyncPath`).
 */
function openTransaction(root: string, steps: readonly PreparedStep[]): void {
  const txnDir = join(root, HEADLESS_DIR, "txn");
  const backupDir = join(txnDir, "backup");
  let created = false;
  try {
    mkdirSync(txnDir);
    created = true;
    mkdirSync(backupDir);
    for (const step of steps) {
      if (step.before !== null) {
        const backup = join(backupDir, String(step.index));
        writeFileSync(backup, step.before.bytes, {
          flag: "wx",
          mode: OWNER_ONLY_MODE,
        });
        fsyncPath(backup, "file");
      }
    }
    replaceFile(
      join(txnDir, "journal.json"),
      serializeJournal(steps.map(journalStepOf)),
      OWNER_ONLY_MODE,
    );
    fsyncPath(backupDir, "dir");
    fsyncPath(txnDir, "dir");
    fsyncPath(join(root, HEADLESS_DIR), "dir");
  } catch (cause) {
    if (created) {
      try {
        rmSync(txnDir, { recursive: true, force: true });
      } catch {
        // Best-effort: no project file was written yet, and a txn/ left
        // without a journal is removed, with a warning, by the next run.
      }
    }
    throw new ApplyError(
      `could not write the apply journal under ${txnDir}${NOTHING_WRITTEN}`,
      { cause },
    );
  }
}

/** Runs one verified write, recording in `landed` what it touched as soon as it touches it. */
function runStep(root: string, step: PreparedStep, landed: Landed[]): void {
  const abs = join(root, step.path);
  const record: Landed = {
    step: journalStepOf(step),
    createdDirs: [],
    file: "none",
    replaced: false,
  };
  if (step.before === null) {
    const missing = missingAncestors(root, step.path);
    if (missing.join("\n") !== step.createDirs.join("\n")) {
      throw new Error(
        `the directories above ${step.path} changed since verification`,
      );
    }
    landed.push(record);
    for (const dir of step.createDirs) {
      mkdirSync(join(root, dir));
      record.createdDirs.push(dir);
    }
    // Ownership starts only once the exclusive create returned a
    // descriptor: a failed open (EEXIST, EACCES, ENOSPC, ...) made nothing
    // this run may remove.
    createFile(abs, step.bytes, () => {
      record.file = "partial";
    });
    record.file = "complete";
    return;
  }
  // Called for its refusal only: it re-checks that no directory above the
  // target became a symlink or a file since verification. A replace creates
  // no directory, so the list of missing ones it returns is not needed.
  missingAncestors(root, step.path);
  const current = readRegularNoFollow(abs);
  if (sha256Hex(current.bytes) !== step.before.sha256) {
    throw new Error(`${step.path} changed since verification`);
  }
  landed.push(record);
  replaceFile(abs, step.bytes, current.mode);
  record.replaced = true;
}

/** Whether a landed step changed the project at all: a directory, its file, or a replace. */
function touched(record: Landed): boolean {
  return (
    record.createdDirs.length > 0 || record.file !== "none" || record.replaced
  );
}

/** How the undo of an install treats its file, from how far its write got (see {@link InstallProgress}). */
function ownershipOf(progress: InstallProgress): InstallOwnership {
  switch (progress) {
    case "none":
      return "dirs-only";
    case "partial":
      return "created";
    case "complete":
      return "hash";
    default: {
      const exhaustive: never = progress;
      throw new Error(`unhandled install progress ${String(exhaustive)}`);
    }
  }
}

/** Reverts every landed step, newest first; see {@link UndoReport}. */
function rollBack(root: string, landed: readonly Landed[]): UndoReport {
  const backupDir = join(root, HEADLESS_DIR, "txn", "backup");
  return undoAll(
    landed.map(({ step, createdDirs, file, replaced }) => ({
      path: step.path,
      undo: (): UndoResult => {
        if (step.before === null) {
          return undoStep(
            root,
            backupDir,
            { ...step, createdDirs },
            ownershipOf(file),
          );
        }
        // A replace whose rename never happened changed nothing: whatever is
        // at the target now (an edit, a deletion) is someone else's.
        return replaced
          ? undoStep(root, backupDir, step, "hash")
          : { status: "unchanged", keptDirs: [] };
      },
    })),
  );
}

/**
 * Makes every write durable before the commit point. Each file's bytes
 * were already fsynced as they were written (an install through its own
 * descriptor, a replace through its temp file before the rename), so what
 * is left are the directory entries: the directory each file was created
 * or renamed into, every directory the run created, and the parent each
 * created directory was made in (best effort, see `fsyncPath`).
 */
function syncWrites(root: string, steps: readonly PreparedStep[]): void {
  const dirs = new Set<string>();
  for (const step of steps) {
    dirs.add(join(root, dirname(step.path)));
    for (const dir of step.createDirs) {
      dirs.add(join(root, dir));
      dirs.add(join(root, dirname(dir)));
    }
  }
  for (const dir of dirs) fsyncPath(dir, "dir");
}

/** The `applied.json` document for `changes`. */
function appliedRecord(changes: readonly ApplyChange[]): string {
  return `${JSON.stringify({ schema: APPLIED_SCHEMA, schemaVersion: APPLIED_SCHEMA_VERSION, changes }, null, 2)}\n`;
}

/** Writes every prepared step under the journal; see the module comment for the order. */
async function runTransaction(
  root: string,
  steps: readonly PreparedStep[],
  io: ApplyIo,
): Promise<ApplyResult> {
  const txnDir = join(root, HEADLESS_DIR, "txn");
  openTransaction(root, steps);
  const landed: Landed[] = [];
  let completed = 0;
  try {
    for (const step of steps) {
      await io.beforeStep?.({
        index: step.index,
        path: step.path,
        kind: step.kind,
      });
      runStep(root, step, landed);
      completed += 1;
    }
    syncWrites(root, steps);
    // The commit point: with the journal gone, nothing is rolled back.
    rmSync(join(txnDir, "journal.json"));
  } catch (cause) {
    const undo = rollBack(root, landed);
    const written = landed.filter(touched).map((record) => record.step.path);
    const failed = steps[completed]?.path ?? "the commit";
    if (undo.leftovers.length > 0) {
      throw new ApplyError(
        `could not apply ${failed}: ${messageOf(cause)}; the rollback could not restore ${undo.reasons.join("; ")} -- inspect ${txnDir}, restore them from its backups by hand, then remove it and re-run the CLI`,
        {
          written,
          rolledBack: false,
          leftovers: undo.leftovers,
          leftoverReasons: undo.reasons,
          cause,
        },
      );
    }
    const notes: string[] = [];
    if (undo.kept.length > 0) {
      notes.push(
        `kept ${undo.kept.join(", ")} (created by this run, but no longer empty)`,
      );
    }
    try {
      removeTxn(txnDir);
    } catch (cleanup) {
      notes.push(
        `${txnDir} could not be removed (${messageOf(cleanup)}); the next run removes it with a warning`,
      );
    }
    throw new ApplyError(
      `could not apply ${failed}: ${messageOf(cause)}; every earlier write was rolled back${notes.map((note) => `; ${note}`).join("")}`,
      { written, rolledBack: true, cause },
    );
  }
  // The journal's removal made durable, so a crash now cannot resurrect it
  // and roll back committed writes (best effort, like every directory sync).
  fsyncPath(txnDir, "dir");
  const written = steps.map((step) => step.path);
  const changes = changesOf(steps);
  try {
    replaceFile(
      join(root, HEADLESS_DIR, "applied.json"),
      appliedRecord(changes),
      RECORD_MODE,
    );
  } catch (cause) {
    try {
      rmSync(txnDir, { recursive: true, force: true });
    } catch {
      // Best-effort: the journal is already gone, so a txn/ left here is
      // removed by the next run with a warning that these changes may have
      // landed unrecorded -- which the error below already says.
    }
    throw new ApplyError(
      `every write landed (${written.join(", ")}), but ${HEADLESS_DIR}/applied.json could not be written: ${messageOf(cause)} -- the project is changed and stays changed; record these changes by hand (in the commit or the report), since no later run records them for you`,
      { written, rolledBack: false, leftovers: [], cause },
    );
  }
  const warnings: string[] = [];
  try {
    rmSync(txnDir, { recursive: true, force: true });
  } catch (cause) {
    warnings.push(
      `every write landed and ${HEADLESS_DIR}/applied.json records them, but ${HEADLESS_DIR}/txn could not be removed (${messageOf(cause)}); its journal is already gone, so the next run removes it with a warning`,
    );
  }
  return { changes, warnings };
}

/**
 * `error` re-reported for a run whose recovery acted before the plan failed
 * (`recovery` is its warning: restored or already-original paths, or a
 * journal-less `txn/` removed): `.groundwork/headless/` or the project did
 * change, so a refusal's "nothing was written" no longer holds and what the
 * recovery did is named. The original error is chained as the `cause`.
 */
function withRecoveryNote(error: ApplyError, recovery: string): ApplyError {
  const message = error.message.endsWith(NOTHING_WRITTEN)
    ? `${error.message.slice(0, -NOTHING_WRITTEN.length)} -- nothing of this run's plan was written`
    : error.message;
  return new ApplyError(`${message} (before the plan, this run ${recovery})`, {
    written: error.written,
    rolledBack: error.rolledBack,
    leftovers: error.leftovers,
    leftoverReasons: error.leftoverReasons,
    cause: error,
  });
}

/**
 * Makes sure `.groundwork/headless/.gitignore` keeps the run's scratch
 * (`txn/`, `lock`) out of git -- a committed `txn/` could be recovered by a
 * later clone's run. Created with exclusive create, so an existing file is
 * never overwritten: one identical to what this writes is left alone
 * silently, anything else (a different file, a non-file, a failed create)
 * is left alone and returned as a warning. Called under the lock, before
 * anything else, so it lands even when the run then fails.
 */
function ensureHeadlessGitignore(root: string): string | undefined {
  const shown = `${HEADLESS_DIR}/.gitignore`;
  const path = join(root, HEADLESS_DIR, ".gitignore");
  try {
    writeFileSync(path, HEADLESS_GITIGNORE, { flag: "wx", mode: RECORD_MODE });
    return undefined;
  } catch (cause) {
    if (errnoCode(cause) !== "EEXIST") {
      return `could not create ${shown} (${messageOf(cause)}); make sure git ignores ${HEADLESS_DIR}/txn/ and ${HEADLESS_DIR}/lock, which must never be committed`;
    }
  }
  let same = false;
  try {
    same =
      readRegularNoFollow(path).bytes.toString("utf8") === HEADLESS_GITIGNORE;
  } catch {
    // A non-file or unreadable .gitignore is not ours to touch; it is
    // reported through the warning below, like a different one.
  }
  return same
    ? undefined
    : `left ${shown} as it is (it is not the one this CLI writes): make sure it ignores txn/ and lock, which must never be committed`;
}

/**
 * A dry run's warning when `.groundwork/headless/txn/` exists (with a
 * journal or without): an earlier apply is unfinished, so the project may be
 * half-applied and a real run would recover it before its plan. The dry run
 * itself neither recovers nor reads it.
 */
function pendingTxnWarnings(root: string): string[] {
  const txnDir = join(root, HEADLESS_DIR, "txn");
  let pending: boolean;
  try {
    pending = lstatSync(txnDir, { throwIfNoEntry: false }) !== undefined;
  } catch (cause) {
    throw new ApplyError(
      `could not check for a leftover apply journal under ${txnDir}: ${messageOf(cause)}${NOTHING_WRITTEN}`,
      { cause },
    );
  }
  return pending
    ? [
        `an unfinished earlier apply left ${HEADLESS_DIR}/txn behind, so the project may be half-applied: this dry run planned against the tree as it is, but a real apply first recovers that leftover (rolling it back, or refusing it), which can change the plan`,
      ]
    : [];
}

/**
 * Carries out `actions` (the `--adopt --apply` planner's output) against
 * the project at `root`, transactionally: every staged source and target is
 * verified before the first write, writes are journaled under
 * `.groundwork/headless/txn/` and rolled back in reverse on failure, and
 * `.groundwork/headless/applied.json` (`schema` `groundwork.applied`,
 * `schemaVersion` 1, `changes`) is written last -- only when something was
 * written. The whole run holds the apply lock (`withApplyLock`).
 *
 * - Holding the lock, it first makes sure `.groundwork/headless/.gitignore`
 *   ignores `txn/` and `lock` (exclusive create; an existing file is never
 *   overwritten, and one that differs is a warning); it is not a `change`.
 * - `install-staged` creates the file with exclusive create (`wx`), making
 *   missing parent directories only after verification; `take-divergent`
 *   replaces a regular file through a same-directory temp file and a
 *   rename, keeping its mode; `merge-keys` sets only `takeKeys`, from the
 *   staged copy, in the parsed target (a target with a UTF-8 BOM is
 *   refused). `keep`, `skip` and `delegate` write nothing.
 * - Every written file and every directory entry the run made is fsynced
 *   before the journal is removed (the commit point), and `txn/` after.
 * - `changes` lists one entry per written file, sorted by path.
 * - A rollback removes an installed file only while it holds the staged
 *   bytes (a partially written one whatever it holds; one whose open
 *   failed never); a file edited since, or a replaced target deleted since,
 *   is a leftover, kept as it is and never recreated. A replace whose
 *   rename never happened changed nothing and is left as it is.
 * - A journal a previous run left behind is rolled back first, with one
 *   warning listing the restored and already-original paths; one that is
 *   not exactly what this module writes, or that (or one of its backups) is
 *   not a regular file owned by this uid and free of group/world write
 *   bits (POSIX only), is refused. If the plan then fails, its error says
 *   what the recovery did.
 * - A target the answers validator's segment rules refuse, under
 *   `.groundwork/` or inside a `.git` directory is refused.
 * - After the commit point `applied.json` is written before `txn/` is
 *   removed; a `txn/` that cannot be removed then is a warning.
 * - `dryRun` verifies and computes the same `changes` but takes no lock,
 *   recovers nothing and creates nothing; a pending `txn/` is a warning
 *   that the project may be half-applied.
 * - `io.beforeStep` runs right before each project write.
 *
 * @throws {@link ApplyError} for every refusal and failure: `written` lists
 *   what this run touched, `rolledBack`, `leftovers` and `leftoverReasons`
 *   report the rollback, and the original failure is the `cause`. An
 *   `applied.json` write failure after the commit point has `rolledBack`
 *   `false` and no leftovers: the changes landed.
 *
 * @example
 * ```ts
 * import { applyAdoptActions } from "./headless/apply.js";
 * import { ApplyError } from "./headless/errors.js";
 *
 * try {
 *   const { changes, warnings } = await applyAdoptActions({
 *     root: "/work/app",
 *     actions: [{ kind: "keep", path: "tsconfig.json" }],
 *   });
 *   console.log(changes.length, warnings);
 * } catch (error) {
 *   if (error instanceof ApplyError && !error.rolledBack) {
 *     console.error(`restore by hand: ${error.leftovers.join(", ")}`);
 *   }
 * }
 * ```
 */
export async function applyAdoptActions(
  params: ApplyAdoptParams,
): Promise<ApplyResult> {
  const { root, actions, dryRun = false, io = {} } = params;
  if (dryRun) {
    const changes = changesOf(prepareSteps(root, actions));
    return { changes, warnings: pendingTxnWarnings(root) };
  }
  return withApplyLock(root, async (): Promise<ApplyResult> => {
    const gitignore = ensureHeadlessGitignore(root);
    let recovery: string | undefined;
    try {
      recovery = recoverLeftover(root);
    } catch (cause) {
      if (cause instanceof ApplyError) throw cause;
      // An lstat/rm failure on txn/ itself; no project file was touched.
      throw new ApplyError(
        `could not check for a leftover apply journal under ${join(root, HEADLESS_DIR, "txn")}: ${messageOf(cause)}`,
        { cause },
      );
    }
    const warnings = [gitignore, recovery].filter(
      (warning): warning is string => warning !== undefined,
    );
    try {
      const steps = prepareSteps(root, actions);
      if (steps.length === 0) return { changes: [], warnings };
      const result = await runTransaction(root, steps, io);
      return {
        changes: result.changes,
        warnings: [...warnings, ...result.warnings],
      };
    } catch (error) {
      if (error instanceof ApplyError && recovery !== undefined) {
        throw withRecoveryNote(error, recovery);
      }
      throw error;
    }
  });
}
