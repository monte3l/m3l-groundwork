// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The read-only pipeline behind `--adopt --apply <answers.json> --dry-run`
 * (`.claude/rules/headless-mode.md`): {@link runApplyDryRun} reads a
 * completed pending document, checks it against the survey it was made for
 * and asks the planner and the executor (in dry-run mode) what a real apply
 * would change. It writes nothing -- no lock, no journal, no pending
 * document -- whatever the outcome.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Inventory } from "../inventory.js";
import { INVENTORY_SCHEMA_VERSION } from "../inventory.js";
import { sha256Hex } from "../manifest.js";
import { errnoCode } from "../survey/internal/read-guard.js";
import { CliUsageError } from "../usage-error.js";
import { planAdoptActions } from "./actions.js";
import type { AdoptPlanResult, TargetState } from "./actions.js";
import { applyAdoptActions } from "./apply.js";
import {
  ADDITION_ACTIONS,
  CONFLICT_RESOLUTIONS,
  PROJECT_KINDS,
  RUNTIME_TARGETS,
  validateAnswers,
} from "./contract.js";
import type { AnswersV1, PendingEntry } from "./contract.js";
import {
  NotRegularFileError,
  readRegularNoFollow,
} from "./internal/apply-journal.js";

/**
 * The largest answers file or inventory `--apply` reads; a document at every
 * validator cap, or the survey of any real project, is far smaller.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** The adopt-mode directory holding the survey, relative to the target. */
const GROUNDWORK_DIR = ".groundwork";

/** The survey `--apply` checks the answers against, relative to the target. */
const INVENTORY_RELATIVE_PATH = `${GROUNDWORK_DIR}/inventory.json`;

/**
 * The oldest inventory `--apply` accepts: schema 7 is the first to record
 * each divergent file's `targetSha256` and its `stagedDivergent` copy, which
 * binding a write and a `take` need.
 */
const MIN_INVENTORY_SCHEMA_VERSION = 7;

/**
 * How the inventory is opened: `O_NOFOLLOW` refuses a symlinked
 * `inventory.json` (`ELOOP`) and `O_NONBLOCK` keeps a FIFO planted there from
 * hanging the open. Windows defines neither; OR-ing `undefined` adds 0.
 */
const INVENTORY_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The advice every unusable-survey error ends with. */
const RUN_ADOPT_FIRST =
  "run the CLI with --adopt --json first to survey the project, then complete the pending document it writes";

/** A planned write the executor would carry out, as its dry run reports it. */
type ApplyChange = Awaited<
  ReturnType<typeof applyAdoptActions>
>["changes"][number];

/** Work handed to the skill's headless branch: a delegated conflict, or the owner's missed notes. */
type ApplyHandoff = Extract<AdoptPlanResult, { ok: true }>["handoff"][number];

/** A target whose state no longer matches what the answers were made against. */
type ApplyDrift = Extract<AdoptPlanResult, { kind: "drift" }>["drift"][number];

/** The fields every {@link ApplyDryRunOutcome} carries, whatever its status. */
interface OutcomeFields {
  readonly target: string;
  readonly changes: readonly ApplyChange[];
  readonly handoff: readonly ApplyHandoff[];
  readonly pending: readonly PendingEntry[];
  readonly drift: readonly ApplyDrift[];
  readonly warnings: readonly string[];
}

/**
 * What {@link runApplyDryRun} resolves to: `ok` (exit 0) when the plan writes
 * at least one file, `noop` (exit 0) when it writes none, `pending` (exit 3)
 * when decisions are still `null`, and `drift` (exit 4) when the survey or a
 * project file changed after the answers were made. `changes` is non-empty
 * only for `ok`, `handoff` only for `ok`/`noop`, `pending` only for
 * `pending` and `drift` only for `drift`.
 *
 * @example
 * ```ts
 * import type { ApplyDryRunOutcome } from "./headless/apply-plan.js";
 *
 * const describe = (outcome: ApplyDryRunOutcome): string =>
 *   `${outcome.status}: ${String(outcome.changes.length)} file(s)`;
 * ```
 */
export type ApplyDryRunOutcome = OutcomeFields &
  (
    | { readonly status: "ok" | "noop"; readonly exitCode: 0 }
    | { readonly status: "pending"; readonly exitCode: 3 }
    | { readonly status: "drift"; readonly exitCode: 4 }
  );

/** {@link runApplyDryRun}'s input. */
interface ApplyDryRunParams {
  /** The adopted project, absolute. */
  readonly targetDir: string;
  /** The answers file, as given on the command line (resolved against the working directory). */
  readonly applyPath: string;
}

