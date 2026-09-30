#!/usr/bin/env node
/**
 * PreCompact: writes a structured handoff artifact to
 * `tmp/compact-handoff-<session_id>.json` before Claude Code compacts the
 * conversation.
 *
 * "Compaction" is Claude Code's process of shrinking a long conversation down
 * to a summary once it gets too large for the model's context window, so the
 * session can keep going. A "durable artifact" here just means a plain file
 * written to disk: unlike the compaction summary itself, a file on disk
 * survives intact no matter how well that summary captured the details, so
 * reconstructing state after a compaction (branch, last commit, uncommitted
 * files) doesn't depend on the summary having retained it.
 * `reinject-compact-handoff.mjs` (`SessionStart`, matcher
 * `compact|resume|startup`) reads this artifact back as `additionalContext`.
 *
 * Deliberately git/fs-only, no network calls (no lookup for a PR number) --
 * a PreCompact hook runs on the hot path of every compaction, so a network
 * round-trip here would add latency to an already-slow moment. The branch
 * name is enough to look up the PR when needed (`gh pr list --head <branch>`).
 *
 * "Pending gates" is deliberately NOT a live re-run of `pnpm verify` (far
 * too slow for a hook) -- it's `git status --porcelain`, a fast, honest
 * proxy for "there is uncommitted work here." `uncommittedFiles` is `null`
 * when `git status` itself failed (not a repo, git missing) and `[]` only
 * for a genuinely clean tree, so the reinject side can say "git status
 * unavailable" instead of implying a clean worktree it never observed.
 *
 * "Journal paths" is best-effort: a hook has no documented way to address
 * the ephemeral session scratchpad directory a subagent may have journaled
 * to -- so this only lists journal-shaped files under this repo's own
 * gitignored `tmp/` scratch directory (real, cheap, deterministic), not a
 * claim of session-scratchpad discovery this hook cannot honestly make.
 *
 * Rooted at the hook payload's `cwd`, not `CLAUDE_PROJECT_DIR`: Claude Code
 * pins `CLAUDE_PROJECT_DIR` to the session's ORIGINAL checkout and does not
 * move it into a linked worktree, so trusting it would record (and write
 * into) the wrong checkout. `resolveRoot` prefers `cwd`, then
 * `CLAUDE_PROJECT_DIR`, then `process.cwd()`; the file lands at that
 * directory's git toplevel.
 *
 * The file is keyed by the payload's `session_id` (`handoffRelPath`) so
 * concurrent sessions in one checkout never read or delete each other's
 * handoff. A missing or path-unsafe id falls back to the legacy unkeyed
 * `tmp/compact-handoff.json`.
 *
 * The write is atomic: the payload goes to `<handoff>.<pid>.partial` first
 * and is then `renameSync`d over the final name, so a reader never sees a
 * half-written file and a crash mid-write leaves only a `.partial` sibling
 * (which the reinject side's `compact-handoff*.json` scan never matches).
 * If the resolved directory itself no longer exists (a removed worktree), or
 * is not inside a git repository at all (there is no git state to hand off,
 * and a non-repo `cwd` may be `$HOME` itself), nothing is created -- only
 * `tmp/` inside an existing git worktree may be.
 *
 * Advisory-only: always exits 0. A write failure (e.g. `tmp/` unwritable)
 * never fails the turn -- losing a handoff on this one compaction is a hint
 * the next session can't reconstruct as cheaply, not a fatal failure of the
 * turn in progress -- but it is not silent either: one
 * `write-compact-handoff: handoff not written (<reason>)` line goes to
 * stderr.
 */
import process from "node:process";
import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Filename prefix shared by every keyed and legacy handoff artifact. */
export const HANDOFF_GLOB_PREFIX = "compact-handoff";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Root-relative path of the handoff artifact for one session. Only a
 * path-safe id (`[A-Za-z0-9_-]`, 1-128 chars) is embedded in the filename --
 * anything else (missing, non-string, `../x`) maps to the legacy unkeyed
 * name rather than letting payload text steer the write outside `tmp/`.
 *
 * @param {unknown} sessionId the hook payload's `session_id`
 * @returns {string}
 */
export function handoffRelPath(sessionId) {
  return typeof sessionId === "string" && SAFE_SESSION_ID.test(sessionId)
    ? `tmp/${HANDOFF_GLOB_PREFIX}-${sessionId}.json`
    : `tmp/${HANDOFF_GLOB_PREFIX}.json`;
}

