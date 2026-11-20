// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * What a completed fresh or adopt run reports back to its caller, alongside
 * the status lines it printed.
 */
import type { PendingEntry } from "./headless/contract.js";

/**
 * The outcome of one fresh or adopt run: the resolved mode and target, the
 * unpainted text of each warning the run printed (filled by `runFresh` in
 * `main.ts`; always empty in adopt mode), the pack setup steps still to run,
 * grouped per pack in the order they were printed (fresh mode only),
 * adopt mode's printed `Next: ...` line (`null` in fresh mode), and the
 * target-relative path of the upgrade manifest the run wrote (fresh mode's
 * `MANIFEST_RELATIVE_PATH` from `manifest.ts`; `null` in adopt mode, which
 * writes none), plus the pending decisions an `--adopt --json` survey wrote
 * to `.groundwork/headless/pending.json` and that file's target-relative
 * path (`[]` and `null` for a fresh run and for an adopt run without
 * `--json`, which writes no pending document).
 *
 * @example
 * ```ts
 * import type { RunResult } from "./run-result.js";
 * const result: RunResult = {
 *   mode: "fresh",
 *   target: "/tmp/acme",
 *   warnings: [],
 *   setupSteps: [],
 *   nextStep: null,
 *   manifest: ".groundwork/manifest.json",
 *   pending: [],
 *   pendingPath: null,
 * };
 * ```
 */
export interface RunResult {
  readonly mode: "fresh" | "adopt";
  readonly target: string;
  readonly warnings: readonly string[];
  readonly setupSteps: readonly { pack: string; steps: readonly string[] }[];
  readonly nextStep: string | null;
  readonly manifest: string | null;
  readonly pending: readonly PendingEntry[];
  readonly pendingPath: string | null;
}