/** An outcome with nothing planned: every list empty except the one `fields` sets. */
function emptyOutcome(target: string): OutcomeFields {
  return {
    target,
    changes: [],
    handoff: [],
    pending: [],
    drift: [],
    warnings: [],
  };
}

/** The issues as indented `<pointer>: <message>` lines, `(root)` for the empty pointer. */
function issueLines(
  issues: readonly { readonly pointer: string; readonly message: string }[],
): string {
  return issues
    .map(({ pointer, message }) => `  ${pointer || "(root)"}: ${message}`)
    .join("\n");
}

/** {@link MAX_READ_BYTES} in MiB, for messages. */
const MAX_READ_MIB = String(MAX_READ_BYTES / 1024 / 1024);

/**
 * The answers-file open/read errnos that describe the caller's invocation (a
 * wrong, unreadable or non-file path) and so exit 2; any other failure (`EIO`,
 * `EMFILE`, ...) is the machine's, a runtime error.
 */
const ANSWERS_USAGE_ERRNOS: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
]);

/**
 * Reads the regular file open at `fd`, at most {@link MAX_READ_BYTES}:
 * `notFile` builds the error for a directory, FIFO or device, `tooLarge` the
 * one for an oversized file (checked before the read and again after it, as
 * the file may grow in between). Read errors propagate unchanged.
 */
function readCapped(
  fd: number,
  notFile: () => Error,
  tooLarge: () => Error,
): Buffer {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw notFile();
  if (stat.size > MAX_READ_BYTES) throw tooLarge();
  const bytes = readFileSync(fd);
  if (bytes.length > MAX_READ_BYTES) throw tooLarge();
  return bytes;
}

/**
 * Reads the answers file: a regular file (a directory, FIFO or device is
 * refused; opened non-blocking so a FIFO never hangs the open) of at most
 * {@link MAX_READ_BYTES}. A non-file, an oversized file or an open/read
 * failure with an {@link ANSWERS_USAGE_ERRNOS} code is a usage error naming
 * `path`; any other failure is a runtime error with the cause chained.
 */
function readAnswersBytes(path: string): Buffer {
  const advice = "--apply needs the JSON file of a completed pending document";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    return readCapped(
      fd,
      () =>
        new CliUsageError(
          `the answers file ${path} is not a regular file -- ${advice}`,
        ),
      () =>
        new CliUsageError(
          `the answers file ${path} is larger than ${MAX_READ_MIB} MiB -- ${advice}`,
        ),
    );
  } catch (cause) {
    if (cause instanceof CliUsageError) throw cause;
    const code = errnoCode(cause);
    if (code !== undefined && ANSWERS_USAGE_ERRNOS.has(code)) {
      throw new CliUsageError(
        `could not read the answers file ${path} (${code})`,
        { cause },
      );
    }
    throw new Error(
      `could not read the answers file ${path} (${code ?? "unknown error"})`,
      { cause },
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: the read outcome above is what matters.
      }
    }
  }
}

/**
 * Parses and validates the answers file under the `partial` profile, then
 * requires an adopt document bound to a survey (`basis.inventorySha256`).
 * The `JSON.parse` error is deliberately not chained: its message quotes the
 * file's content.
 */
function readAnswers(path: string): {
  readonly parsed: unknown;
  readonly answers: AnswersV1;
  readonly basis: string;
} {
  const text = readAnswersBytes(path).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliUsageError(
      `the answers file ${path} is not valid JSON -- --apply needs the JSON file of a completed pending document`,
    );
  }
  const result = validateAnswers(parsed, "partial");
  if (!result.ok) {
    throw new CliUsageError(
      `the answers file ${path} is not a valid groundwork.answers v1 document:\n${issueLines(result.errors)}`,
    );
  }
  const answers = result.value;
  if (answers.mode !== "adopt") {
    throw new CliUsageError(
      `the answers file ${path} is a ${answers.mode} document -- --adopt --apply needs mode "adopt" (the pending document --adopt --json writes)`,
    );
  }
  const { basis } = answers;
  if (basis === null || !("inventorySha256" in basis)) {
    throw new CliUsageError(
      `the answers file ${path} has no basis.inventorySha256 binding it to a survey -- start from the pending document --adopt --json writes`,
    );
  }
  return { parsed, answers, basis: basis.inventorySha256 };
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A shape check: why `value` (found at `label`) is unusable, or `undefined` when it is fine. */
type FieldCheck = (value: unknown, label: string) => string | undefined;

