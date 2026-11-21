// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `groundwork.report` v1 document a `--json` run writes to stdout
 * (`.claude/rules/headless-mode.md`, "report v1"). Pure builders only: the
 * bin script decides when to write one. A fresh run reports `phase: "apply"`,
 * an adopt survey `phase: "survey"`, and an `--adopt --apply --dry-run`
 * plan `phase: "apply"` with `dryRun: true`. `pending` carries the entries
 * of the pending document an `--adopt --json` survey wrote, or the decisions
 * an `--apply` run found still open (empty otherwise); `changes`, `handoff`
 * and `drift` are filled only by an `--apply` run. Every field is present
 * and none is `undefined`, in a fixed key order, so the serialized document
 * is byte-stable for the same input.
 */
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import { errorMessageChain } from "../format-error.js";
import type { RunResult } from "../run-result.js";
import type { ApplyDryRunOutcome } from "./apply-plan.js";
import type { PendingEntry } from "./contract.js";

/** Where a fresh/adopt run left its `.groundwork/` artifacts, relative to `target`; `null` when not written. */
interface ReportArtifacts {
  readonly inventory: string | null;
  readonly manifest: string | null;
  readonly plan: string | null;
  readonly pending: string | null;
  readonly commitMsg: string | null;
  readonly prBody: string | null;
}

/** A failed run's error: its message, then that message and each chained value's (`cause` first, then any `AggregateError` members), outermost to root. */
interface ReportError {
  readonly message: string;
  readonly chain: readonly string[];
}

/** One file an `--apply` run writes (or, under `--dry-run`, would write); `sha256Before` is `null` for a new file. */
interface ReportChange {
  readonly path: string;
  readonly action: "install-staged" | "take-divergent" | "merge-keys";
  readonly class: "addition" | "conflict";
  readonly sha256Before: string | null;
  readonly sha256After: string | null;
}

/** Work an `--apply` run hands to the skill's headless branch: a delegated conflict, or the owner's missed notes. */
type ReportHandoff =
  | { readonly kind: "delegate"; readonly path: string }
  | { readonly kind: "missed-notes"; readonly notes: string };

/** A path whose state no longer matches what the answers were made against; `actual` is `null` unless a regular file is there. */
interface ReportDrift {
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
}

/**
 * One `groundwork.report` v1 document, as `JSON.stringify` writes it.
 *
 * @example
 * ```ts
 * import type { ReportV1 } from "./headless/report.js";
 *
 * declare const stdout: string; // a `--json` run's captured stdout
 * const report = JSON.parse(stdout) as ReportV1;
 * if (report.status !== "ok") console.error(report.error?.message);
 * ```
 */
export interface ReportV1 {
  readonly schema: "groundwork.report";
  readonly schemaVersion: 1;
  readonly cliVersion: string;
  readonly mode: "fresh" | "adopt" | null;
  readonly phase: "apply" | "survey" | null;
  readonly dryRun: boolean;
  readonly status: "ok" | "noop" | "pending" | "drift" | "error" | "usage";
  readonly exitCode: ExitCode;
  readonly target: string | null;
  readonly artifacts: ReportArtifacts;
  readonly changes: readonly ReportChange[];
  readonly pending: readonly PendingEntry[];
  readonly handoff: readonly ReportHandoff[];
  readonly drift: readonly ReportDrift[];
  readonly setupSteps: RunResult["setupSteps"];
  readonly warnings: readonly string[];
  readonly nextStep: string | null;
  readonly error: ReportError | null;
}

/** What the builders need beyond the run itself. */
interface ReportContext {
  readonly cliVersion: string;
}

/** Adopt mode's inventory, relative to the target. */
const INVENTORY_PATH = ".groundwork/inventory.json";

/** The apply-only fields of every report not built from an `--apply` run. */
const NO_APPLY: Pick<ReportV1, "dryRun" | "changes" | "handoff" | "drift"> = {
  dryRun: false,
  changes: [],
  handoff: [],
  drift: [],
};

/** Assembles a report in its fixed key order from the fields that vary between runs; `apply` defaults to {@link NO_APPLY}. */
function baseReport(
  cliVersion: string,
  fields: Pick<
    ReportV1,
    | "mode"
    | "phase"
    | "status"
    | "exitCode"
    | "target"
    | "setupSteps"
    | "warnings"
    | "nextStep"
    | "error"
    | "pending"
  > & {
    readonly inventory: string | null;
    readonly manifest: string | null;
    readonly pendingPath: string | null;
  },
  apply: Pick<ReportV1, "dryRun" | "changes" | "handoff" | "drift"> = NO_APPLY,
): ReportV1 {
  return {
    schema: "groundwork.report",
    schemaVersion: 1,
    cliVersion,
    mode: fields.mode,
    phase: fields.phase,
    dryRun: apply.dryRun,
    status: fields.status,
    exitCode: fields.exitCode,
    target: fields.target,
    artifacts: {
      inventory: fields.inventory,
      manifest: fields.manifest,
      plan: null,
      pending: fields.pendingPath,
      commitMsg: null,
      prBody: null,
    },
    changes: apply.changes,
    pending: fields.pending,
    handoff: apply.handoff,
    drift: apply.drift,
    setupSteps: fields.setupSteps,
    warnings: fields.warnings,
    nextStep: fields.nextStep,
    error: fields.error,
  };
}

