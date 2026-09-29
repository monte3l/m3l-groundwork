// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the worktrees pack's two hooks
 * (`templates/packs/worktrees/files/.claude/hooks/{guard-worktree-only,
 * ensure-worktree-deps}.mjs`), both plain ESM outside every tsconfig project
 * -- loaded by URL, same pattern as `protected-paths.test.ts`.
 *
 * BOTH hooks import `../../bin/lib/protected-paths.mjs` RELATIVE TO THEIR
 * OWN FILE LOCATION. Under `templates/packs/worktrees/files/.claude/hooks/`,
 * that resolves to `templates/packs/worktrees/files/bin/lib/protected-paths.mjs`,
 * which does not exist (there is no `bin/` directory under the pack's
 * `files/` tree -- confirmed by attempting a plain import directly, which
 * fails with `ERR_MODULE_NOT_FOUND` for `protected-paths.mjs`). So this file
 * copies each hook alongside a real copy of
 * `templates/core/bin/lib/protected-paths.mjs` (the same file a real
 * emitted project's `requires.paths` resolves against -- NOT this repo's own
 * root copy at `bin/lib/protected-paths.mjs`, which happens to be
 * byte-identical today save for header comments but is not the file the
 * pack actually ships against) into its own `mkdtemp` fixture shaped like an
 * emitted project (`<fixture>/.claude/hooks/<hook>.mjs` +
 * `<fixture>/bin/lib/protected-paths.mjs`, the same relative shape the pack
 * installs into a real project) and imports the COPY by its `pathToFileURL`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const worktreesPackHooksDir = join(
  repoRoot,
  "templates",
  "packs",
  "worktrees",
  "files",
  ".claude",
  "hooks",
);
const protectedPathsSource = join(
  repoRoot,
  "templates",
  "core",
  "bin",
  "lib",
  "protected-paths.mjs",
);

