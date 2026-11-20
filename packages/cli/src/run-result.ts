// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * What a completed fresh or adopt run reports back to its caller, alongside
 * the status lines it printed.
 */

/**
 * The outcome of one fresh or adopt run: the resolved mode and target, the
 * unpainted text of each warning the run printed (filled by `runFresh` in
 * `main.ts`; always empty in adopt mode), the pack setup steps still to run,
 * grouped per pack in the order they were printed (fresh mode only), and
 * adopt mode's printed `Next: ...` line (`null` in fresh mode).
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
 * };
 * ```
 */
export interface RunResult {
  readonly mode: "fresh" | "adopt";
  readonly target: string;
  readonly warnings: readonly string[];
  readonly setupSteps: readonly { pack: string; steps: readonly string[] }[];
  readonly nextStep: string | null;
}
