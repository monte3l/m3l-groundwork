// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// A vitest `setupFiles` entry (see the root vitest.config.ts): runs in every
// test worker before any test file loads. git exports GIT_DIR,
// GIT_INDEX_FILE and friends into the processes it spawns for a hook -- a
// pre-push run from a linked worktree included -- and any test that then
// spawns `git` with the inherited environment would act on the pushing repo
// rather than its own temp-directory fixture. Scrubbing exactly the
// repo-local variables here keeps those tests hermetic, without touching the
// deliberate hermeticity variables (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`,
// `GIT_CEILING_DIRECTORIES`, `GIT_AUTHOR_NAME`) a fixture may set on purpose.
// The actual list and scrub logic live in the pure `./git-env.js` module so
// they can be unit-tested directly; this file only invokes it. Guarded by
// git-env-hermetic.test.ts.

import { scrubGitEnv } from "./git-env.js";

scrubGitEnv();
