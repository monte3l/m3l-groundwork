// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrubGitEnv } from "./git-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "..", "..", "bin");

interface CiScopeLib {
  isDocsOnly(paths: string[]): boolean;
  docsOnlyFor(input: {
    eventName: string | undefined;
    baseSha: string | undefined;
    git: (args: string[]) => string;
    log?: (reason: string) => void;
  }): boolean;
}

const lib = (await import(
  pathToFileURL(join(binDir, "lib", "ci-scope.mjs")).href
)) as CiScopeLib;

describe("isDocsOnly", () => {
  it.each([
    [["docs/a.md"]],
    [["docs/deep/er/b.png"]],
    [["README.md"]],
    [["README.md", "CHANGELOG.md", "docs/x/y.md"]],
  ])("accepts %j", (paths) => {
    expect(lib.isDocsOnly(paths)).toBe(true);
  });

  it.each([
    [[]],
    [["templates/core/README.md"]],
    [["packages/cli/CHANGELOG.md"]],
    [["design/README.md"]],
    [[".claude/rules/x.md"]],
    [[".github/workflows/ci.yml"]],
    [["package.json"]],
    [["docs"]],
    [["docsx/a.md"]],
    [["docs-site/a.md"]],
    [["docs/../packages/cli/src/a.ts"]],
    [["../README.md"]],
    [["/docs/a.md"]],
    [["/README.md"]],
    [[""]],
    [["docs/a.md", ""]],
    [["docs/a.md", "packages/cli/src/a.ts"]],
    [["README.md", "package.json"]],
  ])("rejects %j", (paths) => {
    expect(lib.isDocsOnly(paths)).toBe(false);
  });
});

describe("docsOnlyFor", () => {
  const sha40 = "a".repeat(40);
  const sha64 = "B1".repeat(32);
  const fetchArgs = ["fetch", "--no-tags", "--depth=1", "origin", sha40];
  const diffArgs = ["diff", "--name-only", "--no-renames", "-z", sha40, "HEAD"];

  const gitReturning = (diffOut: string) =>
    vi.fn((args: string[]) => (args[0] === "diff" ? diffOut : ""));

  it("returns true for a docs-only PR and issues exactly fetch then diff", () => {
    const git = gitReturning("docs/a.md\0README.md\0");

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha40, git }),
    ).toBe(true);
    expect(git.mock.calls).toEqual([[fetchArgs], [diffArgs]]);
  });

  it("accepts output without a trailing NUL and a 64-char hex sha", () => {
    const git = gitReturning("docs/a.md");

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha64, git }),
    ).toBe(true);
    expect(git.mock.calls[0]?.[0]).toEqual([
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      sha64,
    ]);
    expect(git.mock.calls[1]?.[0]).toEqual([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      sha64,
      "HEAD",
    ]);
  });

  it("returns false when any changed path is code", () => {
    const git = gitReturning("docs/a.md\0packages/cli/src/a.ts\0");

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha40, git }),
    ).toBe(false);
  });

  it("keeps a path containing a newline intact (NUL-separated parsing)", () => {
    // Split on newline this would yield docs/a.md + src/x.ts (not docs-only);
    // split on NUL it is one path under docs/ (docs-only).
    const git = gitReturning("docs/a.md\nsrc/x.ts\0");

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha40, git }),
    ).toBe(true);
  });

  it.each(["push", "workflow_dispatch", "schedule", undefined])(
    "returns false without touching git for event %s",
    (eventName) => {
      const git = gitReturning("docs/a.md\0");

      expect(lib.docsOnlyFor({ eventName, baseSha: sha40, git })).toBe(false);
      expect(git).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "",
    "xyz",
    "g".repeat(40),
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
    "--upload-pack=x",
    `${sha40}\n`,
  ])("returns false without touching git for base sha %j", (baseSha) => {
    const git = gitReturning("docs/a.md\0");

    expect(lib.docsOnlyFor({ eventName: "pull_request", baseSha, git })).toBe(
      false,
    );
    expect(git).not.toHaveBeenCalled();
  });

  it("returns false and skips the diff when the fetch throws", () => {
    const git = vi.fn((_args: string[]): string => {
      throw new Error("fetch failed");
    });

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha40, git }),
    ).toBe(false);
    expect(git.mock.calls).toEqual([[fetchArgs]]);
  });

  it("returns false when the diff throws", () => {
    const git = vi.fn((args: string[]): string => {
      if (args[0] === "diff") throw new Error("diff failed");
      return "";
    });

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha40, git }),
    ).toBe(false);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it.each(["", "\0"])("returns false for empty diff output %j", (out) => {
    const git = gitReturning(out);

    expect(
      lib.docsOnlyFor({ eventName: "pull_request", baseSha: sha40, git }),
    ).toBe(false);
  });
});

