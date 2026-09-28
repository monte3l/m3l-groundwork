#!/usr/bin/env node
/**
 * SessionStart (startup|resume): installs dependencies into a freshly
 * created git worktree automatically, so the first edit made there doesn't
 * hit `post-edit-verify.mjs`'s own "no node_modules" exit-2 guard.
 *
 * This is a BACKSTOP, not the primary install path. It only fires on
 * `claude --worktree`/a resumed session already inside a worktree --
 * `SessionStart` does not fire on a mid-session `EnterWorktree`
 * (code.claude.com/docs/en/worktrees: "SessionStart ... does not fire on a
 * mid-session EnterWorktree"), which is the more common way a worktree gets
 * created in this project (the `working-in-worktrees` skill's start mode
 * runs `pnpm install` itself for exactly that reason). Both paths converge
 * on the same guarantee: by the time any edit happens, dependencies exist.
 *
 * Does nothing unless ALL of these hold:
 *   - `cwd` is a LINKED worktree (its `--git-dir` differs from its
 *     `--git-common-dir` -- a plain checkout's are identical).
 *   - `node_modules` is not a symlink (if the project sets
 *     `worktree.symlinkDirectories: ["node_modules"]`, installing here
 *     would write through the symlink into the MAIN checkout's own
 *     node_modules, which is not this hook's job to do).
 *   - A lockfile is present (nothing to install against otherwise).
 *   - `node_modules/.modules.yaml` (pnpm's own install marker) is missing.
 *
 * Always exits 0 -- this is advisory infrastructure, never a gate. A git
 * failure that isn't "not a git repository" still gets a stderr hint rather
 * than silent failure -- see `defaultGitFor`.
 */
import process from "node:process";
import path from "node:path";
import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../bin/lib/protected-paths.mjs";

/**
 * Same pattern as `guard-worktree-only.mjs`'s `defaultGitFor`, but this
 * hook is advisory (a SessionStart backstop), not an enforcement guard, so
 * an unexpected git failure stays fail-OPEN -- it just gets a stderr hint
 * instead of silently doing nothing, the same posture `post-edit-verify.mjs`
 * takes for the identical reason.
 */
export function defaultGitFor(dir) {
  return function git(args) {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
      }).trim();
    } catch (cause) {
      const message = String(cause?.stderr || cause?.message || "").trim();
      if (!/not a git repository \(or any /i.test(message)) {
        process.stderr.write(
          `ensure-worktree-deps: git lookup failed in \`${dir}\` (${message.split("\n")[0]}); ` +
            "skipping the dependency-install check.\n",
        );
      }
      return "";
    }
  };
}

/** See `guard-worktree-only.mjs`'s identical helper for why this matters. */
function gitAbsPath(git, boundDir, args) {
  const raw = git(args);
  if (raw === "") return "";
  return canonicalize(path.resolve(boundDir, raw));
}

/**
 * Resolves `root`'s own `--git-dir` ONCE, used both to decide whether it's
 * a linked worktree and as the lock file's parent directory (unique per
 * worktree, since a linked worktree's `.git` is a file pointing at
 * `<mainRepoRoot>/.git/worktrees/<name>`).
 *
 * @param {string} root
 * @param {(dir: string) => (args: string[]) => string} [gitFactory]
 * @returns {{ gitDir: string; isLinked: boolean }}
 */
function resolveWorktreeGitDir(root, gitFactory) {
  const git = gitFactory(root);
  const gitDir = gitAbsPath(git, root, ["rev-parse", "--git-dir"]);
  if (gitDir === "") return { gitDir: "", isLinked: false };
  const commonDir = gitAbsPath(git, root, ["rev-parse", "--git-common-dir"]);
  return { gitDir, isLinked: gitDir !== commonDir };
}

/**
 * True when `dir` is the root of a LINKED git worktree (not the main
 * checkout, and not a plain non-git directory).
 *
 * @param {string} dir
 * @param {(dir: string) => (args: string[]) => string} [gitFactory]
 * @returns {boolean}
 */
export function isLinkedWorktree(dir, gitFactory = defaultGitFor) {
  return resolveWorktreeGitDir(dir, gitFactory).isLinked;
}

/**
 * `.git` for a linked worktree is a FILE, not a directory -- `git rev-parse
 * --git-dir` resolves it to the real, unique-per-worktree directory
 * `<mainRepoRoot>/.git/worktrees/<name>`, a safe, collision-free lock
 * location. Returns "" when git can't resolve one at all (not a repo, or an
 * unexpected failure `defaultGitFor` already reported).
 *
 * @param {string} root
 * @param {(dir: string) => (args: string[]) => string} [gitFactory]
 * @returns {string}
 */