/**
 * The directory the session is actually running in: the payload's `cwd`,
 * else `env.CLAUDE_PROJECT_DIR`, else `fallbackCwd` (empty strings skipped).
 * `input` may be any JSON value -- read defensively.
 *
 * @param {unknown} input the parsed hook payload
 * @param {Record<string, string | undefined>} env
 * @param {string} fallbackCwd
 * @returns {string}
 */
export function resolveRoot(input, env, fallbackCwd) {
  const cwd =
    typeof input === "object" && input !== null
      ? /** @type {{ cwd?: unknown }} */ (input).cwd
      : undefined;
  if (typeof cwd === "string" && cwd !== "") return cwd;
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir === "string" && projectDir !== "") return projectDir;
  return fallbackCwd;
}

/**
 * Trims only trailing whitespace/newlines, never leading -- `git status
 * --porcelain`'s first two columns are semantically meaningful status
 * codes that can legitimately BE a leading space (` M` = modified in the
 * worktree only, vs. `M ` = staged); a plain `.trim()` would silently
 * corrupt that first line's status code.
 *
 * @param {string[]} args
 * @returns {string | null} trailing-trimmed stdout, or null on any failure
 *   (missing git, not a repo, command error) -- never throws.
 */
export function runGit(args, cwd = process.cwd()) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      // A non-repo `cwd` is an expected case, not an error worth printing.
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\s+$/, "");
  } catch {
    return null;
  }
}

/** @returns {string} current branch, "" if unavailable */
export function currentBranch(cwd = process.cwd()) {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "";
}

/**
 * Toplevel of the (possibly linked) worktree containing `cwd`, or `cwd`
 * itself outside a repo. Derived from `--show-cdup` against `cwd` so the
 * caller's own spelling of the path survives (`--show-toplevel` returns the
 * symlink-resolved path, e.g. `/private/var/...` for `/var/...` on macOS);
 * `--show-toplevel` is used only when that lexical walk disagrees with git.
 *
 * @param {string} [cwd]
 * @param {string | null} [toplevel] `git rev-parse --show-toplevel` for
 *   `cwd`, when the caller already ran it (null: not a repo); run here when
 *   omitted
 * @returns {string}
 */
export function currentWorktree(
  cwd = process.cwd(),
  toplevel = runGit(["rev-parse", "--show-toplevel"], cwd),
) {
  if (toplevel === null || toplevel === "") return cwd;
  const cdup = runGit(["rev-parse", "--show-cdup"], cwd);
  if (cdup !== null) {
    const logical = resolve(cwd, cdup);
    try {
      if (realpathSync(logical) === realpathSync(toplevel)) return logical;
    } catch {
      // Fall through to git's own answer.
    }
  }
  return toplevel;
}

/**
 * @returns {{ sha: string, signature: string } | null} the last commit's
 *   SHA and its `%G?` signature-verification code (`G`=good, `B`=bad,
 *   `N`=unsigned, ...), or null if no commits/not a repo.
 */
export function lastCommitInfo(cwd = process.cwd()) {
  const raw = runGit(["log", "-1", "--format=%H%x09%G?"], cwd);
  if (raw === null || raw === "") return null;
  const [sha, signature] = raw.split("\t");
  if (!sha) return null;
  return { sha, signature: signature ?? "N" };
}

/**
 * @returns {string[] | null} `git status --porcelain` lines -- a fast, honest
 *   proxy for "there is uncommitted work here," not a gate re-run. `[]` for a
 *   clean tree; `null` when `git status` itself failed (not a repo, git
 *   missing), so a failure is never mistaken for "clean".
 */
export function uncommittedFiles(cwd = process.cwd()) {
  const raw = runGit(["status", "--porcelain"], cwd);
  if (raw === null) return null;
  if (raw === "") return [];
  return raw.split("\n").filter((line) => line.length > 0);
}

/**
 * Journal-shaped files under this repo's gitignored `tmp/` scratch
 * directory -- best-effort, not a claim of ephemeral session-scratchpad
 * discovery (see file header).
 *
 * @param {string} repoRoot
 * @returns {string[]} repo-relative paths, sorted
 */