describe("docsOnlyFor log", () => {
  const sha40 = "a".repeat(40);
  const gitReturning = (diffOut: string) =>
    vi.fn((args: string[]) => (args[0] === "diff" ? diffOut : ""));

  const reasonFor = (
    input: Partial<Parameters<CiScopeLib["docsOnlyFor"]>[0]>,
  ) => {
    const log = vi.fn<(reason: string) => void>();
    const result = lib.docsOnlyFor({
      eventName: "pull_request",
      baseSha: sha40,
      git: gitReturning("docs/a.md\0"),
      ...input,
      log,
    });
    expect(log).toHaveBeenCalledTimes(1);
    return { result, reason: log.mock.calls[0]?.[0] ?? "" };
  };

  it("explains a non-pull-request event, naming the event", () => {
    const { result, reason } = reasonFor({ eventName: "workflow_dispatch" });

    expect(result).toBe(false);
    expect(reason).toContain("not a pull request");
    expect(reason).toContain("workflow_dispatch");
  });

  it.each([undefined, "xyz"])(
    "explains a bad base sha %j as a base commit problem",
    (baseSha) => {
      const { result, reason } = reasonFor({ baseSha });

      expect(result).toBe(false);
      expect(reason).toContain("base commit");
    },
  );

  it("explains an empty diff", () => {
    const { result, reason } = reasonFor({ git: gitReturning("") });

    expect(result).toBe(false);
    expect(reason).toContain("empty diff");
  });

  it("explains a non-docs diff and names the offending path", () => {
    const { result, reason } = reasonFor({
      git: gitReturning("docs/a.md\0packages/cli/src/a.ts\0"),
    });

    expect(result).toBe(false);
    expect(reason).toContain("more than documentation");
    expect(reason).toContain("packages/cli/src/a.ts");
  });

  it("explains a docs-only diff", () => {
    const { result, reason } = reasonFor({
      git: gitReturning("docs/a.md\0README.md\0"),
    });

    expect(result).toBe(true);
    expect(reason).toContain("documentation only");
  });

  it.each(["fetch", "diff"])(
    "explains a throwing git %s with the first line of the message",
    (failing) => {
      const git = vi.fn((args: string[]): string => {
        if (args[0] === failing) throw new Error("kaput\nsecond line");
        return "";
      });
      const { result, reason } = reasonFor({ git });

      expect(result).toBe(false);
      expect(reason).toContain("could not list the changes");
      expect(reason).toContain("kaput");
      expect(reason).not.toContain("second line");
    },
  );

  it("survives git throwing a non-Error value and still logs a string", () => {
    const git = vi.fn((_args: string[]): string => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the unknown channel
      throw "boom";
    });
    const { result, reason } = reasonFor({ git });

    expect(result).toBe(false);
    expect(reason).toContain("could not list the changes");
    expect(reason).toContain("boom");
  });

  it("does not throw when log is omitted", () => {
    expect(
      lib.docsOnlyFor({
        eventName: "push",
        baseSha: undefined,
        git: gitReturning(""),
      }),
    ).toBe(false);
    expect(
      lib.docsOnlyFor({
        eventName: "pull_request",
        baseSha: sha40,
        git: gitReturning("docs/a.md\0"),
      }),
    ).toBe(true);
  });
});

