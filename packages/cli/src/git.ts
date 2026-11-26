// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The two mechanical steps fresh mode runs after emission -- writing the
 * baseline template tree into the target directory (`emitTemplate` in
 * `emit.ts`, called from `main.ts`'s `runFresh`). `gitInit` initializes a
 * fresh git repository there (`git init -q`); `runInstall` then runs the
 * first package install (`pnpm install`). Both run synchronously in the
 * target directory with the child's output passed straight through.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { errnoCode } from "./survey/internal/read-guard.js";

export function gitInit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd, stdio: "inherit" });
}

export function runInstall(cwd: string): void {
  execFileSync("pnpm", ["install"], { cwd, stdio: "inherit" });
}

/** The three sides of a text merge and the versions that label them. */
export interface GitMergeFileInput {
  /** The project's current text. */
  readonly ours: string;
  /** The text groundwork wrote at `baseVersion`. */
  readonly base: string;
  /** The text this CLI (`cliVersion`) would write. */
  readonly theirs: string;
  readonly baseVersion: string;
  readonly cliVersion: string;
}

/**
 * {@link gitMergeFile}'s outcome: the merged text and its conflict count, or
 * why no merge could be made.
 */
export type GitMergeFileResult =
  | { readonly text: string; readonly conflicts: number }
  | { readonly unavailable: string };

/** Largest exit status `git merge-file` uses for a conflict count. */
const MAX_CONFLICT_STATUS = 127;
/** Largest merged output accepted from `git merge-file`, in bytes. */
const MERGE_MAX_BUFFER = 64 * 1024 * 1024;
/** How long `git merge-file` may run, in milliseconds. */
const MERGE_TIMEOUT_MS = 60_000;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failureFromError(error: unknown): GitMergeFileResult {
  if (!isRecordLike(error)) {
    return { unavailable: "git merge-file failed (unknown error)" };
  }
  // execFileSync's own limits kill the child with SIGTERM too: name the
  // limit, not the signal.
  const code = errnoCode(error);
  if (code === "ENOBUFS") return { unavailable: "output too large to merge" };
  if (code === "ETIMEDOUT") {
    return {
      unavailable: `git merge-file timed out after ${String(MERGE_TIMEOUT_MS / 1000)} s`,
    };
  }
  const { status, signal, stdout } = error;
  if (typeof signal === "string") {
    return { unavailable: `git merge-file was killed by ${signal}` };
  }
  if (typeof status === "number") {
    if (status >= 1 && status <= MAX_CONFLICT_STATUS) {
      const text =
        typeof stdout === "string"
          ? stdout
          : Buffer.isBuffer(stdout)
            ? stdout.toString("utf8")
            : undefined;
      // An empty output is a failure of git (or a wrapper), not a merge.
      if (text !== undefined && text !== "") {
        return { text, conflicts: status };
      }
    }
    return { unavailable: `git merge-file failed (exit status ${status})` };
  }
  return {
    unavailable: `git merge-file could not run (${errnoCode(error) ?? "unknown error"})`,
  };
}

/**
 * Three-way merges `ours` and `theirs` against `base` with
 * `git merge-file -p --diff3`, labelling the sides `yours`,
 * `groundwork <baseVersion>` and `groundwork <cliVersion>`. The three inputs
 * go to temp files under `os.tmpdir()` (never the project), removed
 * best-effort afterwards; git runs in that directory with the system and
 * global git config disabled (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`),
 * a 64 MiB output limit and a 60 s timeout. Exit status 0 is a clean merge,
 * 1-127 with output that many conflicts (the text keeps diff3 markers). A
 * temp directory that cannot be written, a missing `git`, a status above
 * 127 or with no output, output over the limit, a timeout, a signal or any
 * other failure is `{ unavailable }`, whose reason
 * carries only a fixed message and the errno/status/signal -- never git's
 * output. Never throws.
 *
 * @example
 * ```ts
 * import { gitMergeFile } from "./git.js";
 *
 * const result = gitMergeFile({
 *   ours: "mine\n",
 *   base: "old\n",
 *   theirs: "new\n",
 *   baseVersion: "1.0.0",
 *   cliVersion: "1.1.0",
 * });
 * if ("unavailable" in result) console.log(result.unavailable);
 * else console.log(result.conflicts, result.text);
 * ```
 */
export function gitMergeFile(input: GitMergeFileInput): GitMergeFileResult {
  let dir: string | undefined;
  try {
    let paths: readonly [string, string, string];
    try {
      dir = mkdtempSync(join(tmpdir(), "m3l-merge-"));
      paths = [join(dir, "ours"), join(dir, "base"), join(dir, "theirs")];
      writeFileSync(paths[0], input.ours);
      writeFileSync(paths[1], input.base);
      writeFileSync(paths[2], input.theirs);
    } catch (error) {
      return {
        unavailable: `could not write merge inputs to the temporary directory (${errnoCode(error) ?? "unknown error"})`,
      };
    }
    try {
      const text = execFileSync(
        "git",
        [
          "merge-file",
          "-p",
          "--diff3",
          "-L",
          "yours",
          "-L",
          `groundwork ${input.baseVersion}`,
          "-L",
          `groundwork ${input.cliVersion}`,
          ...paths,
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: devNull,
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: MERGE_MAX_BUFFER,
          timeout: MERGE_TIMEOUT_MS,
        },
      );
      return { text, conflicts: 0 };
    } catch (error) {
      return failureFromError(error);
    }
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best-effort: a leftover temp dir under os.tmpdir() must not mask
        // the merge outcome (or its failure) computed above.
      }
    }
  }
}

/**
 * The installed git's `git --version` line (trimmed), or `null` when git
 * cannot be run. Never throws.
 *
 * @example
 * ```ts
 * import { gitVersion } from "./git.js";
 *
 * console.log(gitVersion() ?? "git unavailable");
 * ```
 */
export function gitVersion(): string | null {
  try {
    return execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Any failure (missing git, a signal, a non-zero exit) means "unknown".
    return null;
  }
}
