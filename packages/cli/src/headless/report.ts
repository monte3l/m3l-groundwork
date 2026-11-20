// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `groundwork.report` v1 document a `--json` run writes to stdout
 * (`.claude/rules/headless-mode.md`, "report v1"). Pure builders only: the
 * bin script decides when to write one. A fresh run reports `phase: "apply"`,
 * an adopt survey `phase: "survey"`; `changes`, `pending`, `handoff` and
 * `drift` are always empty until `--apply` ships. Every field is present and
 * none is `undefined`, in a fixed key order, so the serialized document is
 * byte-stable for the same input.
 */
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import { errorMessageChain } from "../format-error.js";
import type { RunResult } from "../run-result.js";

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
  readonly dryRun: false;
  readonly status: "ok" | "error" | "usage";
  readonly exitCode: ExitCode;
  readonly target: string | null;
  readonly artifacts: ReportArtifacts;
  readonly changes: readonly never[];
  readonly pending: readonly never[];
  readonly handoff: readonly never[];
  readonly drift: readonly never[];
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

/** Assembles a report in its fixed key order from the fields that vary between runs. */
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
  > & { readonly inventory: string | null; readonly manifest: string | null },
): ReportV1 {
  return {
    schema: "groundwork.report",
    schemaVersion: 1,
    cliVersion,
    mode: fields.mode,
    phase: fields.phase,
    dryRun: false,
    status: fields.status,
    exitCode: fields.exitCode,
    target: fields.target,
    artifacts: {
      inventory: fields.inventory,
      manifest: fields.manifest,
      plan: null,
      pending: null,
      commitMsg: null,
      prBody: null,
    },
    changes: [],
    pending: [],
    handoff: [],
    drift: [],
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
 * `.groundwork/manifest.json`, `null` for adopt).
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
 * `manifest`) are always `null`. `error.chain` is
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
    setupSteps: [],
    warnings: [],
    nextStep: null,
    error: { message, chain },
  });
}