describe("bin/ci-docs-only.mjs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-docs-only-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) => {
    const output = join(dir, "github-output");
    const result = spawnSync(
      process.execPath,
      [join(binDir, "ci-docs-only.mjs")],
      {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", GITHUB_OUTPUT: output, ...env },
      },
    );
    return { result, output };
  };

  it("writes docs_only=false for a push event", () => {
    const { result, output } = run({ EVENT_NAME: "push" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs_only=false");
    expect(readFileSync(output, "utf8")).toBe("docs_only=false\n");
  });

  it.each([
    ["unset", {}],
    ["garbage", { BASE_SHA: "not-a-sha" }],
  ])(
    "fails toward running (exit 0, false) for a pull_request with %s base sha",
    (_label, extra) => {
      const { result, output } = run({ EVENT_NAME: "pull_request", ...extra });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("docs_only=false");
      expect(readFileSync(output, "utf8")).toBe("docs_only=false\n");
    },
  );
});

describe("bin/ci-docs-only.mjs against real git", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-docs-only-git-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...extra,
    };
    scrubGitEnv(env);
    return env;
  };

  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: cleanEnv(),
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };

  const write = (repo: string, path: string, content: string) => {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  const commit = (repo: string, message: string) => {
    git(repo, "add", "-A");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-m", message);
  };

  /** Origin with a base commit, plus a clone of it to commit the PR into. */
  const fixture = () => {
    const origin = join(dir, "origin");
    const work = join(dir, "work");
    mkdirSync(origin);
    git(origin, "init", "-q");
    git(origin, "config", "user.name", "Test");
    git(origin, "config", "user.email", "test@example.com");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    write(origin, "src/a.ts", "export const a = 1;\n");
    write(origin, "README.md", "# base\n");
    commit(origin, "base");
    const baseSha = git(origin, "rev-parse", "HEAD");

    git(dir, "clone", "-q", origin, work);
    git(work, "config", "user.name", "Test");
    git(work, "config", "user.email", "test@example.com");
    return { work, baseSha };
  };

  const run = (work: string, baseSha: string) => {
    const output = join(dir, "github-output");
    const result = spawnSync(
      process.execPath,
      [join(binDir, "ci-docs-only.mjs")],
      {
        cwd: work,
        encoding: "utf8",
        env: cleanEnv({
          EVENT_NAME: "pull_request",
          BASE_SHA: baseSha,
          GITHUB_OUTPUT: output,
        }),
      },
    );
    return { result, output };
  };

  it("reports docs_only=true when the PR touches only docs/ and a root .md", () => {
    const { work, baseSha } = fixture();
    write(work, "docs/guide.md", "guide\n");
    write(work, "NOTES.md", "notes\n");
    commit(work, "docs");

    const { result, output } = run(work, baseSha);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs_only=true");
    expect(readFileSync(output, "utf8")).toBe("docs_only=true\n");
    expect(result.stderr).toContain("documentation only");
  });

  it("reports docs_only=false when the PR also touches code", () => {
    const { work, baseSha } = fixture();
    write(work, "docs/guide.md", "guide\n");
    write(work, "NOTES.md", "notes\n");
    write(work, "src/a.ts", "export const a = 2;\n");
    commit(work, "docs and code");

    const { result, output } = run(work, baseSha);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs_only=false");
    expect(readFileSync(output, "utf8")).toBe("docs_only=false\n");
    expect(result.stderr).toContain("more than documentation");
    expect(result.stderr).toContain("src/a.ts");
  });

  it("reports docs_only=false when code is renamed into docs/", () => {
    const { work, baseSha } = fixture();
    mkdirSync(join(work, "docs"));
    git(work, "mv", "src/a.ts", "docs/a.md");
    commit(work, "move code into docs");

    const { result, output } = run(work, baseSha);

    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("docs_only=false\n");
    expect(result.stderr).toContain("more than documentation");
    expect(result.stderr).toContain("src/a.ts");
  });
});
