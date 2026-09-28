// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Regression test for the baseline's PreToolUse guards under a symlinked path.
 * `import.meta.url` is symlink-resolved by Node's ESM loader but
 * `process.argv[1]` is not, so a guard that gates its body on comparing the two
 * never runs when the project sits under a symlinked directory (a symlinked
 * home or workspace on Linux, `/tmp` and `/var` on macOS) -- it exits 0, and
 * for a blocking hook exit 0 means "allow". Each case below runs a guard
 * through such a path with a payload it must block, and fails against the old
 * check. `templates/**` is excluded from this repo's vitest discovery, so the
 * hooks are run by path rather than imported.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Flips the case of every letter -- guaranteed to differ from the input
 * (as long as it contains at least one letter) while still denoting the
 * SAME path on a case-insensitive-but-case-preserving filesystem. */
function invertCase(value: string): string {
  return value
    .split("")
    .map((ch) =>
      ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
    )
    .join("");
}

/** True when this filesystem resolves a wrongly-cased spelling of a real,
 * existing path to the same file (macOS APFS by default). */
function isFilesystemCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "core-hooks-case-probe-"));
  try {
    const wrong = invertCase(probe);
    return wrong !== probe && existsSync(wrong);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const caseInsensitiveFs = isFilesystemCaseInsensitive();

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "core",
  ".claude",
  "hooks",
);

