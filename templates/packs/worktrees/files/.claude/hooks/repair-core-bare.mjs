#!/usr/bin/env node
/**
 * SessionStart + PostToolUse: resets `core.bare = true` back to `false` in a
 * NORMAL repository's shared `.git/config`.
 *
 * Why this exists: Claude Code's `EnterWorktree`/`ExitWorktree` tools are
 * documented to write `core.bare = true` into the shared config of a
 * non-bare repo and never restore it (anthropics/claude-code#58345, #69802,
 * both closed "not planned"). Git applies a shared `core.bare` to the MAIN
 * worktree only (git-worktree's CONFIGURATION FILE section), so linked
 * worktrees keep working while the root fails every command with "this
 * operation must be run in a work tree" -- and `git worktree list` prints
 * "(bare)" for it. Nothing in Git itself sets the key on a repo created
 * without `--bare`, and no hook fires on a config write, so this checks at
 * the moments it is known to happen (a session starting, a worktree tool
 * returning) and repairs it.
 *
 * Reads files only -- no `git` subprocess, so it is cheap enough to run on
 * every matching tool call. It only acts on a repository that is provably
 * NOT bare: the common git dir must be named exactly `.git` AND contain an
 * `index`. The name alone is not enough -- a bare clone stored in a
 * directory called `.git` (`git clone --bare <url> proj/.git`, a common
 * worktree layout) passes it, and flipping that one would leave `proj/` a
 * phantom main worktree with an empty tree. A bare repo never has a
 * common-dir `index` (linked worktrees keep theirs under `worktrees/<name>/`),
 * while a normal repo has one after its first checkout or commit; the
 * trade-off is that a brand-new repo with no checkout yet is left alone.
 * Only the `bare` key of the `[core]` section is edited, byte-for-byte
 * otherwise, and only when it reads literally `true`. The write follows
 * git's own protocol (`config.lock` created exclusively, then renamed, the
 * original file mode kept), so it can't clobber a concurrent `git config`; a
 * held lock is skipped quietly and retried on the next trigger.
 *
 * Always exits 0 -- advisory infrastructure, never a gate. Stderr is not
 * shown on exit 0, so a repair that was attempted and FAILED is reported on
 * stdout as `systemMessage` + `additionalContext` instead, with the manual
 * fix.
 */
import process from "node:process";
import path from "node:path";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Walks up from `cwd` to the first `.git` and resolves the COMMON git dir:
 * the `.git` directory itself, or, for a linked worktree (a `.git` FILE
 * reading `gitdir: <path>`), the directory named by that git dir's
 * `commondir` file. Returns "" when none can be resolved. A submodule's
 * `.git` file has no `commondir`, so it resolves to its own git dir, whose
 * name isn't `.git` -- left alone on purpose.
 *
 * @param {string} cwd
 * @returns {string}
 */