export function findScratchJournals(repoRoot) {
  const tmpDir = join(repoRoot, "tmp");
  if (!existsSync(tmpDir)) return [];
  let entries;
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) => e.isFile() && /journal/i.test(e.name) && e.name.endsWith(".md"),
    )
    .map((e) => `tmp/${e.name}`)
    .sort();
}

/**
 * Build the full handoff payload from live git/fs state.
 *
 * @param {string} [cwd]
 * @param {string} [worktree] the worktree toplevel containing `cwd`, when the
 *   caller already resolved it (`writeHandoff` does) -- resolved here via
 *   currentWorktree when omitted
 * @returns {Record<string, unknown>}
 */
export function buildHandoff(
  cwd = process.cwd(),
  worktree = currentWorktree(cwd),
) {
  return {
    capturedAt: new Date().toISOString(),
    branch: currentBranch(cwd),
    worktree,
    lastCommit: lastCommitInfo(cwd),
    uncommittedFiles: uncommittedFiles(cwd),
    journals: findScratchJournals(worktree),
  };
}

/**
 * One stderr line naming why no handoff was written -- advisory, so the
 * failure is observable without failing the compaction.
 *
 * @param {string} reason
 * @returns {null}
 */
function reportNotWritten(reason) {
  try {
    process.stderr.write(
      `write-compact-handoff: handoff not written (${reason})\n`,
    );
  } catch {
    // A broken stderr must not turn an advisory hook into a failing one.
  }
  return null;
}

/**
 * Write this session's handoff under the git toplevel of `resolveRoot(...)`,
 * atomically (`<handoff>.<pid>.partial` then `renameSync` over the final
 * name). Creates nothing when the resolved directory does not exist or is
 * not inside a git repository -- there is no git state to hand off there,
 * and writing anyway would litter an arbitrary directory (even `$HOME`).
 * `git rev-parse --show-toplevel` runs once per write; its answer is threaded
 * through to currentWorktree/buildHandoff.
 *
 * @param {unknown} input the parsed `PreCompact` hook payload
 * @param {Record<string, string | undefined>} env
 * @param {string} fallbackCwd
 * @returns {string | null} absolute path written, or null on any failure
 *   (reported as one stderr line) -- never throws (advisory-only).
 */
export function writeHandoff(input, env, fallbackCwd) {
  let partialPath = null;
  try {
    const root = resolveRoot(input, env, fallbackCwd);
    if (!existsSync(root)) {
      return reportNotWritten("target directory does not exist");
    }
    const gitToplevel = runGit(["rev-parse", "--show-toplevel"], root);
    if (gitToplevel === null || gitToplevel === "") {
      return reportNotWritten("not a git repository");
    }
    const toplevel = currentWorktree(root, gitToplevel);
    const sessionId =
      typeof input === "object" && input !== null
        ? /** @type {{ session_id?: unknown }} */ (input).session_id
        : undefined;
    const handoff = {
      ...buildHandoff(toplevel, toplevel),
      sessionId: typeof sessionId === "string" ? sessionId : null,
    };
    const handoffPath = join(toplevel, handoffRelPath(sessionId));
    mkdirSync(join(toplevel, "tmp"), { recursive: true });
    partialPath = `${handoffPath}.${process.pid}.partial`;
    writeFileSync(partialPath, `${JSON.stringify(handoff, null, 2)}\n`);
    renameSync(partialPath, handoffPath);
    partialPath = null;
    return handoffPath;
  } catch (error) {
    if (partialPath !== null) {
      try {
        unlinkSync(partialPath);
      } catch {
        // Best-effort -- a leftover `.partial` never matches the reinject scan.
      }
    }
    // Advisory-only -- never block or fail a compaction over this.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return reportNotWritten(
      typeof code === "string"
        ? code
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

// Deliberately inlined in every hook rather than shared, so each hook stays
// one self-contained file.
// `import.meta.url` is symlink-resolved but `process.argv[1]` is not, so
// comparing them directly is false under any symlinked path and the body would
// never run -- exit 0.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked directly, not when imported for testing.
if (isEntryPoint()) {
  // Read the payload for `cwd`/`session_id`; a malformed payload degrades to
  // `{}` (CLAUDE_PROJECT_DIR / process.cwd(), legacy unkeyed file).
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    input = {};
  }

  writeHandoff(input, process.env, process.cwd());
  process.exit(0);
}
