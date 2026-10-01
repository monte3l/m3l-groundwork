// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Guards the hermetic-environment contract: git exports `GIT_DIR`,
 * `GIT_INDEX_FILE` and friends into hook processes (a pre-push run from a
 * linked worktree included), and any test that spawns `git` with the default
 * environment would then operate on the pushing repo instead of its own
 * fixture. `setup-git-env.ts` (a vitest `setupFiles` entry) strips them.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scrubGitEnv } from "./setup-git-env.js";

describe("git environment hermeticity", () => {
  it("scrubGitEnv removes every GIT_* variable and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: "/nope",
      GIT_INDEX_FILE: "/nope/index",
      GIT_PREFIX: "x/",
      GIT_COMMON_DIR: "/nope",
      PATH: "/usr/bin",
      GITHUB_TOKEN: "keep-me",
    };
    scrubGitEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", GITHUB_TOKEN: "keep-me" });
  });

  it("the worker env is clean, and a spawned git ignores a would-be inherited GIT_DIR", () => {
    // Under the real hook (or `GIT_DIR=... pnpm test`), the setup file has
    // already scrubbed the worker before this runs.
    expect(
      Object.keys(process.env).filter((k) => k.startsWith("GIT_")),
    ).toEqual([]);

    process.env["GIT_DIR"] = "/definitely/not/a/repo";
    try {
      scrubGitEnv();
      const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
        cwd: process.cwd(),
      });
      expect(r.stdout.trim()).toBe("true");
    } finally {
      delete process.env["GIT_DIR"];
    }
  });
});