/**
 * The success report of a completed fresh or adopt run: `status: "ok"`,
 * exit code 0, for adopt mode the inventory it wrote, and the upgrade
 * manifest path the run reported (`result.manifest`: fresh mode's
 * `.groundwork/manifest.json`, `null` for adopt), and the pending document
 * the run reported (`result.pendingPath` as `artifacts.pending` and
 * `result.pending` as `pending`: an `--adopt --json` survey's
 * `.groundwork/headless/pending.json` and its entries, otherwise `null` and
 * `[]`). Pending decisions do not change the status or exit code: a survey
 * that wrote them is still `ok` with exit 0.
 *
 * @example
 * ```ts
 * import { buildReport } from "./headless/report.js";
 *
 * const report = buildReport(
 *   {
 *     mode: "fresh",
 *     target: "/work/acme",
 *     warnings: [],
 *     setupSteps: [],
 *     nextStep: null,
 *     manifest: ".groundwork/manifest.json",
 *     pending: [],
 *     pendingPath: null,
 *   },
 *   { cliVersion: "1.2.3" },
 * );
 * process.stdout.write(`${JSON.stringify(report)}\n`);
 * ```
 */
export function buildReport(result: RunResult, ctx: ReportContext): ReportV1 {
  const adopt = result.mode === "adopt";
  return baseReport(ctx.cliVersion, {
    mode: result.mode,
    phase: adopt ? "survey" : "apply",
    status: "ok",
    exitCode: EXIT_CODES.ok,
    target: result.target,
    inventory: adopt ? INVENTORY_PATH : null,
    manifest: result.manifest,
    pendingPath: result.pendingPath,
    pending: result.pending,
    setupSteps: result.setupSteps,
    warnings: result.warnings,
    nextStep: result.nextStep,
    error: null,
  });
}

/**
 * The error envelope of a failed run: `status: "usage"` for exit code 2,
 * `"error"` for any other fatal code, with the thrown value's message and
 * chain. `mode`, `phase`, `target` and every `artifacts` path (including
 * `manifest` and `pending`) are always `null`, and `pending` is empty. `error.chain` is
 * `errorMessageChain(error)` (`../format-error.ts`): every entry a string,
 * the first equal to `error.message`, an unreadable message rendered as
 * `[unprintable value]`, cycles cut and depth capped. Never throws, whatever
 * `error` is -- the bin script relies on that for its fallback envelope.
 *
 * @example
 * ```ts
 * import { buildErrorReport } from "./headless/report.js";
 *
 * const report = buildErrorReport(new Error("disk full"), 1, {
 *   cliVersion: "1.2.3",
 * });
 * process.stdout.write(`${JSON.stringify(report)}\n`);
 * ```
 */
export function buildErrorReport(
  error: unknown,
  exitCode: Exclude<ExitCode, typeof EXIT_CODES.ok>,
  ctx: ReportContext,
): ReportV1 {
  const chain = errorMessageChain(error);
  const [message] = chain;
  return baseReport(ctx.cliVersion, {
    mode: null,
    phase: null,
    status: exitCode === EXIT_CODES.usage ? "usage" : "error",
    exitCode,
    target: null,
    inventory: null,
    manifest: null,
    pendingPath: null,
    pending: [],
    setupSteps: [],
    warnings: [],
    nextStep: null,
    error: { message, chain },
  });
}

/**
 * The report of an `--adopt --apply --dry-run` run that reached an outcome
 * (`runApplyDryRun` in `./apply-plan.ts`): mode `adopt`, phase `apply`,
 * `dryRun` true, the outcome's `status` and `exitCode` (`ok` or
 * `noop` with 0, `pending` with 3, `drift` with 4), and its `changes`,
 * `pending`, `handoff`, `drift` and `warnings` copied through. Every
 * `artifacts` path is `null` (a dry run writes nothing, and `pending` lists
 * open decisions without a pending document), `setupSteps` is empty and
 * `nextStep` and `error` are `null`. Same key order as every other report.
 *
 * @example
 * ```ts
 * import { runApplyDryRun } from "./headless/apply-plan.js";
 * import { buildApplyReport } from "./headless/report.js";
 *
 * const outcome = await runApplyDryRun({
 *   targetDir: "/work/acme",
 *   applyPath: "answers.json",
 * });
 * const report = buildApplyReport(outcome, { cliVersion: "1.2.3" });
 * process.stdout.write(`${JSON.stringify(report)}\n`);
 * process.exitCode = report.exitCode;
 * ```
 */
export function buildApplyReport(
  outcome: ApplyDryRunOutcome,
  ctx: ReportContext,
): ReportV1 {
  return baseReport(
    ctx.cliVersion,
    {
      mode: "adopt",
      phase: "apply",
      status: outcome.status,
      exitCode: outcome.exitCode,
      target: outcome.target,
      inventory: null,
      manifest: null,
      pendingPath: null,
      pending: outcome.pending,
      setupSteps: [],
      warnings: outcome.warnings,
      nextStep: null,
      error: null,
    },
    {
      dryRun: true,
      changes: outcome.changes,
      handoff: outcome.handoff,
      drift: outcome.drift,
    },
  );
}
