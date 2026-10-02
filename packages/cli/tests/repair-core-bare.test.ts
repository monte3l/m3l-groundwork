// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Unit + script-level tests for the worktrees pack's hook
 * `templates/packs/worktrees/files/.claude/hooks/repair-core-bare.mjs`, a
 * plain ESM script outside every tsconfig project -- loaded by URL, same
 * pattern as `worktree-guards.test.ts`. Unlike that file's two hooks, this
 * one has no relative import of its own (it never spawns git, see below),
 * so it's imported directly from its real location rather than copied into
 * a fixture tree first.
 *
 * Background (why this hook exists): Claude Code's EnterWorktree/
 * ExitWorktree tools are documented
 * (anthropics/claude-code#58345, anthropics/claude-code#69802) to write
 * `core.bare = true` into the SHARED `.git/config` of a normal (non-bare)
 * repo, which breaks `git status` in the MAIN checkout ("this operation
 * must be run in a work tree") while linked worktrees keep working --
 * reproduced for real below with actual `git` child processes, not an
 * assumption. The hook repairs exactly that one line, in the `[core]`
 * section only, and never touches a genuinely bare repository (identified
 * by its common git dir's basename not being `.git`) even though a bare
 * repo's own config legitimately says `bare = true`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmodIneffective } from "./chmod-ineffective.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRootDir = join(here, "..", "..", "..");
const hookPath = join(
  repoRootDir,
  "templates",
  "packs",
  "worktrees",
  "files",
  ".claude",
  "hooks",
  "repair-core-bare.mjs",
);

/**
 * The parent environment minus the variables git itself calls
 * repository-local -- same helper as `worktree-guards.test.ts`'s
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

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
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
}

/** Runs `git` and asserts it succeeded -- for setup steps that must not fail. */
function gitOk(cwd: string, ...args: string[]): void {
  const result = git(cwd, ...args);
  expect(result.status, result.stderr).toBe(0);
}

/** Initializes a fresh repo at `dir` on `main` with one empty commit. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, "init", "-b", "main");
  gitOk(dir, "commit", "--allow-empty", "-m", "init");
}

/** `git status`'s exit code -- 0 means it succeeded. */
function gitStatusCode(cwd: string): number | null {
  return git(cwd, "status").status;
}

function configPathOf(repoRoot: string): string {
  return join(repoRoot, ".git", "config");
}

/** Extracts the `[core]` section's own text (up to the next section header or EOF). */
function coreSectionOf(content: string): string {
  const match = /\[core\]([\s\S]*?)(?=\n\[|$)/.exec(content);
  return match?.[1] ?? "";
}

interface RepairCoreBareModule {
  repairCoreBare: (cwd: string) => {
    repaired: boolean;
    configPath: string;
    error?: string;
    staleLock?: string;
  };
}

describe("repairCoreBare", () => {
  let hookModule: RepairCoreBareModule;
  const scratchDirs: string[] = [];

  beforeAll(async () => {
    hookModule = (await import(
      pathToFileURL(hookPath).href
    )) as RepairCoreBareModule;
  });

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs core.bare=true to false in the main checkout's own .git/config, restoring `git status` there", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-main-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    // Discriminate the fix: confirm the bug actually reproduces first.
    expect(gitStatusCode(repoRoot)).not.toBe(0);

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result).toEqual({
      repaired: true,
      configPath: configPathOf(repoRoot),
    });
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "false",
    );
    expect(gitStatusCode(repoRoot)).toBe(0);
  });

  it("repairs when cwd is a subdirectory of the main checkout, not just the checkout root itself", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-subdir-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    const subdir = join(repoRoot, "nested", "deep");
    mkdirSync(subdir, { recursive: true });

    const result = hookModule.repairCoreBare(subdir);

    expect(result).toEqual({
      repaired: true,
      configPath: configPathOf(repoRoot),
    });
    expect(gitStatusCode(repoRoot)).toBe(0);
  });

  it("repairs the SHARED config when cwd is a linked worktree's own root, fixing `git status` in the main checkout it points back to", () => {
    // realpathSync-resolved: macOS's $TMPDIR is a symlink into /private, and
    // git itself resolves the WORKTREE's `.git` gitdir pointer to the fully
    // resolved absolute path when it creates it -- an un-resolved scratch
    // dir would make the expected configPath below compare a symlinked path
    // against the hook's canonical, already-resolved one.
    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "repair-core-bare-linked-")),
    );
    scratchDirs.push(scratch);
    const repoRoot = join(scratch, "repo");
    initRepo(repoRoot);
    const worktreeDir = join(scratch, "wt");
    gitOk(repoRoot, "worktree", "add", worktreeDir, "-b", "feat/w");
    gitOk(repoRoot, "config", "core.bare", "true");
    // Discriminate the fix: the bug reproduces in the MAIN checkout while
    // the linked worktree itself keeps working -- the exact asymmetry the
    // upstream issue describes.
    expect(gitStatusCode(repoRoot)).not.toBe(0);
    expect(gitStatusCode(worktreeDir)).toBe(0);

    const result = hookModule.repairCoreBare(worktreeDir);

    expect(result).toEqual({
      repaired: true,
      configPath: configPathOf(repoRoot),
    });
    expect(gitStatusCode(repoRoot)).toBe(0);
    expect(gitStatusCode(worktreeDir)).toBe(0);
  });

  it("[KNOWN-GUARANTEE] never touches a genuine bare repository reached through a worktree created off it, even though its config legitimately says bare=true (common dir basename is not `.git`)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "repair-core-bare-bare-"));
    scratchDirs.push(scratch);
    const normalRepo = join(scratch, "normal");
    initRepo(normalRepo);
    const bareRepo = join(scratch, "bare.git");
    gitOk(scratch, "clone", "--bare", normalRepo, bareRepo);
    const worktreeDir = join(scratch, "wt-from-bare");
    gitOk(bareRepo, "worktree", "add", worktreeDir, "main");
    const configBefore = readFileSync(join(bareRepo, "config"), "utf8");
    expect(git(bareRepo, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );

    const result = hookModule.repairCoreBare(worktreeDir);

    expect(result.repaired).toBe(false);
    expect(readFileSync(join(bareRepo, "config"), "utf8")).toBe(configBefore);
    expect(git(bareRepo, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );
  });

  it("fixes only the [core] section's own bare=true line, leaving an unrelated section's bare=true line (e.g. a [remote \"origin\"] entry) untouched", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-section-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    const crafted = [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      "\tbare = true",
      "\tlogallrefupdates = true",
      '[remote "origin"]',
      "\turl = https://example.com/repo.git",
      "\tbare = true",
      "",
    ].join("\n");
    writeFileSync(configPathOf(repoRoot), crafted);

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result).toEqual({
      repaired: true,
      configPath: configPathOf(repoRoot),
    });
    const after = readFileSync(configPathOf(repoRoot), "utf8");
    expect(coreSectionOf(after)).toMatch(/bare\s*=\s*false/i);
    // Only the `bare` line itself is touched -- `filemode = true` (also
    // literally containing "true") stays exactly as it was.
    expect(coreSectionOf(after)).not.toMatch(/bare\s*=\s*true/i);
    expect(coreSectionOf(after)).toContain("\tfilemode = true");
    // The remote section's own `bare = true` line is byte-for-byte
    // untouched -- not just "still says true somewhere".
    expect(after).toContain(
      '[remote "origin"]\n\turl = https://example.com/repo.git\n\tbare = true',
    );
  });

  it.each([
    ["bare = true" /* default git init formatting */],
    ["bare=true"],
    ["Bare = TRUE"],
    // Tabs around `=` instead of spaces -- no extra LEADING whitespace of
    // its own, since the substring replace below preserves the original
    // line's own leading tab; adding another here would double it up.
    ["bare\t=\ttrue"],
  ])(
    "recognizes the whitespace/case variant %j and rewrites it so `git config --bool core.bare` reads false",
    (variantLine) => {
      const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-variant-"));
      scratchDirs.push(repoRoot);
      initRepo(repoRoot);
      const before = readFileSync(configPathOf(repoRoot), "utf8");
      expect(before).toContain("bare = false");
      const crafted = before.replace("bare = false", variantLine);
      writeFileSync(configPathOf(repoRoot), crafted);

      const result = hookModule.repairCoreBare(repoRoot);

      expect(result.repaired).toBe(true);
      expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
        "false",
      );
      // Every other line of the file is untouched -- replacing the target
      // line (including whatever leading whitespace it carries, which the
      // hook preserves verbatim) back with its original canonical form must
      // reproduce `before` exactly.
      const after = readFileSync(configPathOf(repoRoot), "utf8");
      const restored = after.replace(
        /^[ \t]*bare[ \t]*=[ \t]*false/im,
        "\tbare = false",
      );
      expect(restored).toBe(before);
    },
  );

  it("is a no-op (repaired:false, file byte-for-byte unchanged) when core.bare is already false", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-noop-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    const before = readFileSync(configPathOf(repoRoot), "utf8");
    const statBefore = statSync(configPathOf(repoRoot));

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result).toEqual({
      repaired: false,
      configPath: configPathOf(repoRoot),
    });
    expect(readFileSync(configPathOf(repoRoot), "utf8")).toBe(before);
    expect(statSync(configPathOf(repoRoot)).mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("is idempotent: a second call after a real repair reports repaired:false and changes nothing further", () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "repair-core-bare-idempotent-"),
    );
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");

    const first = hookModule.repairCoreBare(repoRoot);
    expect(first.repaired).toBe(true);
    const afterFirst = readFileSync(configPathOf(repoRoot), "utf8");

    const second = hookModule.repairCoreBare(repoRoot);

    expect(second).toEqual({
      repaired: false,
      configPath: configPathOf(repoRoot),
    });
    expect(readFileSync(configPathOf(repoRoot), "utf8")).toBe(afterFirst);
  });

  it('returns repaired:false and configPath:"" for a cwd with no .git ancestor at all', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "repair-core-bare-nonrepo-"));
    scratchDirs.push(nonRepo);

    const result = hookModule.repairCoreBare(nonRepo);

    expect(result).toEqual({ repaired: false, configPath: "" });
  });

  it('returns repaired:false and configPath:"" for a malformed .git file (not a `gitdir: ...` line), without throwing', () => {
    const scratch = mkdtempSync(join(tmpdir(), "repair-core-bare-malformed-"));
    scratchDirs.push(scratch);
    writeFileSync(join(scratch, ".git"), "this is not a gitdir line\n");

    let result: { repaired: boolean; configPath: string } | undefined;
    expect(() => {
      result = hookModule.repairCoreBare(scratch);
    }).not.toThrow();

    expect(result).toEqual({ repaired: false, configPath: "" });
  });

  it.skipIf(chmodIneffective)(
    "returns {repaired:false} with no `error` key, and prints a stderr hint, when the located config file can't be read (EACCES) -- a pre-detection failure",
    () => {
      const repoRoot = mkdtempSync(
        join(tmpdir(), "repair-core-bare-unreadable-"),
      );
      scratchDirs.push(repoRoot);
      initRepo(repoRoot);
      gitOk(repoRoot, "config", "core.bare", "true");
      chmodSync(configPathOf(repoRoot), 0o000);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      let result:
        { repaired: boolean; configPath: string; error?: string } | undefined;
      try {
        expect(() => {
          result = hookModule.repairCoreBare(repoRoot);
        }).not.toThrow();
      } finally {
        // Restore the filesystem permission regardless of outcome, but defer
        // `mockRestore()` until after the assertions below -- it also clears
        // `.mock.calls`, which would erase the very history being asserted.
        chmodSync(configPathOf(repoRoot), 0o644);
      }

      expect(result?.repaired).toBe(false);
      expect(result?.configPath).toBe(configPathOf(repoRoot));
      expect(result !== undefined && Object.hasOwn(result, "error")).toBe(
        false,
      );
      expect(stderrSpy).toHaveBeenCalled();
      expect(stderrSpy.mock.calls[0]?.[0]).toMatch(
        /could not check core\.bare/i,
      );
      stderrSpy.mockRestore();
    },
  );

  it("[KNOWN-GUARANTEE] never touches a bare clone stored in a directory literally named `.git`, even reached from a worktree created off it or from its own containing directory", () => {
    const scratch = mkdtempSync(
      join(tmpdir(), "repair-core-bare-dotgit-clone-"),
    );
    scratchDirs.push(scratch);
    const srcRepo = join(scratch, "src");
    initRepo(srcRepo);
    const projDir = join(scratch, "proj");
    mkdirSync(projDir, { recursive: true });
    const bareDir = join(projDir, ".git");
    gitOk(scratch, "clone", "--bare", srcRepo, bareDir);
    // `../wt`, run with cwd = proj/.git, resolves to proj/wt -- a worktree
    // created as a sibling of the bare clone's own ".git"-named directory,
    // the exact "proj/ as a phantom main worktree" layout the hook's own
    // header comment warns about.
    gitOk(bareDir, "worktree", "add", "../wt");
    const worktreeDir = join(projDir, "wt");
    expect(git(bareDir, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );
    const configBefore = readFileSync(join(bareDir, "config"), "utf8");

    const resultFromWorktree = hookModule.repairCoreBare(worktreeDir);
    const resultFromProj = hookModule.repairCoreBare(projDir);

    expect(resultFromWorktree.repaired).toBe(false);
    expect(resultFromProj.repaired).toBe(false);
    expect(readFileSync(join(bareDir, "config"), "utf8")).toBe(configBefore);
    expect(git(bareDir, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );
  });

  it("[ACCEPTED TRADE-OFF] leaves a freshly `git init`'d repo with no commit or index alone, even when core.bare is true", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-fresh-"));
    scratchDirs.push(repoRoot);
    mkdirSync(repoRoot, { recursive: true });
    gitOk(repoRoot, "init", "-b", "main");
    gitOk(repoRoot, "config", "core.bare", "true");
    // Confirms the premise: a brand-new repo has no common-dir index yet.
    expect(
      statSync(join(repoRoot, ".git", "index"), { throwIfNoEntry: false }),
    ).toBeUndefined();

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result).toEqual({ repaired: false, configPath: "" });
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );
  });

  it.skipIf(chmodIneffective)(
    "returns {repaired:false, configPath, error} when core.bare=true is confirmed but creating config.lock fails",
    () => {
      const repoRoot = mkdtempSync(
        join(tmpdir(), "repair-core-bare-writefail-"),
      );
      scratchDirs.push(repoRoot);
      initRepo(repoRoot);
      gitOk(repoRoot, "config", "core.bare", "true");
      const gitDir = join(repoRoot, ".git");
      chmodSync(gitDir, 0o555);

      let result:
        { repaired: boolean; configPath: string; error?: string } | undefined;
      try {
        result = hookModule.repairCoreBare(repoRoot);
      } finally {
        chmodSync(gitDir, 0o755);
      }

      expect(result.repaired).toBe(false);
      expect(result.configPath).toBe(configPathOf(repoRoot));
      expect(typeof result.error).toBe("string");
      expect(result.error).not.toBe("");
    },
  );

  it("does not write when config.lock already exists, leaving both the config and the lock byte-for-byte untouched", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-lock-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    const lockPath = `${configPathOf(repoRoot)}.lock`;
    writeFileSync(lockPath, "held by a concurrent git process");
    const configBefore = readFileSync(configPathOf(repoRoot), "utf8");

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result).toEqual({
      repaired: false,
      configPath: configPathOf(repoRoot),
    });
    expect(Object.hasOwn(result, "error")).toBe(false);
    expect(readFileSync(configPathOf(repoRoot), "utf8")).toBe(configBefore);
    expect(readFileSync(lockPath, "utf8")).toBe(
      "held by a concurrent git process",
    );
  });

  it("reports a config.lock older than the 60s stale threshold as an error naming the lock path, without deleting it or touching the config", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-stalelock-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    const lockPath = `${configPathOf(repoRoot)}.lock`;
    writeFileSync(lockPath, "held by a crashed git process");
    const staleTime = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath, staleTime, staleTime);
    const configBefore = readFileSync(configPathOf(repoRoot), "utf8");

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result.repaired).toBe(false);
    expect(result.configPath).toBe(configPathOf(repoRoot));
    expect(typeof result.error).toBe("string");
    expect(result.error).not.toBe("");
    expect(result.error).toContain(lockPath);
    expect(result.staleLock).toBe(lockPath);
    expect(readFileSync(configPathOf(repoRoot), "utf8")).toBe(configBefore);
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );
    expect(statSync(lockPath, { throwIfNoEntry: false })).not.toBeUndefined();
    expect(readFileSync(lockPath, "utf8")).toBe(
      "held by a crashed git process",
    );
  });

  it("treats a config.lock just under the 60s stale threshold (30s old) as quiet, same as a fresh lock -- no error, no staleLock, config and lock both untouched", () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "repair-core-bare-freshish-lock-"),
    );
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    const lockPath = `${configPathOf(repoRoot)}.lock`;
    writeFileSync(lockPath, "held by a concurrent git process");
    const recentTime = new Date(Date.now() - 30_000);
    utimesSync(lockPath, recentTime, recentTime);
    const configBefore = readFileSync(configPathOf(repoRoot), "utf8");

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result).toEqual({
      repaired: false,
      configPath: configPathOf(repoRoot),
    });
    expect(Object.hasOwn(result, "error")).toBe(false);
    expect(Object.hasOwn(result, "staleLock")).toBe(false);
    expect(readFileSync(configPathOf(repoRoot), "utf8")).toBe(configBefore);
    expect(readFileSync(lockPath, "utf8")).toBe(
      "held by a concurrent git process",
    );
  });

  it("leaves no config.lock behind after a successful repair, and preserves the original file mode of .git/config", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-mode-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    chmodSync(configPathOf(repoRoot), 0o600);

    const result = hookModule.repairCoreBare(repoRoot);

    expect(result.repaired).toBe(true);
    expect(
      statSync(`${configPathOf(repoRoot)}.lock`, { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(statSync(configPathOf(repoRoot)).mode & 0o777).toBe(0o600);
  });
});