/**
 * The parent environment minus the variables git itself calls
 * repository-local (`git rev-parse --local-env-vars`: `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...). A git hook, or a session in a linked
 * worktree, can export an absolute `GIT_DIR`; a child that inherited it would
 * ignore its own `cwd` and run `git init` / `git commit` against the
 * developer's real repository instead of the fixture.
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

function run(
  script: string,
  payload: unknown,
): { status: number | null; stderr: string } {
  const result = spawnSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: envWithoutRepoLocals(),
  });
  return { status: result.status, stderr: result.stderr };
}

describe("baseline guards run through a symlinked hooks directory", () => {
  let scratch: string;
  let linkedHooks: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "core-hooks-symlink-"));
    linkedHooks = join(scratch, "linked-hooks");
    symlinkSync(hooksDir, linkedHooks, "dir");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("guard-no-commonjs still blocks a require() call", () => {
    const { status, stderr } = run(join(linkedHooks, "guard-no-commonjs.mjs"), {
      tool_name: "Write",
      tool_input: {
        file_path: join(scratch, "x.js"),
        content: 'const fs = require("fs");',
      },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("CommonJS");
  });

  it("guard-secret-writes still blocks writing a dotenv file", () => {
    const { status } = run(join(linkedHooks, "guard-secret-writes.mjs"), {
      tool_name: "Write",
      tool_input: { file_path: join(scratch, ".env"), content: "FOO=bar" },
    });
    expect(status).toBe(2);
  });

  /** Builds a throwaway repo on `main` and asks the guard, through the symlink, to allow a `src/` write. */
  function srcWriteOnMain(repoName: string): {
    status: number | null;
    stderr: string;
  } {
    const repo = join(scratch, repoName);
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...args: string[]): void => {
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
        { cwd: repo, encoding: "utf8", env: envWithoutRepoLocals() },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "init");

    return run(join(linkedHooks, "guard-branch-isolation.mjs"), {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "a.ts"), content: "" },
    });
  }

  it("guard-branch-isolation (which shells out to git) still blocks a src write on main", () => {
    const { status, stderr } = srcWriteOnMain("repo");
    expect(status).toBe(2);
    expect(stderr).toContain("main");
  });

  it("guard-branch-isolation still blocks a src write on main when the target directory does not exist yet", () => {
    // Deliberately does NOT pre-create src/newdir -- unlike srcWriteOnMain
    // above, which does create `src/`. `defaultGitFor` binds its git runner
    // to `dirname(resolve(filePath))`; when that directory doesn't exist,
    // every `git -C <dir> ...` call fails and returns "" (defaultGitFor's
    // catch), so `isMainOrDetachedOnMain` can't tell it's on `main` at all
    // and the hook currently falls through to allow (status 0) instead of
    // blocking.
    const repo = join(scratch, "repo-newdir");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]): void => {
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
        { cwd: repo, encoding: "utf8", env: envWithoutRepoLocals() },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "init");

    const { status, stderr } = run(
      join(linkedHooks, "guard-branch-isolation.mjs"),
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(repo, "src", "newdir", "a.ts"),
          content: "",
        },
      },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("main");
  });

  it.skipIf(!caseInsensitiveFs)(
    "guard-branch-isolation still blocks a src write on main when file_path is spelled with different case than the real repo directory",
    () => {
      // Same repo-on-main fixture as srcWriteOnMain (src/ IS pre-created),
      // but the hook is invoked with a wrongly-cased spelling of the repo's
      // real, canonical-case directory. `git rev-parse --show-toplevel`
      // still resolves to the CORRECT canonical case, but the hook's own
      // re-check (`isProtectedPath(scopedPath, worktreeRoot)`) resolves
      // `fileDir` with plain `realpathSync` (which does not correct case on
      // a case-insensitive filesystem), so the literal string prefix
      // comparison against the correctly-cased `worktreeRoot` fails and the
      // hook currently falls through to allow (status 0) instead of
      // blocking.
      const repo = join(scratch, "repo-case-mismatch");
      mkdirSync(join(repo, "src"), { recursive: true });
      const canonicalRepo = realpathSync.native(repo);
      const wronglyCasedRepo = invertCase(canonicalRepo);

      const git = (...args: string[]): void => {
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
          { cwd: repo, encoding: "utf8", env: envWithoutRepoLocals() },
        );
        expect(result.status, result.stderr).toBe(0);
      };
      git("init", "-b", "main");
      git("commit", "--allow-empty", "-m", "init");

      const { status, stderr } = run(
        join(linkedHooks, "guard-branch-isolation.mjs"),
        {
          tool_name: "Write",
          tool_input: {
            file_path: join(wronglyCasedRepo, "src", "a.ts"),
            content: "",
          },
        },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("main");
    },
  );

  it("is not fooled by an inherited GIT_DIR, and never touches the repository it points at", () => {
    // A decoy stands in for "the developer's real repo": if the fixture ever
    // ran git against the inherited GIT_DIR, the damage lands here, not there.
    const decoy = join(scratch, "decoy");
    mkdirSync(decoy);
    const init = spawnSync("git", ["init", "-b", "main"], {
      cwd: decoy,
      encoding: "utf8",
      env: envWithoutRepoLocals(),
    });
    expect(init.status, init.stderr).toBe(0);

    vi.stubEnv("GIT_DIR", join(decoy, ".git"));
    const { status, stderr } = srcWriteOnMain("repo-with-inherited-git-dir");
    expect(status).toBe(2);
    expect(stderr).toContain("main");

    const commits = spawnSync(
      "git",
      ["-C", decoy, "rev-list", "--all", "--count"],
      { encoding: "utf8", env: envWithoutRepoLocals() },
    );
    expect(commits.stdout.trim()).toBe("0");
  });
});