/**
 * The parent environment minus the variables git itself calls
 * repository-local -- same helper as `core-hooks.test.ts`'s
 * `envWithoutRepoLocals`, copied here rather than shared since neither file
 * exports it.
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

/** Initializes a fresh repo at `dir` on `main` with one empty commit. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "commit", "--allow-empty", "-m", "init");
}

describe("guard-worktree-only", () => {
  let fixtureRoot: string;
  let hookModule: {
    defaultGitFor: (dir: string) => (args: string[]) => string;
    shouldBlock: (
      filePath: string,
      git: (args: string[]) => string,
      boundDir: string,
    ) => boolean;
  };
  const scratchDirs: string[] = [];

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "guard-worktree-only-fixture-"));
    mkdirSync(join(fixtureRoot, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(fixtureRoot, "bin", "lib"), { recursive: true });
    copyFileSync(
      join(worktreesPackHooksDir, "guard-worktree-only.mjs"),
      join(fixtureRoot, ".claude", "hooks", "guard-worktree-only.mjs"),
    );
    copyFileSync(
      protectedPathsSource,
      join(fixtureRoot, "bin", "lib", "protected-paths.mjs"),
    );
    hookModule = (await import(
      pathToFileURL(
        join(fixtureRoot, ".claude", "hooks", "guard-worktree-only.mjs"),
      ).href
    )) as typeof hookModule;
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a protected-path write in the main checkout itself", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-main-"));
    scratchDirs.push(scratch);
    initRepo(scratch);
    const gitRunner = hookModule.defaultGitFor(scratch);
    expect(
      hookModule.shouldBlock(join(scratch, "src", "a.ts"), gitRunner, scratch),
    ).toBe(true);
  });

  it("allows a protected-path write inside an in-repo linked worktree under .claude/worktrees/<name>/", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-in-repo-"));
    scratchDirs.push(scratch);
    initRepo(scratch);
    const worktreeDir = join(scratch, ".claude", "worktrees", "w");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    git(scratch, "worktree", "add", worktreeDir, "-b", "feat/w");

    const gitRunner = hookModule.defaultGitFor(worktreeDir);
    expect(
      hookModule.shouldBlock(
        join(worktreeDir, "src", "a.ts"),
        gitRunner,
        worktreeDir,
      ),
    ).toBe(false);
  });

  it("blocks a protected-path write in a SIBLING worktree created outside .claude/worktrees/ (the gap protected-paths.test.ts documents this pack closes) -- placed in a genuinely EXTERNAL directory, not nested under the main repo root, so this discriminates toplevel-scoping from mainRepoRoot-scoping (see shouldBlock's own comment)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-sibling-"));
    scratchDirs.push(scratch);
    initRepo(scratch);
    // Deliberately NOT `join(scratch, "sibling-worktree")` -- a worktree
    // nested under the main repo's own root is still a path-prefix CHILD of
    // `mainRepoRoot`, which would make this test pass identically whether
    // `isProtectedPath` is scoped to `toplevel` or to `mainRepoRoot`,
    // proving nothing about which one is correct. A real `git worktree add
    // ../foo` puts the new worktree in a SIBLING directory, outside the main
    // repo's own tree entirely -- reproduced here with an unrelated mkdtemp
    // directory so `mainRepoRoot`-scoping and `toplevel`-scoping actually
    // diverge for this file path.
    const siblingWorktreeDir = mkdtempSync(
      join(tmpdir(), "guard-wt-sibling-external-"),
    );
    scratchDirs.push(siblingWorktreeDir);
    git(scratch, "worktree", "add", siblingWorktreeDir, "-b", "feat/sibling");

    // git is bound to the sibling worktree's OWN root directory (which
    // exists), not a nonexistent nested subdirectory, so `git -C <dir>`
    // succeeds.
    const gitRunner = hookModule.defaultGitFor(siblingWorktreeDir);
    expect(
      hookModule.shouldBlock(
        join(siblingWorktreeDir, "src", "a.ts"),
        gitRunner,
        siblingWorktreeDir,
      ),
    ).toBe(true);
  });

  it("allows a write to a path in a completely unrelated repo whose absolute path happens to contain a literal /src/ segment ABOVE its own root (the unscoped isProtectedPath regression: the pre-fix code called isProtectedPath(filePath) bare, matching the literal substring /src/ anywhere in the absolute path, not just inside the repo)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-substr-"));
    scratchDirs.push(scratch);
    // The repo root itself lives at <scratch>/src/other-project -- "src" is
    // a path segment ABOVE the repo root, not inside it. The repo's only
    // commit is the empty "init" commit from initRepo: no real src/ or
    // tests/ directory exists inside the repo itself.
    const repoRoot = join(scratch, "src", "other-project");
    initRepo(repoRoot);

    const gitRunner = hookModule.defaultGitFor(repoRoot);
    expect(
      hookModule.shouldBlock(join(repoRoot, "README.md"), gitRunner, repoRoot),
    ).toBe(false);
  });

  it("still blocks a REAL src/ file inside that same /src/-containing-path repo, proving the fix didn't overcorrect into never blocking anything in a repo whose own path happens to contain /src/", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-substr-real-"));
    scratchDirs.push(scratch);
    const repoRoot = join(scratch, "src", "other-project");
    initRepo(repoRoot);

    const gitRunner = hookModule.defaultGitFor(repoRoot);
    expect(
      hookModule.shouldBlock(
        join(repoRoot, "src", "real.ts"),
        gitRunner,
        repoRoot,
      ),
    ).toBe(true);
  });

  it("allows a write to a non-protected path in the main checkout", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-nonprotected-"));
    scratchDirs.push(scratch);
    initRepo(scratch);
    const gitRunner = hookModule.defaultGitFor(scratch);
    expect(
      hookModule.shouldBlock(join(scratch, "README.md"), gitRunner, scratch),
    ).toBe(false);
  });

  it("allows any path in a plain, non-git temp directory -- can't determine, fail open", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-nongit-"));
    scratchDirs.push(scratch);
    const gitRunner = hookModule.defaultGitFor(scratch);
    expect(
      hookModule.shouldBlock(join(scratch, "src", "a.ts"), gitRunner, scratch),
    ).toBe(false);
  });

  it("still allows a protected-path write under a brand-new nested directory that doesn't exist yet inside a sanctioned worktree, proving the caller's climb-to-nearest-existing-ancestor pattern works through shouldBlock", () => {
    const scratch = mkdtempSync(join(tmpdir(), "guard-wt-newdir-"));
    scratchDirs.push(scratch);
    initRepo(scratch);
    const worktreeDir = join(scratch, ".claude", "worktrees", "w");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    git(scratch, "worktree", "add", worktreeDir, "-b", "feat/w");

    // src/newdir/ is deliberately never created -- mirrors the production
    // entry point's own climb: bind git to the nearest EXISTING ancestor of
    // the write target (here, the worktree root itself) rather than the
    // (nonexistent) file's own directory.
    const filePath = join(worktreeDir, "src", "newdir", "a.ts");
    expect(existsSync(join(worktreeDir, "src", "newdir"))).toBe(false);

    const gitRunner = hookModule.defaultGitFor(worktreeDir);
    expect(hookModule.shouldBlock(filePath, gitRunner, worktreeDir)).toBe(
      false,
    );
  });
});

describe("ensure-worktree-deps", () => {
  let hookModule: {
    defaultGitFor: (dir: string) => (args: string[]) => string;
    isLinkedWorktree: (
      dir: string,
      gitFactory?: (dir: string) => (args: string[]) => string,
    ) => boolean;
    needsInstall: (root: string) => boolean;
    installIfNeeded: (root: string) => {
      installed: boolean;
      message: string;
    };
    gitDirFor: (
      root: string,
      gitFactory?: (dir: string) => (args: string[]) => string,
    ) => string;
  };
  const scratchDirs: string[] = [];
  let stubBinDir: string | undefined;
  let originalPath: string | undefined;
  let originalStubLog: string | undefined;
  let stubLogTouched = false;
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "ensure-worktree-deps-fixture-"));
    mkdirSync(join(fixtureRoot, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(fixtureRoot, "bin", "lib"), { recursive: true });
    copyFileSync(
      join(worktreesPackHooksDir, "ensure-worktree-deps.mjs"),
      join(fixtureRoot, ".claude", "hooks", "ensure-worktree-deps.mjs"),
    );
    copyFileSync(
      protectedPathsSource,
      join(fixtureRoot, "bin", "lib", "protected-paths.mjs"),
    );
    hookModule = (await import(
      pathToFileURL(
        join(fixtureRoot, ".claude", "hooks", "ensure-worktree-deps.mjs"),
      ).href
    )) as typeof hookModule;
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (stubBinDir !== undefined) {
      rmSync(stubBinDir, { recursive: true, force: true });
      stubBinDir = undefined;
    }
    if (originalPath !== undefined) {
      process.env["PATH"] = originalPath;
      originalPath = undefined;
    }
    // installStubPnpm sets process.env.STUB_LOG globally with no restore of
    // its own -- undo that here so one test's stub-log path can't leak into
    // the next test that doesn't call installStubPnpm at all.
    if (stubLogTouched) {
      if (originalStubLog === undefined) {
        delete process.env["STUB_LOG"];
      } else {
        process.env["STUB_LOG"] = originalStubLog;
      }
      stubLogTouched = false;
      originalStubLog = undefined;
    }
  });

  /** Installs a stub `pnpm` on a scratch bin dir that logs `<cwd>\t<args>` to `logFile` and exits 0 -- same pattern as `core-hooks.test.ts`'s `installStubPnpm`. */
  function installStubPnpm(logFile: string): void {
    stubBinDir = mkdtempSync(join(tmpdir(), "ensure-worktree-deps-stub-bin-"));
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
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${stubBinDir}:${originalPath ?? ""}`;
    process.env["STUB_LOG"] = logFile;
  }

  /** Builds a repo with a linked worktree under .claude/worktrees/w, returning both roots. */
  function buildRepoWithWorktree(): {
    repoRoot: string;
    worktreeDir: string;
  } {
    // realpathSync-resolved: macOS's $TMPDIR is a symlink into /private, and
    // the stub pnpm's own process.cwd() always resolves through it -- an
    // un-resolved scratch dir would make the cwd assertion below compare a
    // symlinked path against its canonical form.
    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "ensure-worktree-deps-repo-")),
    );
    scratchDirs.push(scratch);
    const repoRoot2 = join(scratch, "repo");
    initRepo(repoRoot2);
    const worktreeDir = join(repoRoot2, ".claude", "worktrees", "w");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    git(repoRoot2, "worktree", "add", worktreeDir, "-b", "feat/w");
    return { repoRoot: repoRoot2, worktreeDir };
  }

  describe("isLinkedWorktree", () => {
    it("is true for a linked worktree's root", () => {
      const { worktreeDir } = buildRepoWithWorktree();
      expect(hookModule.isLinkedWorktree(worktreeDir)).toBe(true);
    });

    it("is false for the main checkout's root", () => {
      const { repoRoot: mainRoot } = buildRepoWithWorktree();
      expect(hookModule.isLinkedWorktree(mainRoot)).toBe(false);
    });

    it("is false for a non-git directory", () => {
      const scratch = mkdtempSync(
        join(tmpdir(), "ensure-worktree-deps-nongit-"),
      );
      scratchDirs.push(scratch);
      expect(hookModule.isLinkedWorktree(scratch)).toBe(false);
    });
  });

  describe("needsInstall", () => {
    it("is true when pnpm-lock.yaml exists and node_modules/.modules.yaml is absent", () => {
      const root = mkdtempSync(join(tmpdir(), "needs-install-true-"));
      scratchDirs.push(root);
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      expect(hookModule.needsInstall(root)).toBe(true);
    });

    it("is false when node_modules/.modules.yaml already exists", () => {
      const root = mkdtempSync(join(tmpdir(), "needs-install-marker-"));
      scratchDirs.push(root);
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "node_modules", ".modules.yaml"), "x: 1\n");
      expect(hookModule.needsInstall(root)).toBe(false);
    });

    it("is false when node_modules exists but IS a symlink", () => {
      const root = mkdtempSync(join(tmpdir(), "needs-install-symlink-"));
      scratchDirs.push(root);
      const realNodeModules = mkdtempSync(
        join(tmpdir(), "needs-install-symlink-target-"),
      );
      scratchDirs.push(realNodeModules);
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      symlinkSync(realNodeModules, join(root, "node_modules"), "dir");
      expect(hookModule.needsInstall(root)).toBe(false);
    });

    it("is false when there is no pnpm-lock.yaml at all", () => {
      const root = mkdtempSync(join(tmpdir(), "needs-install-no-lock-"));
      scratchDirs.push(root);
      expect(hookModule.needsInstall(root)).toBe(false);
    });
  });

  describe("installIfNeeded", () => {
    it("invokes the stub pnpm with the frozen-lockfile args and cwd set to the worktree root, and removes the lock file once a successful install finishes (the finally-block cleanup contract)", () => {
      const { worktreeDir } = buildRepoWithWorktree();
      writeFileSync(
        join(worktreeDir, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
      );
      const logDir = mkdtempSync(join(tmpdir(), "ewd-log-"));
      scratchDirs.push(logDir);
      const logFile = join(logDir, "log.txt");
      installStubPnpm(logFile);

      const result = hookModule.installIfNeeded(worktreeDir);

      expect(result.installed).toBe(true);
      expect(existsSync(logFile)).toBe(true);
      const [cwd, ...argsPart] = readFileSync(logFile, "utf8")
        .trim()
        .split("\t");
      expect(cwd).toBe(worktreeDir);
      expect(argsPart.join("\t")).toBe(
        "install --frozen-lockfile --prefer-offline",
      );

      // The lock is ALWAYS removed once the install attempt finishes
      // (success or failure) -- a lock left behind after a successful
      // install would report "another session is installing" forever
      // afterward with no way to clear it short of a manual `rm`.
      const lockPath = join(
        hookModule.gitDirFor(worktreeDir),
        "worktree-deps.lock",
      );
      expect(existsSync(lockPath)).toBe(false);
    });

    it("never invokes pnpm and creates no lock file when needsInstall is false (install marker already present)", () => {
      const { worktreeDir } = buildRepoWithWorktree();
      writeFileSync(
        join(worktreeDir, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
      );
      mkdirSync(join(worktreeDir, "node_modules"), { recursive: true });
      writeFileSync(
        join(worktreeDir, "node_modules", ".modules.yaml"),
        "x: 1\n",
      );
      const logDir = mkdtempSync(join(tmpdir(), "ewd-log-skip-"));
      scratchDirs.push(logDir);
      const logFile = join(logDir, "log.txt");
      installStubPnpm(logFile);

      const result = hookModule.installIfNeeded(worktreeDir);

      expect(result).toEqual({ installed: false, message: "" });
      expect(existsSync(logFile)).toBe(false);
      const lockPath = join(
        hookModule.gitDirFor(worktreeDir),
        "worktree-deps.lock",
      );
      expect(existsSync(lockPath)).toBe(false);
    });

    it("reports a non-empty message naming another session and never invokes pnpm when the lock file already exists (concurrent-session contention)", () => {
      const { worktreeDir } = buildRepoWithWorktree();
      writeFileSync(
        join(worktreeDir, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
      );
      const logDir = mkdtempSync(join(tmpdir(), "ewd-log-contend-"));
      scratchDirs.push(logDir);
      const logFile = join(logDir, "log.txt");
      installStubPnpm(logFile);

      // Simulate a concurrent session already holding the lock.
      const lockPath = join(
        hookModule.gitDirFor(worktreeDir),
        "worktree-deps.lock",
      );
      const fd = openSync(lockPath, "wx");

      try {
        const result = hookModule.installIfNeeded(worktreeDir);

        expect(result.installed).toBe(false);
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.message).toMatch(/another session/);
        expect(existsSync(logFile)).toBe(false);
      } finally {
        // Close the fd here rather than after the assertions above so it
        // can't leak if one of them throws first.
        closeSync(fd);
      }
    });
  });
});