describe("repair-core-bare (hook script)", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function runHook(stdinInput: string, cwd?: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [hookPath], {
      input: stdinInput,
      encoding: "utf8",
      cwd,
    });
  }

  function buildRepoNeedingRepair(prefix: string): string {
    const repoRoot = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);
    gitOk(repoRoot, "config", "core.bare", "true");
    return repoRoot;
  }

  it("exits 0 and prints a hookSpecificOutput mentioning core.bare and the config path when stdin names a repo needing repair", () => {
    const repoRoot = buildRepoNeedingRepair("repair-core-bare-hook-cwd-");

    const result = runHook(JSON.stringify({ cwd: repoRoot }));

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
      };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toMatch(/core\.bare/i);
    expect(output.hookSpecificOutput.additionalContext).toContain(
      configPathOf(repoRoot),
    );
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "false",
    );
  });

  it("falls back to process.cwd() when the stdin payload has no cwd field", () => {
    const repoRoot = buildRepoNeedingRepair("repair-core-bare-hook-nocwd-");

    const result = runHook(JSON.stringify({}), repoRoot);

    expect(result.status).toBe(0);
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "false",
    );
  });

  it("falls back to process.cwd() when stdin is invalid JSON", () => {
    const repoRoot = buildRepoNeedingRepair("repair-core-bare-hook-badjson-");

    const result = runHook("not valid json {{{", repoRoot);

    expect(result.status).toBe(0);
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "false",
    );
  });

  it("echoes payload.hook_event_name in hookSpecificOutput.hookEventName instead of defaulting", () => {
    const repoRoot = buildRepoNeedingRepair("repair-core-bare-hook-event-");

    // PostToolUse is the event this hook is actually wired to (alongside
    // SessionStart, its default) -- not PreCompact.
    const result = runHook(
      JSON.stringify({ cwd: repoRoot, hook_event_name: "PostToolUse" }),
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  it("prints nothing to stdout and still exits 0 when nothing needed repairing", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repair-core-bare-hook-noop-"));
    scratchDirs.push(repoRoot);
    initRepo(repoRoot);

    const result = runHook(JSON.stringify({ cwd: repoRoot }));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 with empty stdout when cwd is not inside any git repository at all", () => {
    const nonRepo = mkdtempSync(
      join(tmpdir(), "repair-core-bare-hook-nonrepo-"),
    );
    scratchDirs.push(nonRepo);

    const result = runHook(JSON.stringify({ cwd: nonRepo }));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it.skipIf(chmodIneffective)(
    "prints a systemMessage with the manual git-config fix and exits 0 when the write fails after core.bare=true is confirmed",
    () => {
      const repoRoot = buildRepoNeedingRepair(
        "repair-core-bare-hook-writefail-",
      );
      const gitDir = join(repoRoot, ".git");
      chmodSync(gitDir, 0o555);

      let result: SpawnSyncReturns<string>;
      try {
        result = runHook(JSON.stringify({ cwd: repoRoot }));
      } finally {
        chmodSync(gitDir, 0o755);
      }

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        systemMessage: string;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.systemMessage).toContain(
        `git config --file ${configPathOf(repoRoot)} core.bare false`,
      );
      expect(output.hookSpecificOutput.additionalContext).toMatch(
        /core\.bare/i,
      );
    },
  );

  it("prints a systemMessage with both the rm-lock and git-config manual-fix commands, and a non-empty additionalContext, when config.lock is stale", () => {
    const repoRoot = buildRepoNeedingRepair("repair-core-bare-hook-stalelock-");
    const lockPath = `${configPathOf(repoRoot)}.lock`;
    writeFileSync(lockPath, "held by a crashed git process");
    const staleTime = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath, staleTime, staleTime);

    const result = runHook(JSON.stringify({ cwd: repoRoot }));

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      systemMessage: string;
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
      };
    };
    expect(output.systemMessage).toContain(`rm ${lockPath}`);
    expect(output.systemMessage).toContain(
      `git config --file ${configPathOf(repoRoot)} core.bare false`,
    );
    expect(output.hookSpecificOutput.additionalContext).toBeTruthy();
    expect(output.hookSpecificOutput.additionalContext.length).toBeGreaterThan(
      0,
    );
    // The stale lock is reported, never deleted by the hook itself.
    expect(statSync(lockPath, { throwIfNoEntry: false })).not.toBeUndefined();
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "true",
    );
  });

  it("falls back to process.cwd() and stays fast when stdin is closed immediately with no payload at all", () => {
    const repoRoot = buildRepoNeedingRepair(
      "repair-core-bare-hook-closedstdin-",
    );
    const start = Date.now();

    const result = spawnSync(process.execPath, [hookPath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.status).toBe(0);
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "false",
    );
  });

  it("falls back to process.cwd() and stays fast when stdin is an empty string", () => {
    const repoRoot = buildRepoNeedingRepair(
      "repair-core-bare-hook-emptystdin-",
    );
    const start = Date.now();

    const result = runHook("", repoRoot);

    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.status).toBe(0);
    expect(git(repoRoot, "config", "--bool", "core.bare").stdout.trim()).toBe(
      "false",
    );
  });
});

describe("root harness copy stays in sync with the pack copy", () => {
  it("is byte-identical to the pack copy once the root's own SPDX/mirror header is stripped and the shebang is re-accounted for", () => {
    const rootPath = join(
      repoRootDir,
      ".claude",
      "hooks",
      "repair-core-bare.mjs",
    );
    const rootContent = readFileSync(rootPath, "utf8");
    const packContent = readFileSync(hookPath, "utf8");

    const rootLines = rootContent.split("\n");
    const firstDocLine = rootLines.findIndex((line) => line.startsWith("/**"));
    // The root copy carries its own SPDX header + a "mirrors the pack copy"
    // comment ahead of the shared doc block -- everything before the first
    // `/**` line is that header, including the root's own shebang. Stripping
    // it and re-prepending the bare shebang must reproduce the pack copy
    // byte-for-byte, since the two are required to stay identical apart from
    // that header.
    expect(firstDocLine).toBeGreaterThan(0);
    const rootStripped = [
      "#!/usr/bin/env node",
      ...rootLines.slice(firstDocLine),
    ].join("\n");

    expect(rootStripped).toBe(packContent);
  });
});