function findCommonDir(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    const stat = statSync(dotGit, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (stat.isDirectory()) return dotGit;
      if (!stat.isFile()) return "";
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (match === null) return "";
      const gitDir = path.resolve(dir, match[1].trim());
      const commonFile = path.join(gitDir, "commondir");
      if (statSync(commonFile, { throwIfNoEntry: false }) === undefined) {
        return gitDir;
      }
      return path.resolve(gitDir, readFileSync(commonFile, "utf8").trim());
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

/**
 * Rewrites a `bare = true` line inside the `[core]` section to `bare =
 * false`, leaving every other byte alone. Returns the new text, or `null`
 * when there was nothing to change. Only the literal `true` is recognised
 * (git also accepts `yes`/`on`/`1`; Claude Code writes `true`).
 *
 * @param {string} text
 * @returns {string | null}
 */
function resetCoreBare(text) {
  const lines = text.split("\n");
  let inCore = false;
  let changed = false;
  const out = lines.map((line) => {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section !== null) inCore = /^core$/i.test(section[1].trim());
    if (!inCore) return line;
    const bare = /^(\s*bare\s*=\s*)true(\s*(?:[#;].*)?\r?)$/i.exec(line);
    if (bare === null) return line;
    changed = true;
    return `${bare[1]}false${bare[2]}`;
  });
  return changed ? out.join("\n") : null;
}

/** @param {unknown} cause */
function firstLine(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split("\n")[0];
}

/**
 * Resets `core.bare = true` to `false` in the shared config of the NORMAL
 * repository containing `cwd`, if it is set. Never throws. `error` is only
 * present when a repair was needed and could not be completed, so the repo
 * is still broken.
 *
 * @param {string} cwd
 * @returns {{ repaired: boolean; configPath: string; error?: string }}
 */
export function repairCoreBare(cwd) {
  let configPath = "";
  let updated;
  try {
    const commonDir = findCommonDir(cwd);
    if (
      commonDir === "" ||
      path.basename(commonDir) !== ".git" ||
      statSync(path.join(commonDir, "index"), { throwIfNoEntry: false }) ===
        undefined
    ) {
      return { repaired: false, configPath: "" };
    }
    configPath = path.join(commonDir, "config");
    updated = resetCoreBare(readFileSync(configPath, "utf8"));
  } catch (cause) {
    // Locating or reading the config failed before we knew anything was
    // wrong: a missing file just means "not a repo we can repair".
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      return { repaired: false, configPath };
    }
    process.stderr.write(
      `repair-core-bare: could not check core.bare (${firstLine(cause)}).\n`,
    );
    return { repaired: false, configPath };
  }
  if (updated === null) return { repaired: false, configPath };

  // From here on `core.bare = true` is confirmed, so a failure leaves the
  // repository broken and must be reported, never swallowed.
  const lock = `${configPath}.lock`;
  let fd;
  try {
    const mode = statSync(configPath).mode & 0o777;
    try {
      fd = openSync(lock, "wx", mode);
    } catch (cause) {
      if (cause?.code === "EEXIST") {
        // git (or another hook run) holds the lock right now; retry on the
        // next trigger rather than racing it.
        return { repaired: false, configPath };
      }
      throw cause;
    }
    writeSync(fd, updated);
    closeSync(fd);
    fd = undefined;
    chmodSync(lock, mode);
    renameSync(lock, configPath);
    return { repaired: true, configPath };
  } catch (cause) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The original failure below is the one worth reporting.
      }
    }
    try {
      rmSync(lock, { force: true });
    } catch (cleanup) {
      process.stderr.write(
        `repair-core-bare: left ${lock} behind (${firstLine(cleanup)}).\n`,
      );
    }
    return { repaired: false, configPath, error: firstLine(cause) };
  }
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * Reads the hook payload from stdin. Resolves to "" for a TTY, a stream
 * error, or no EOF within `timeoutMs`, so the hook can never hang a tool
 * call or exit non-zero over its own input.
 *
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function readStdin(timeoutMs) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

if (isEntryPoint()) {
  let input = {};
  try {
    input = JSON.parse(await readStdin(2000));
  } catch {
    // No or invalid payload: fall back to the process cwd.
  }
  const cwd =
    typeof input?.cwd === "string" && input.cwd !== ""
      ? input.cwd
      : process.cwd();
  const { repaired, configPath, error } = repairCoreBare(cwd);
  const eventName =
    typeof input?.hook_event_name === "string" && input.hook_event_name !== ""
      ? input.hook_event_name
      : "SessionStart";
  if (repaired) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext:
            `repair-core-bare: core.bare was true in ${configPath} (a known ` +
            "EnterWorktree/ExitWorktree side effect, anthropics/claude-code#58345) " +
            "and has been reset to false.",
        },
      }),
    );
  } else if (error !== undefined) {
    const fix = `git config --file ${configPath} core.bare false`;
    process.stdout.write(
      JSON.stringify({
        systemMessage: `repair-core-bare: core.bare is still true in ${configPath} (${error}); run \`${fix}\`.`,
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext:
            `repair-core-bare FAILED to reset core.bare in ${configPath} (${error}). ` +
            `git commands in the main checkout will fail until it is fixed: run \`${fix}\`.`,
        },
      }),
    );
  }
  process.exit(0);
}
