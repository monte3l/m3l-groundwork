// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one typed error the `--adopt --apply` executor (`headless/apply.ts`)
 * and its lock (`headless/lock.ts`) throw: {@link ApplyError}, carrying the
 * rollback report a caller needs to tell "nothing happened" from "some
 * files landed and could not be restored".
 */

/** The rollback report an {@link ApplyError} is built with; every field is optional. */
interface ApplyErrorOptions extends ErrorOptions {
  readonly written?: readonly string[];
  readonly rolledBack?: boolean;
  readonly leftovers?: readonly string[];
  readonly leftoverReasons?: readonly string[];
  readonly releaseError?: unknown;
}

/**
 * An apply step refused or failed. `written` lists the target-relative paths
 * this run touched before the failure (a replaced file, or an install that
 * created a directory or its file, even part-way), in write order;
 * `rolledBack` is `true` when the project holds none of this run's writes
 * any more (also when nothing had been written); `leftovers` lists the
 * target-relative paths a failed rollback could not restore (then
 * `.groundwork/headless/txn/` is kept for the next run to recover), and
 * `leftoverReasons` says why, one entry per leftover in the same order,
 * each naming its path. `releaseError` is set when the apply lock could not
 * be removed after the run had already failed. The original failure is
 * chained as `cause`.
 *
 * @example
 * ```ts
 * import { ApplyError } from "./headless/errors.js";
 *
 * try {
 *   throw new ApplyError("could not write a.txt", { written: [] });
 * } catch (error) {
 *   if (error instanceof ApplyError && !error.rolledBack) {
 *     console.error(`restore by hand: ${error.leftovers.join(", ")}`);
 *   }
 * }
 * ```
 */
export class ApplyError extends Error {
  override readonly name = "ApplyError";
  readonly written: readonly string[];
  readonly rolledBack: boolean;
  readonly leftovers: readonly string[];
  readonly leftoverReasons: readonly string[];
  readonly releaseError: unknown;

  constructor(message: string, options: ApplyErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.written = [...(options.written ?? [])];
    this.leftovers = [...(options.leftovers ?? [])];
    this.leftoverReasons = [...(options.leftoverReasons ?? [])];
    this.releaseError = options.releaseError;
    this.rolledBack = options.rolledBack ?? this.leftovers.length === 0;
  }
}
