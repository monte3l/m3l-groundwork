// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Guards the hermetic-environment contract: git exports `GIT_DIR`,
 * `GIT_INDEX_FILE` and friends (git's own `--local-env-vars` list, plus
 * `GIT_PREFIX`) into hook processes -- a pre-push run from a linked worktree
 * included -- and any test that spawns `git` with the default environment
 * would then operate on the pushing repo instead of its own fixture.
 * `./git-env.js` is the pure module holding that exact variable list
 * (`REPO_LOCAL_GIT_ENV`) and the in-place scrub (`scrubGitEnv`); it has no
 * top-level side effects of its own. `setup-git-env.ts` (the vitest
 * `setupFiles` entry) is the one caller that invokes it eagerly, once per
 * worker, before any test file loads.
 */
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO_LOCAL_GIT_ENV, scrubGitEnv } from "./git-env.js";

// Values git deliberately sets on purpose (a test fixture's own hermeticity
// knobs, or a look-alike unrelated variable) that scrubGitEnv must leave
// untouched precisely because they are not in REPO_LOCAL_GIT_ENV.
const KEEP_ENV = {
  PATH: "/usr/bin",
  GITHUB_TOKEN: "keep-me",
  GIT_CONFIG_GLOBAL: "/fixture/gitconfig",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: "/fixture/ceiling",
  GIT_AUTHOR_NAME: "Fixture Author",
} as const satisfies NodeJS.ProcessEnv;

function buildFixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...KEEP_ENV };
  for (const key of REPO_LOCAL_GIT_ENV) {
    env[key] = "should-be-removed";
  }
  return env;
}

describe("scrubGitEnv", () => {
  for (const key of REPO_LOCAL_GIT_ENV) {
    it(`removes ${key}`, () => {
      const env = buildFixtureEnv();
      scrubGitEnv(env);
      expect(Object.hasOwn(env, key)).toBe(false);
    });
  }

  it("keeps PATH, GITHUB_TOKEN and the deliberate hermeticity variables", () => {
    const env = buildFixtureEnv();
    scrubGitEnv(env);
    expect(env).toEqual(KEEP_ENV);
  });
});

describe("importing git-env.ts", () => {
  const originalValue = process.env["GIT_CONFIG_GLOBAL"];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env["GIT_CONFIG_GLOBAL"];
    } else {
      process.env["GIT_CONFIG_GLOBAL"] = originalValue;
    }
  });

  it("has no top-level side effect on process.env", async () => {
    process.env["GIT_CONFIG_GLOBAL"] = "/fixture/untouched-by-import";
    vi.resetModules();

    await import("./git-env.js");

    expect(process.env["GIT_CONFIG_GLOBAL"]).toBe(
      "/fixture/untouched-by-import",
    );
  });
});

describe("REPO_LOCAL_GIT_ENV parity with git itself", () => {
  it("is a superset of `git rev-parse --local-env-vars` and includes GIT_PREFIX", () => {
    const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const gitLocalEnvVars = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(gitLocalEnvVars.length).toBeGreaterThan(0);
    for (const key of gitLocalEnvVars) {
      expect(REPO_LOCAL_GIT_ENV).toContain(key);
    }
    expect(REPO_LOCAL_GIT_ENV).toContain("GIT_PREFIX");
  });
});

describe("the vitest setupFiles entry already scrubbed this worker", () => {
  // Deliberately never calls scrubGitEnv() here -- the point of this describe
  // block is to prove setup-git-env.ts (wired in via vitest.config.ts's
  // setupFiles) already ran before this test file's own code executed.

  it("process.env carries none of the repo-local git variables", () => {
    const leaked = REPO_LOCAL_GIT_ENV.filter(
      (key: string) => key in process.env,
    );
    expect(leaked).toEqual([]);
  });

  it("a child spawned with the default (inherited) environment sees none either", () => {
    const script = `
      const keys = ${JSON.stringify(REPO_LOCAL_GIT_ENV)};
      process.stdout.write(JSON.stringify(keys.filter((k) => k in process.env)));
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
    });

    expect(result.stdout).toBe("[]");
  });
});
