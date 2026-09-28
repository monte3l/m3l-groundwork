// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `resolveVerifyRoot`/`defaultGitFor` regression tests for
 * `.claude/hooks/post-edit-verify.mjs`'s worktree-correctness fix: given the
 * absolute path of an edited file, `resolveVerifyRoot` must resolve the git
 * working-tree root that ACTUALLY contains it (the linked worktree's own
 * root when the file lives inside one, not the main checkout) rather than
 * trusting `CLAUDE_PROJECT_DIR`, which stays pinned to the session's
 * original project root even after a worktree switch (see the module's own
 * header comment and code.claude.com/docs/en/worktrees, "Hook paths don't
 * follow the worktree").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// Plain ESM under .claude/hooks/, outside every tsconfig -- loaded by URL
// (see protected-paths.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, ".claude", "hooks", "post-edit-verify.mjs")).href
)) as {
  defaultGitFor: (dir: string) => (args: string[]) => string;
  resolveVerifyRoot: (
    absFile: string,
    fallback: string,
    gitFactory?: (dir: string) => (args: string[]) => string,
  ) => string;
};

// `canonicalize` is the fix under test for the symlink regression below --
// same dynamic-import-by-URL pattern as `lib` above (see
// protected-paths.test.ts, which imports this same module the same way).
const protectedPathsLib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "protected-paths.mjs")).href
)) as {
  canonicalize: (path: string) => string;
};

/**
 * The parent environment minus the variables git itself calls
 * repository-local (`git rev-parse --local-env-vars`), so a session already
 * running inside a linked worktree can't leak its own `GIT_DIR` into the
 * fixture repos this file creates. Same helper as `core-hooks.test.ts`.
 */
function envWithoutRepoLocals(): NodeJS.ProcessEnv {
  const listed = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  });
  const local = new Set(
    listed.status === 0
      ? listed.stdout.split("\n").filter(Boolean)
      : ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"],
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !local.has(name)),
  );
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: envWithoutRepoLocals() },
  );
  expect(result.status, result.stderr).toBe(0);
}

// The names `envWithoutRepoLocals()` filters out -- computed once, up front,
// via the same `git rev-parse --local-env-vars` probe (with the same
// hardcoded fallback) so both the fixture-building `git()` helper above and
// the global stripping below agree on exactly the same set.
const REPO_LOCAL_GIT_ENV_VARS: string[] = (() => {
  const listed = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  });
  return listed.status === 0
    ? listed.stdout.split("\n").filter(Boolean)
    : ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
})();

let savedRepoLocalGitEnv: Array<[string, string | undefined]> = [];

/**
 * `lib.resolveVerifyRoot`/`lib.defaultGitFor` shell out to real `git` via
 * `execFileSync` with no explicit `env` -- unlike this file's own
 * fixture-building `git()` helper above, they inherit the test process's
 * OWN ambient `process.env` implicitly, since neither function accepts an
 * env parameter. `vi.stubEnv` can only ever SET a string value, never
 * delete a key, so it can't express "unset" -- a manual save/strip/restore
 * of `process.env` itself is the simplest way to guarantee these variables
 * are actually absent (not just overwritten with an empty string, which
 * `git` could itself interpret as a real override) for the duration of
 * every test in this file, protecting the library calls under test the same
 * way `envWithoutRepoLocals()` already protects this file's own fixture
 * `git init`/`git commit` calls.
 */
