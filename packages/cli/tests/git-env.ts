// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The repo-local git environment variables, and an in-place scrub of them.
 *
 * Why this exists: git exports repository-locating variables into every hook
 * process it spawns -- `GIT_DIR` on a `pre-push` run from a linked worktree,
 * `GIT_INDEX_FILE` on `pre-commit`, and `GIT_PREFIX` when the hook is run
 * from a subdirectory. A test that then spawns `git` with the inherited
 * environment acts on the pushing repository instead of its own temp
 * fixture.
 *
 * Measured: with only `GIT_DIR` set to another repository's gitdir,
 * `worktree-guards.test.ts` and `compact-handoff.test.ts` fail 10 tests
 * between them; `GIT_INDEX_FILE` alone fails 1; `GIT_PREFIX` alone fails
 * none, but is stripped anyway for parity with what git itself does to a
 * hook's environment.
 *
 * Why the five per-file `envWithoutRepoLocals` helpers (in the
 * worktree-guards, compact-handoff, core-hooks, nudge-invariants and
 * post-edit-verify tests) were not enough: they only filter the env passed
 * to each test's own fixture-setup spawns. The shipped hooks under test
 * (`guard-worktree-only`, `ensure-worktree-deps`, `guard-branch-isolation`,
 * `post-edit-verify`) and the helper functions `compact-handoff` exercises
 * spawn git in-process with the inherited `process.env`, so removing the
 * `setupFiles` entry regresses those tests under a real hook. Scrubbing
 * `process.env` itself, once per worker, is what covers them.
 *
 * Deliberately NOT scrubbed: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`,
 * `GIT_CEILING_DIRECTORIES` and the `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
 * identity variables -- fixtures set those on purpose for their own
 * hermeticity.
 *
 * This module has no top-level side effects; `setup-git-env.ts` (the vitest
 * `setupFiles` entry) is the one caller that invokes {@link scrubGitEnv}
 * eagerly. Guarded by `git-env-hermetic.test.ts`.
 *
 * @packageDocumentation
 */

/**
 * git's own `git rev-parse --local-env-vars` list, hard-coded, plus
 * `GIT_PREFIX` -- absent from that list on some git versions, but exported
 * to a hook run from a subdirectory.
 *
 * @example
 * ```ts
 * import { REPO_LOCAL_GIT_ENV } from "./git-env.js";
 *
 * const leaked = REPO_LOCAL_GIT_ENV.filter((key) => key in process.env);
 * ```
 */
export const REPO_LOCAL_GIT_ENV: readonly string[] = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/**
 * Deletes every {@link REPO_LOCAL_GIT_ENV} key from `env`, in place. Every
 * other variable -- including the deliberate hermeticity knobs listed in this
 * module's header -- is left untouched.
 *
 * @param env - The environment to scrub; defaults to `process.env`.
 *
 * @example
 * ```ts
 * import { scrubGitEnv } from "./git-env.js";
 *
 * const env = { ...process.env, GIT_DIR: "/elsewhere/.git" };
 * scrubGitEnv(env); // env.GIT_DIR is now gone
 * ```
 */
export function scrubGitEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REPO_LOCAL_GIT_ENV) {
    delete env[key];
  }
}