describe("post-edit-verify resolves the worktree root, not CLAUDE_PROJECT_DIR", () => {
  let scratch: string;
  let stubBinDir: string;
  let logFile: string;
  let symlinkParent: string | undefined;

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
   * Builds a real repo with a linked worktree, both `git worktree add`- and
   * scratch-fixture-created directories rooted under the same
   * `realpathSync`-resolved scratch dir so every path this test constructs
   * already shares the canonical prefix `git rev-parse --show-toplevel`
   * itself returns (macOS's `$TMPDIR` is a symlink into `/private`, and a
   * mismatch here would make the hook's own `dir.startsWith(root)` package
   * walk fail for reasons unrelated to what this test exists to prove).
   */
  function buildRepoWithWorktree(worktreeHasNodeModules: boolean): {
    repoRoot: string;
    worktreeDir: string;
    filePath: string;
  } {
    scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "post-edit-verify-worktree-")),
    );
    const repoRoot = join(scratch, "repo");
    mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "x", type: "module" }),
    );
    git(repoRoot, "init", "-b", "main");
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-m", "init");

    const worktreeDir = join(repoRoot, ".claude", "worktrees", "w");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    git(repoRoot, "worktree", "add", worktreeDir, "-b", "feat/w");

    if (worktreeHasNodeModules) {
      mkdirSync(join(worktreeDir, "node_modules"), { recursive: true });
    }
    writeFileSync(
      join(worktreeDir, "package.json"),
      JSON.stringify({ name: "x", type: "module" }),
    );
    mkdirSync(join(worktreeDir, "src"), { recursive: true });
    const filePath = join(worktreeDir, "src", "a.ts");
    writeFileSync(filePath, "export const a = 1;\n");

    return { repoRoot, worktreeDir, filePath };
  }

  /** Installs a stub `pnpm` on a scratch bin dir that logs `<cwd>\t<args>` to `logFile` and exits 0 without doing anything real. */
  function installStubPnpm(): void {
    stubBinDir = mkdtempSync(join(tmpdir(), "post-edit-verify-stub-bin-"));
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
    if (symlinkParent !== undefined) {
      rmSync(symlinkParent, { recursive: true, force: true });
      symlinkParent = undefined;
    }
  });

  it("runs its steps with cwd set to the linked worktree's root, not the original project root", () => {
    const { repoRoot, worktreeDir, filePath } = buildRepoWithWorktree(true);
    installStubPnpm();

    const result = spawnSync("node", [join(hooksDir, "post-edit-verify.mjs")], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: filePath },
        cwd: worktreeDir,
      }),
      encoding: "utf8",
      env: {
        ...envWithoutRepoLocals(),
        PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: repoRoot,
        STUB_LOG: logFile,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    const invocations = readFileSync(logFile, "utf8").trim().split("\n");
    expect(invocations.length).toBeGreaterThan(0);
    const cwds = invocations.map((line) => line.split("\t")[0]);
    expect(cwds).toContain(worktreeDir);
    expect(cwds).not.toContain(repoRoot);
  });

  it("skips with a node_modules hint on stderr, and never spawns a step, when the worktree has no dependencies installed", () => {
    const { repoRoot, worktreeDir, filePath } = buildRepoWithWorktree(false);
    installStubPnpm();

    const result = spawnSync("node", [join(hooksDir, "post-edit-verify.mjs")], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: filePath },
        cwd: worktreeDir,
      }),
      encoding: "utf8",
      env: {
        ...envWithoutRepoLocals(),
        PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: repoRoot,
        STUB_LOG: logFile,
      },
    });

    // The hook now exits 2 (not 0) here -- see the module's own header
    // comment: "On any failure it exits 2 with a concise stderr summary,
    // which Claude Code surfaces back to the model as advisory feedback."
    // stderr on exit 0 is not reliably surfaced to the model; missing
    // dependencies is actionable feedback worth surfacing the same way a
    // real check failure is.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("node_modules");
    expect(existsSync(logFile)).toBe(false);
  });

  it("checks the owning package's own node_modules, not a git-toplevel ancestor that lacks one, when the project is nested inside a larger repo", () => {
    // The repo ROOT here deliberately has no package.json/node_modules of its
    // own -- only the nested-project/ subdirectory does. Before the fix, the
    // hook checked `<git-toplevel>/node_modules`, which would wrongly skip
    // this edit even though the actual owning package has its dependencies
    // installed.
    scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "post-edit-verify-nested-")),
    );
    const repoRoot = join(scratch, "outer-repo");
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-b", "main");

    const nestedDir = join(repoRoot, "nested-project");
    mkdirSync(join(nestedDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(nestedDir, "package.json"),
      JSON.stringify({ name: "nested", type: "module" }),
    );
    mkdirSync(join(nestedDir, "src"), { recursive: true });
    const filePath = join(nestedDir, "src", "a.ts");
    writeFileSync(filePath, "export const a = 1;\n");

    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-m", "init");

    installStubPnpm();

    const result = spawnSync("node", [join(hooksDir, "post-edit-verify.mjs")], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: filePath },
        cwd: nestedDir,
      }),
      encoding: "utf8",
      env: {
        ...envWithoutRepoLocals(),
        PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: repoRoot,
        STUB_LOG: logFile,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("node_modules");
    expect(existsSync(logFile)).toBe(true);
  });

  // End-to-end proof that the hook's own entry-point body -- not just the
  // library-level `canonicalize`/`resolveVerifyRoot` composition tested in
  // post-edit-verify.test.ts -- actually canonicalizes the edited file's
  // path before comparing it against the (always-canonical)
  // `git rev-parse --show-toplevel` root. Removing `canonicalize(...)` from
  // around `abs` in the hook's body would make `rel` start with a bogus
  // `..` here (the symlinked directory segment never appears in the
  // canonical root), which the hook's own `rel.startsWith("..")` guard
  // treats as "outside the project" and silently skips -- the exact
  // symlink regression this fixes. A silent skip means no `pnpm`
  // invocation at all, so an empty `logFile` (or a missing one) is what a
  // regressed hook would produce here.
  it("resolves a file reached through a SYMLINKED project path, not the canonical one, and actually runs its steps (symlink regression, end-to-end)", () => {
    scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "post-edit-verify-symlink-")),
    );
    const repoRoot = join(scratch, "repo");
    mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "x", type: "module" }),
    );
    git(repoRoot, "init", "-b", "main");
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-m", "init");

    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "a.ts"), "export const a = 1;\n");

    // A dedicated symlink hop, not a reliance on the host's own /tmp being a
    // symlink (macOS's is; Linux's typically isn't) -- reproduces the bug
    // class host-independently, same approach as the library-level
    // regression test in post-edit-verify.test.ts.
    symlinkParent = mkdtempSync(
      join(tmpdir(), "post-edit-verify-symlink-parent-"),
    );
    const symlinkedRepo = join(symlinkParent, "repo-link");
    symlinkSync(repoRoot, symlinkedRepo, "dir");
    const symlinkedFile = join(symlinkedRepo, "src", "a.ts");

    installStubPnpm();

    const result = spawnSync("node", [join(hooksDir, "post-edit-verify.mjs")], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: symlinkedFile },
        cwd: symlinkedRepo,
      }),
      encoding: "utf8",
      env: {
        ...envWithoutRepoLocals(),
        PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: symlinkedRepo,
        STUB_LOG: logFile,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    const invocations = readFileSync(logFile, "utf8").trim().split("\n");
    expect(invocations.length).toBeGreaterThan(0);
    const cwds = invocations.map((line) => line.split("\t")[0]);
    expect(cwds).toContain(repoRoot);
  });
});

describe("no shipped script compares process.argv[1] to import.meta.url directly", () => {
  // The behavioural tests above cover a sample; this sweep is what stops the
  // next hook, gate or pack script from reintroducing the fail-open check.
  const templatesDir = join(here, "..", "..", "..", "templates");

  function scripts(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" ? [] : scripts(path);
      }
      return entry.name.endsWith(".mjs") ? [path] : [];
    });
  }

  const files = scripts(templatesDir).filter((path) =>
    readFileSync(path, "utf8").includes("process.argv[1]"),
  );

  it("finds the scripts it is meant to police", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((path) => [relative(templatesDir, path), path]))(
    "%s resolves argv[1] with realpathSync",
    (_name, path) => {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /process\.argv\[1\]\s*===\s*fileURLToPath\(import\.meta\.url\)/,
      );
      expect(source).toContain("realpathSync(process.argv[1])");
    },
  );
});