beforeEach(() => {
  savedRepoLocalGitEnv = REPO_LOCAL_GIT_ENV_VARS.map(
    (name) => [name, process.env[name]] as [string, string | undefined],
  );
  for (const name of REPO_LOCAL_GIT_ENV_VARS) {
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of savedRepoLocalGitEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("resolveVerifyRoot", () => {
  let scratch: string;

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("resolves to the main checkout's own root for a file inside it", () => {
    scratch = mkdtempSync(join(tmpdir(), "resolve-verify-root-main-"));
    git(scratch, "init", "-b", "main");
    git(scratch, "commit", "--allow-empty", "-m", "init");
    mkdirSync(join(scratch, "src"), { recursive: true });
    const file = join(scratch, "src", "a.ts");
    writeFileSync(file, "");

    const expectedRoot = realpathSync(scratch);
    const result = lib.resolveVerifyRoot(file, "fallback");

    expect(realpathSync(result)).toBe(expectedRoot);
  });

  it("resolves to the LINKED WORKTREE's own root for a file inside it, not the main checkout", () => {
    scratch = mkdtempSync(join(tmpdir(), "resolve-verify-root-worktree-"));
    git(scratch, "init", "-b", "main");
    git(scratch, "commit", "--allow-empty", "-m", "init");
    const worktreeDir = join(scratch, ".claude", "worktrees", "x");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    git(scratch, "worktree", "add", worktreeDir, "-b", "feat/x");

    mkdirSync(join(worktreeDir, "src"), { recursive: true });
    const file = join(worktreeDir, "src", "a.ts");
    writeFileSync(file, "");

    const mainRoot = realpathSync(scratch);
    const expectedWorktreeRoot = realpathSync(worktreeDir);
    const result = lib.resolveVerifyRoot(file, "fallback");

    expect(realpathSync(result)).toBe(expectedWorktreeRoot);
    expect(realpathSync(result)).not.toBe(mainRoot);
    expect(result).not.toBe("fallback");
  });

  it("still resolves to the repo root when the target's own directory does not exist yet (climbs to nearest existing ancestor)", () => {
    scratch = mkdtempSync(join(tmpdir(), "resolve-verify-root-newdir-"));
    git(scratch, "init", "-b", "main");
    git(scratch, "commit", "--allow-empty", "-m", "init");
    // Deliberately does NOT create src/newdir/ -- resolveVerifyRoot must
    // climb up to `scratch` itself (the nearest existing ancestor) before
    // shelling out, the same way `guard-branch-isolation.mjs` does.
    const file = join(scratch, "src", "newdir", "a.ts");

    const expectedRoot = realpathSync(scratch);
    const result = lib.resolveVerifyRoot(file, "fallback");

    expect(realpathSync(result)).toBe(expectedRoot);
  });

  it("returns the fallback when the file is outside any git repository", () => {
    scratch = mkdtempSync(join(tmpdir(), "resolve-verify-root-no-git-"));
    const file = join(scratch, "a.ts");
    writeFileSync(file, "");

    const result = lib.resolveVerifyRoot(file, "the-fallback-value");

    expect(result).toBe("the-fallback-value");
  });
});

describe("defaultGitFor", () => {
  let scratch: string;

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("returns trimmed stdout for a real repository", () => {
    scratch = mkdtempSync(join(tmpdir(), "default-git-for-real-"));
    git(scratch, "init", "-b", "main");
    git(scratch, "commit", "--allow-empty", "-m", "init");

    const result = lib.defaultGitFor(scratch)(["rev-parse", "--show-toplevel"]);

    expect(result).toBe(realpathSync(scratch));
  });

  it("returns an empty string, not a throw, for a non-repository directory", () => {
    scratch = mkdtempSync(join(tmpdir(), "default-git-for-non-repo-"));

    expect(() =>
      lib.defaultGitFor(scratch)(["rev-parse", "--show-toplevel"]),
    ).not.toThrow();
    expect(lib.defaultGitFor(scratch)(["rev-parse", "--show-toplevel"])).toBe(
      "",
    );
  });
});

describe("resolveVerifyRoot + canonicalize (symlinked project path regression)", () => {
  let scratch: string;
  let symlinkParent: string;

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(symlinkParent, { recursive: true, force: true });
  });

  // Symlink creation needs elevated privilege/Developer Mode on Windows;
  // this test also deliberately creates its own symlink (rather than
  // relying on `/tmp` happening to be one, as macOS's is) so it reproduces
  // the bug class host-independently.
  it.skipIf(process.platform === "win32")(
    "recognizes a file reached through a symlinked directory as inside the resolved root, once canonicalized",
    () => {
      scratch = mkdtempSync(join(tmpdir(), "resolve-verify-root-real-"));
      git(scratch, "init", "-b", "main");
      git(scratch, "commit", "--allow-empty", "-m", "init");
      mkdirSync(join(scratch, "src"), { recursive: true });
      writeFileSync(join(scratch, "src", "a.ts"), "");

      symlinkParent = mkdtempSync(join(tmpdir(), "resolve-verify-root-link-"));
      const symlinkedRepo = join(symlinkParent, "repo-link");
      symlinkSync(scratch, symlinkedRepo, "dir");
      const symlinkedFile = join(symlinkedRepo, "src", "a.ts");

      // The fix under test: canonicalize() resolves the symlink component so
      // the file's path takes the same already-canonical form
      // `git rev-parse --show-toplevel` itself always returns.
      const canonicalAbs = protectedPathsLib.canonicalize(symlinkedFile);
      expect(canonicalAbs).toBe(realpathSync(join(scratch, "src", "a.ts")));

      const root = lib.resolveVerifyRoot(canonicalAbs, "fallback");
      expect(root).not.toBe("fallback");
      expect(realpathSync(root)).toBe(realpathSync(scratch));

      const rel = relative(root, canonicalAbs).split(sep).join("/");
      expect(rel.startsWith("..")).toBe(false);
      expect(rel).toBe("src/a.ts");

      // Discriminates the fix: computing the same relative path from the
      // RAW, un-canonicalized symlinked path against the (already-canonical)
      // resolved root DOES produce a bogus leading ".." -- the exact
      // silent-skip failure mode the `canonicalize(abs)` fix in the hook's
      // entry-point body closes.
      const relWithoutFix = relative(root, symlinkedFile).split(sep).join("/");
      expect(relWithoutFix.startsWith("..")).toBe(true);
    },
  );
});

describe("post-edit-verify (root hook) resolves depsDir via pkgDir ?? root for a plain .mjs file", () => {
  // Unlike templates/core's twin (always the full TS battery), the root
  // hook's own `.claude/hooks/post-edit-verify.mjs` has a second,
  // structurally different path for a plain `.mjs`/`.js` file outside any
  // packages/*/src|tests tsconfig project: format+lint only, with
  // `depsDir = pkgDir ?? root` since `pkgDir` is never computed
  // (`runsFullBattery` is false) for this shape. Neither branch is
  // exercised end-to-end anywhere else -- these tests spawn the real root
  // hook script, not just its exported pure functions.
  const rootHookPath = join(
    repoRoot,
    ".claude",
    "hooks",
    "post-edit-verify.mjs",
  );

  let scratch: string;
  let stubBinDir: string;
  let logFile: string;

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8", env: envWithoutRepoLocals() },
    );
    expect(result.status, result.stderr).toBe(0);
  }

  /**
   * A git repo with `package.json`/`node_modules` at its ROOT and a plain
   * `.mjs` file nested under `scripts/` -- deliberately NOT under `src/` or
   * `tests/` (so `isProtectedPath`/`runsFullBattery` is false) and
   * deliberately given no `node_modules` of its own (so a hook that
   * mistakenly checked `dirname(abs)` instead of falling back to `root`
   * would be caught failing the dependency check here).
   */
  function buildRepo(): { repoRoot: string; scriptPath: string } {
    scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "post-edit-verify-root-hook-")),
    );
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "x", type: "module" }),
    );
    git(repo, "init", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");

    mkdirSync(join(repo, "scripts"), { recursive: true });
    const scriptPath = join(repo, "scripts", "some-script.mjs");
    writeFileSync(scriptPath, "export const x = 1;\n");

    return { repoRoot: repo, scriptPath };
  }

  /** Same stub shape as core-hooks.test.ts's `installStubPnpm`: logs `<cwd>\t<args>` and exits 0. */
  function installStubPnpm(): void {
    stubBinDir = mkdtempSync(
      join(tmpdir(), "post-edit-verify-root-hook-stub-bin-"),
    );
    logFile = join(scratch, "stub.log");
    const stubPath = join(stubBinDir, "pnpm");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        'import process from "node:process";',
        "appendFileSync(",
        "  process.env.STUB_LOG,",
        '  `${process.cwd()}\\t${process.argv.slice(2).join(" ")}\\n`,',
        ");",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);
  }

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(stubBinDir, { recursive: true, force: true });
  });

  it("runs only the format+lint path (never typecheck/vitest) with depsDir resolved to the repo root", () => {
    const { repoRoot: repo, scriptPath } = buildRepo();
    installStubPnpm();

    const result = spawnSync("node", [rootHookPath], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: scriptPath },
        cwd: repo,
      }),
      encoding: "utf8",
      env: {
        ...envWithoutRepoLocals(),
        PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: repo,
        STUB_LOG: logFile,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    const invocations = readFileSync(logFile, "utf8").trim().split("\n");
    expect(invocations.length).toBe(2);
    const argLines = invocations.map((line) => line.split("\t")[1] ?? "");
    expect(argLines.some((a) => a.includes("prettier"))).toBe(true);
    expect(argLines.some((a) => a.includes("eslint"))).toBe(true);
    expect(argLines.some((a) => a.includes("tsc"))).toBe(false);
    expect(argLines.some((a) => a.includes("vitest"))).toBe(false);
    const cwds = invocations.map((line) => line.split("\t")[0]);
    expect(cwds.every((cwd) => cwd === repo)).toBe(true);
  });

  it("exits 2 naming the repo root (not some other path) as the missing node_modules dir", () => {
    const { repoRoot: repo, scriptPath } = buildRepo();
    rmSync(join(repo, "node_modules"), { recursive: true, force: true });
    installStubPnpm();

    const result = spawnSync("node", [rootHookPath], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: scriptPath },
        cwd: repo,
      }),
      encoding: "utf8",
      env: {
        ...envWithoutRepoLocals(),
        PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: repo,
        STUB_LOG: logFile,
      },
    });

    expect(result.status).toBe(2);
    // The exact backtick-quoted path in the message must be the repo root
    // itself, not merely a string that happens to CONTAIN the repo root --
    // `<repo>/scripts` (the edited file's own directory, the wrong fallback
    // this test guards against) would also pass a plain `toContain(repo)`
    // check, since it has `repo` as a path prefix.
    const match = /no node_modules under `([^`]+)`/.exec(result.stderr);
    expect(match?.[1]).toBe(repo);
    expect(existsSync(logFile)).toBe(false);
  });
});

describe("post-edit-verify entry-point guard", () => {
  it("importing the module for its exports does not hang on stdin or spawn anything", () => {
    // If `isEntryPoint()` incorrectly resolved to true under vitest's own
    // runner, the side-effecting body would try to read stdin (which never
    // ends in this test process) and this test would time out rather than
    // fail cleanly -- so simply reaching this assertion is the proof.
    expect(typeof lib.resolveVerifyRoot).toBe("function");
    expect(typeof lib.defaultGitFor).toBe("function");
  });
});