/** The first problem `check` finds in an array at `label`, each entry labelled `label[i]`. */
function arrayProblem(
  value: unknown,
  label: string,
  check: FieldCheck,
): string | undefined {
  if (!Array.isArray(value)) return `${label} is not an array`;
  for (const [index, entry] of value.entries()) {
    const problem = check(entry, `${label}[${String(index)}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The first of `keys` that is not an own string property of the object `value`, as `label.key`. */
function stringsProblem(
  value: Readonly<Record<string, unknown>>,
  label: string,
  keys: readonly string[],
): string | undefined {
  const bad = keys.find(
    (key) => !Object.hasOwn(value, key) || typeof value[key] !== "string",
  );
  return bad === undefined ? undefined : `${label}.${bad} is not a string`;
}

/** A staged-copies record (`stagedBaseline`/`stagedDivergent`): a `dir` and `{path, staged, sha256}` files. */
const stagedRecordProblem: FieldCheck = (value, label) => {
  if (!isObject(value)) return `${label} is not an object`;
  return (
    stringsProblem(value, label, ["dir"]) ??
    arrayProblem(value["files"], `${label}.files`, (file, fileLabel) =>
      isObject(file)
        ? stringsProblem(file, fileLabel, ["path", "staged", "sha256"])
        : `${fileLabel} is not an object`,
    )
  );
};

/** A conflict entry, as far as the planner reads one: `relPath`, `status` and a `targetSha256` string or `null`. */
const conflictProblem: FieldCheck = (value, label) => {
  if (!isObject(value)) return `${label} is not an object`;
  const sha = Object.hasOwn(value, "targetSha256")
    ? value["targetSha256"]
    : undefined;
  return (
    stringsProblem(value, label, ["relPath", "status"]) ??
    (typeof sha === "string" || sha === null
      ? undefined
      : `${label}.targetSha256 is not a string or null`)
  );
};

/** A pack survey: a `name` and its `fileConflicts`. */
const packProblem: FieldCheck = (value, label) => {
  if (!isObject(value)) return `${label} is not an object`;
  return (
    stringsProblem(value, label, ["name"]) ??
    arrayProblem(
      value["fileConflicts"],
      `${label}.fileConflicts`,
      conflictProblem,
    )
  );
};

/**
 * Narrows a parsed `inventory.json` to the fields the planner and the
 * executor read, or returns why it cannot be used, naming the first failing
 * field (`stagedDivergent.files`, `conflicts[2].targetSha256`, ...). Shape
 * only: the planner checks every path against the answers.
 */
function inventoryProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "it is not a JSON object";
  const version = value["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return "it has no integer schemaVersion";
  }
  if (version < MIN_INVENTORY_SCHEMA_VERSION) {
    return `it has schemaVersion ${String(version)}, written by an older CLI (--apply needs ${String(MIN_INVENTORY_SCHEMA_VERSION)} or later)`;
  }
  if (version > INVENTORY_SCHEMA_VERSION) {
    return `it has schemaVersion ${String(version)}, written by a newer CLI (this one reads up to ${String(INVENTORY_SCHEMA_VERSION)})`;
  }
  const field =
    arrayProblem(value["conflicts"], "conflicts", conflictProblem) ??
    stagedRecordProblem(value["stagedBaseline"], "stagedBaseline") ??
    stagedRecordProblem(value["stagedDivergent"], "stagedDivergent") ??
    arrayProblem(value["packs"], "packs", packProblem);
  return field === undefined
    ? undefined
    : `its conflicts, packs or staged copies are malformed: ${field}`;
}

/**
 * Reads the inventory's bytes: `.groundwork` must be a real directory (a
 * symlink there is refused, so the survey read is the project's own), and the
 * inventory a regular file of at most {@link MAX_READ_BYTES}, opened without
 * following a symlink. An absent, symlinked, non-regular or oversized survey
 * is a usage error telling the caller to survey first; any other failure (a
 * permission error, say) is a runtime error with the cause chained.
 */
function readInventoryBytes(targetDir: string, path: string): Buffer {
  const dir = join(targetDir, GROUNDWORK_DIR);
  const notSurvey = (what: string): CliUsageError =>
    new CliUsageError(
      `${what}, so there is no survey to apply answers to -- ${RUN_ADOPT_FIRST}`,
    );
  let fd: number | undefined;
  try {
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory()) {
      throw notSurvey(`${dir} is not a directory (a symlink is refused)`);
    }
    fd = openSync(path, INVENTORY_READ_FLAGS);
    return readCapped(
      fd,
      () => notSurvey(`${path} is not a regular file`),
      () =>
        new CliUsageError(
          `${path} is larger than ${MAX_READ_MIB} MiB, so the survey is unusable -- ${RUN_ADOPT_FIRST}`,
        ),
    );
  } catch (cause) {
    if (cause instanceof CliUsageError) throw cause;
    const code = errnoCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new CliUsageError(
        `${targetDir} has no ${INVENTORY_RELATIVE_PATH}, so there is no survey to apply answers to -- ${RUN_ADOPT_FIRST}`,
        { cause },
      );
    }
    if (code === "ELOOP") {
      throw new CliUsageError(
        `${path} is not a regular file, so there is no survey to apply answers to -- ${RUN_ADOPT_FIRST}`,
        { cause },
      );
    }
    throw new Error(`could not read ${path}`, { cause });
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: the read outcome above is what matters.
      }
    }
  }
}

/**
 * Reads `.groundwork/inventory.json` ({@link readInventoryBytes}) and returns
 * its raw bytes and parsed content. A garbled, malformed or too old inventory
 * is a usage error telling the caller to survey first.
 */
function loadInventory(targetDir: string): {
  readonly inventory: Inventory;
  readonly bytes: Buffer;
} {
  const path = join(targetDir, INVENTORY_RELATIVE_PATH);
  const bytes = readInventoryBytes(targetDir, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    // Not chained: the parse error quotes the file's content.
    throw new CliUsageError(
      `${path} is not valid JSON, so the survey is unusable -- ${RUN_ADOPT_FIRST}`,
    );
  }
  const problem = inventoryProblem(parsed);
  if (problem !== undefined) {
    throw new CliUsageError(
      `${path} cannot be used: ${problem} -- ${RUN_ADOPT_FIRST}`,
    );
  }
  // Checked by inventoryProblem for every field the planner and executor read.
  return { inventory: parsed as Inventory, bytes };
}

/** The pointers of a decision `null` leaves open: `kind`, `runtime`, a conflict's `resolution`, an addition's `action`. */
const DECISION_POINTER =
  /^\/(?:interview\/(?:kind|runtime)|adopt\/conflicts\/\d+\/resolution|adopt\/additions\/\d+\/action)$/;

/** One decision the answers still leave `null`: its pointer and allowed values. */
interface OpenDecision {
  readonly pointer: string;
  readonly choices: readonly string[];
}

/**
 * Every decision `answers` (validated under the `partial` profile) still
 * leaves `null`, in document order: `interview.kind`, `interview.runtime`,
 * each `adopt.conflicts[].resolution` and each `adopt.additions[].action`.
 * Walked from the document itself, so the list is complete however many
 * there are -- the validator's error list stops at a fixed cap.
 */
function openDecisions(answers: AnswersV1): readonly OpenDecision[] {
  const open: OpenDecision[] = [];
  if (answers.interview.kind === null) {
    open.push({ pointer: "/interview/kind", choices: PROJECT_KINDS });
  }
  if (answers.interview.runtime === null) {
    open.push({ pointer: "/interview/runtime", choices: RUNTIME_TARGETS });
  }
  const adopt = answers.adopt;
  if (adopt !== null) {
    for (const [index, conflict] of adopt.conflicts.entries()) {
      if (conflict.resolution === null) {
        open.push({
          pointer: `/adopt/conflicts/${String(index)}/resolution`,
          choices: CONFLICT_RESOLUTIONS,
        });
      }
    }
    for (const [index, addition] of adopt.additions.entries()) {
      if (addition.action === null) {
        open.push({
          pointer: `/adopt/additions/${String(index)}/action`,
          choices: ADDITION_ACTIONS,
        });
      }
    }
  }
  return open;
}

/**
 * The pending entry for an open `decision`: the answers document's own entry
 * at the same pointer when it still lists one (the survey's reason, choices
 * and evidence), otherwise one built here.
 */
function pendingEntryFor(
  decision: OpenDecision,
  listed: readonly PendingEntry[],
): PendingEntry {
  const own = listed.find((entry) => entry.pointer === decision.pointer);
  return (
    own ?? {
      pointer: decision.pointer,
      reason: "this decision is still null -- set it to one of the choices",
      choices: decision.choices,
      evidence: null,
    }
  );
}

/**
 * Validates the answers under the `complete` profile. Resolves to the
 * document, or -- when the validator's only problems are undecided (`null`)
 * decisions plus the `pending` list those leave non-empty -- to one pending
 * entry per decision {@link openDecisions} finds in `partial`. Any other
 * problem is a usage error listing every issue.
 */
function completeAnswers(
  path: string,
  parsed: unknown,
  partial: AnswersV1,
):
  | { readonly ok: true; readonly answers: AnswersV1 }
  | { readonly ok: false; readonly pending: readonly PendingEntry[] } {
  const result = validateAnswers(parsed, "complete");
  if (result.ok) return { ok: true, answers: result.value };
  const open = openDecisions(partial);
  const other = result.errors.filter(
    (issue) =>
      open.length === 0 ||
      !(DECISION_POINTER.test(issue.pointer) || issue.pointer === "/pending"),
  );
  if (other.length > 0) {
    throw new CliUsageError(
      `the answers file ${path} is not complete enough to apply:\n${issueLines(other)}`,
    );
  }
  return {
    ok: false,
    pending: open.map((decision) => pendingEntryFor(decision, partial.pending)),
  };
}

/**
 * The {@link TargetState} at `relPath` under `targetDir`: one no-follow read
 * hashed as raw bytes. Only `ENOENT` is `absent`; a symlink, a directory or
 * any other failure is `unreadable` with its code.
 */
function targetState(targetDir: string, relPath: string): TargetState {
  try {
    return {
      kind: "file",
      sha256: sha256Hex(readRegularNoFollow(join(targetDir, relPath)).bytes),
    };
  } catch (error) {
    if (error instanceof NotRegularFileError) {
      return { kind: "unreadable", code: "ENOTFILE" };
    }
    const code = errnoCode(error) ?? "EUNKNOWN";
    return code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", code };
  }
}

/**
 * Plans `--adopt --apply <applyPath> --dry-run` against the adopted project
 * at `targetDir`, writing nothing. In order: read the answers file (a regular
 * file of at most 8 MiB; not valid JSON, not a valid answers document under
 * the `partial` profile, not mode `adopt` or with no
 * `basis.inventorySha256` is a usage error); load `.groundwork/inventory.json`
 * (absent, garbled or below schema 7 is a usage error saying to run
 * `--adopt` first) and compare the sha256 of its raw bytes with the basis --
 * a mismatch is `drift` (exit 4) with one entry for the inventory, checked
 * before completeness; validate under the `complete` profile -- decisions
 * still `null` are `pending` (exit 3), one `PendingEntry` each, any other
 * problem a usage error; plan with `planAdoptActions` over the real tree
 * (a planner usage error is a usage error listing every issue, its drift is
 * `drift`); finally run `applyAdoptActions` with `dryRun: true`, which
 * verifies every staged copy and target and computes `changes`.
 *
 * @throws {@link CliUsageError} for every exit-2 problem above.
 * @throws `ApplyError` (`./errors.ts`), unchanged, when the executor refuses
 *   the plan (a staged copy that no longer matches its recorded hash, say).
 * @throws `Error` when the inventory exists but cannot be read.
 *
 * @example
 * ```ts
 * import { runApplyDryRun } from "./headless/apply-plan.js";
 *
 * const outcome = await runApplyDryRun({
 *   targetDir: "/work/app",
 *   applyPath: "answers.json",
 * });
 * for (const change of outcome.changes) console.log(change.path);
 * process.exitCode = outcome.exitCode;
 * ```
 */
export async function runApplyDryRun(
  params: ApplyDryRunParams,
): Promise<ApplyDryRunOutcome> {
  const { targetDir } = params;
  const applyPath = resolve(params.applyPath);
  const { parsed, answers: partial, basis } = readAnswers(applyPath);
  const { inventory, bytes } = loadInventory(targetDir);
  const empty = emptyOutcome(targetDir);

  const actual = sha256Hex(bytes);
  if (actual !== basis) {
    return {
      ...empty,
      status: "drift",
      exitCode: 4,
      drift: [{ path: INVENTORY_RELATIVE_PATH, expected: basis, actual }],
    };
  }

  const complete = completeAnswers(applyPath, parsed, partial);
  if (!complete.ok) {
    return {
      ...empty,
      status: "pending",
      exitCode: 3,
      pending: complete.pending,
    };
  }

  const plan = planAdoptActions(inventory, complete.answers, {
    sha256OfTarget: (relPath) => targetState(targetDir, relPath),
  });
  if (!plan.ok) {
    if (plan.kind === "drift") {
      return { ...empty, status: "drift", exitCode: 4, drift: plan.drift };
    }
    throw new CliUsageError(
      `the answers file ${applyPath} does not fit the survey in ${INVENTORY_RELATIVE_PATH}:\n${issueLines(
        plan.errors.map(({ pointer, reason }) => ({
          pointer,
          message: reason,
        })),
      )}`,
    );
  }

  const { changes, warnings } = await applyAdoptActions({
    root: targetDir,
    actions: plan.actions,
    dryRun: true,
  });
  return {
    ...empty,
    status: changes.length > 0 ? "ok" : "noop",
    exitCode: 0,
    changes,
    handoff: plan.handoff,
    warnings,
  };
}
