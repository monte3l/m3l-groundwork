// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The two mechanical steps fresh mode runs after emission -- writing the
 * baseline template tree into the target directory (`emitTemplate` in
 * `emit.ts`, called from `main.ts`'s `runFresh`). `gitInit` initializes a
 * fresh git repository there (`git init -q`); `runInstall` then runs the
 * first package install (`pnpm install`). Both run synchronously in the
 * target directory. The child's stdio defaults to `"inherit"` (its output
 * passed straight through); a caller can pass any other `StdioOptions` value
 * -- headless `--json` runs pass one that keeps stdout pure, as
 * `.claude/rules/headless-mode.md` specifies.
 */
import { execFileSync, type StdioOptions } from "node:child_process";

/**
 * Runs `git init -q` in `cwd`, synchronously; throws whatever
 * `execFileSync` throws when git is missing or exits non-zero.
 *
 * @param cwd - The directory to initialize.
 * @param stdio - The child's stdio, forwarded to `execFileSync`; defaults
 * to `"inherit"`.
 *
 * @example
 * ```ts
 * import { gitInit } from "./git.js";
 *
 * gitInit("/path/to/new-project");
 * gitInit("/path/to/new-project", "pipe"); // any StdioOptions value
 * ```
 */
export function gitInit(cwd: string, stdio: StdioOptions = "inherit"): void {
  execFileSync("git", ["init", "-q"], { cwd, stdio });
}

/**
 * Runs `pnpm install` in `cwd`, synchronously; throws whatever
 * `execFileSync` throws when pnpm is missing or exits non-zero.
 *
 * @param cwd - The directory to install in.
 * @param stdio - The child's stdio, forwarded to `execFileSync`; defaults
 * to `"inherit"`.
 *
 * @example
 * ```ts
 * import { runInstall } from "./git.js";
 *
 * runInstall("/path/to/new-project");
 * runInstall("/path/to/new-project", "pipe"); // any StdioOptions value
 * ```
 */
export function runInstall(cwd: string, stdio: StdioOptions = "inherit"): void {
  execFileSync("pnpm", ["install"], { cwd, stdio });
}
