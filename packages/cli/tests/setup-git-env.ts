// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// A vitest `setupFiles` entry (see the root vitest.config.ts): runs in every
// test worker before any test file loads. git exports GIT_DIR,
// GIT_INDEX_FILE and friends into the processes it spawns for a hook -- a
// pre-push run from a linked worktree included -- and any test that then
// spawns `git` with the inherited environment would act on the pushing repo
// rather than its own temp-directory fixture. Stripping every GIT_* variable
// here keeps those tests hermetic. Guarded by git-env-hermetic.test.ts.

/**
 * Deletes every `GIT_*` variable from `env` in place, leaving all other keys
 * (including look-alikes such as `GITHUB_TOKEN`) untouched.
 *
 * @param env - The environment to scrub; defaults to `process.env`.
 *
 * @example
 * ```ts
 * import { scrubGitEnv } from "./setup-git-env.js";
 *
 * const env: NodeJS.ProcessEnv = { GIT_DIR: "/repo/.git", PATH: "/usr/bin" };
 * scrubGitEnv(env);
 * // env is now { PATH: "/usr/bin" }
 * ```
 */
export function scrubGitEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) {
      delete env[key];
    }
  }
}

scrubGitEnv();