export function gitDirFor(root, gitFactory = defaultGitFor) {
  return resolveWorktreeGitDir(root, gitFactory).gitDir;
}

/**
 * True when dependencies should be installed in `root`: no existing pnpm
 * install marker, a lockfile is present, and `node_modules` (if it exists
 * at all) is a real directory, not a symlink. Checks `lstatSync` directly
 * rather than `existsSync` + `lstatSync` -- `existsSync` follows a symlink
 * and reports `false` for a DANGLING one, which would skip the very check
 * meant to catch it and let the install proceed through the broken link.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function needsInstall(root) {
  const nodeModules = path.join(root, "node_modules");
  const stat = lstatSync(nodeModules, { throwIfNoEntry: false });
  if (stat !== undefined && stat.isSymbolicLink()) return false;
  const marker = path.join(nodeModules, ".modules.yaml");
  if (existsSync(marker)) return false;
  return existsSync(path.join(root, "pnpm-lock.yaml"));
}

/**
 * Runs `pnpm install --frozen-lockfile --prefer-offline` in `root`,
 * serialized against a concurrent SessionStart/subagent hitting the same
 * worktree via a lock file opened with the `wx` flag (fails if it already
 * exists -- "create exclusively", no separate lock library required). The
 * lock is ALWAYS removed once the attempt finishes, success or failure: the
 * only thing it protects against is two installs running at the exact same
 * moment, not a retry across time, and a lock left behind after a failed
 * install would report "another session is installing" forever afterward
 * with no way to clear it short of a manual `rm`.
 *
 * @param {string} root
 * @returns {{ installed: boolean; message: string }}
 */
export function installIfNeeded(root) {
  if (!needsInstall(root)) {
    return { installed: false, message: "" };
  }

  const gitDir = gitDirFor(root);
  if (gitDir === "") {
    return {
      installed: false,
      message:
        "ensure-worktree-deps: could not resolve this worktree's git " +
        "directory -- run `pnpm install` here by hand.",
    };
  }

  const lockPath = path.join(gitDir, "worktree-deps.lock");
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      return {
        installed: false,
        message:
          `ensure-worktree-deps: lock \`${lockPath}\` exists -- another ` +
          "session is already installing here, or a previous attempt was " +
          "interrupted before it could clean up (remove the lock and run " +
          "`pnpm install` by hand if so).",
      };
    }
    return {
      installed: false,
      message:
        `ensure-worktree-deps: could not create the install lock at ` +
        `\`${lockPath}\` (${cause?.code ?? cause?.message}).`,
    };
  }

  try {
    const res = spawnSync(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      {
        cwd: root,
        encoding: "utf8",
        // A chatty install's combined output can exceed the default 1 MiB
        // buffer, which would otherwise report an unrelated ENOBUFS failure
        // instead of the real one.
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (res.error) {
      return {
        installed: false,
        message: `ensure-worktree-deps: could not run pnpm install (${res.error.message}).`,
      };
    }
    if (res.status !== 0) {
      const cause =
        res.status === null
          ? `killed by ${res.signal}`
          : `exit code ${res.status}`;
      // Both streams, not just one -- pnpm's real failure can land on
      // either, and a chatty install's combined output is capped so a
      // large log doesn't blow past whatever a hook's context budget is.
      const combined = [res.stdout, res.stderr]
        .filter((s) => typeof s === "string" && s.length > 0)
        .join("\n")
        .trim()
        .slice(-4000);
      return {
        installed: false,
        message:
          `ensure-worktree-deps: \`pnpm install\` failed in this worktree ` +
          `(${cause}) -- run it by hand:\n${combined}`,
      };
    }
    return {
      installed: true,
      message: "ensure-worktree-deps: installed dependencies in this worktree.",
    };
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0);
  }

  const root = typeof input?.cwd === "string" ? input.cwd : "";
  if (root === "" || !isLinkedWorktree(root)) process.exit(0);

  const { installed, message } = installIfNeeded(root);
  if (message === "") process.exit(0);

  const reminder =
    "Reminder: this project requires all src/tests development inside a " +
    "worktree -- run the TDD pipeline sequentially in this same worktree " +
    "(no per-spoke isolation), and never `git stash` here (the stash stack " +
    "is shared across every worktree of this repository).";

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: installed ? `${message}\n\n${reminder}` : message,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
