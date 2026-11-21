#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): blocks a src/tests write outside a linked
 * git worktree under `.claude/worktrees/` -- for ANY caller (hub or writer
 * spoke), on ANY branch. This is stricter than the two guards it sits
 * alongside:
 *
 *   - `guard-branch-isolation.mjs` only blocks while `HEAD` is `main`.
 *   - `guard-hub-src-writes.mjs` only blocks the hub; a writer spoke passes.
 *
 * Installing this pack means every src/tests write -- feature branch or
 * `main`, hub or spoke -- must happen inside a worktree this project
 * creates under `.claude/worktrees/`. A sibling worktree made with a plain
 * `git worktree add ../foo` is deliberately NOT enough: it also closes the
 * gap `bin/lib/protected-paths.mjs`'s own doc comment names -- `isProtectedPath`
 * only ever compares one absolute path's PREFIX against `projectDir`, so a
 * checkout that lives entirely outside `projectDir` can never be recognised
 * as protected by that function alone, no matter where it sits.
 *
 * Detection: a linked worktree's `git rev-parse --git-dir` differs from its
 * `git rev-parse --git-common-dir` (a plain checkout's are identical). The
 * worktree only counts as sanctioned when its own toplevel sits under
 * `<mainRepoRoot>/.claude/worktrees/` -- `mainRepoRoot` being the parent of
 * `--git-common-dir` (a linked worktree's common dir is always
 * `<mainRepoRoot>/.git`).
 *
 * `isProtectedPath` is ALWAYS scoped to `toplevel` (the checkout that
 * actually contains the file -- a worktree's own root, not the main repo's
 * root), never called bare -- an unscoped call treats any absolute path
 * with a literal `/src/` or `/tests/` segment as protected, which would
 * wrongly block every write in a completely unrelated repository cloned
 * at, say, `~/src/other-project`. `guard-branch-isolation.mjs` avoids this
 * the same way (its own header comment names the same hazard). Scoping to
 * `mainRepoRoot` instead of `toplevel` was tried and is WRONG: a sibling
 * worktree's own root is not a path-prefix of `mainRepoRoot` at all, so
 * that scoping silently reopens the sibling-worktree gap this guard exists
 * to close -- see `shouldBlock`'s own comment for the reasoning.
 *
 * A git lookup failure for a reason OTHER than "not a git repository" (git
 * missing, EACCES, a corrupt worktree pointer) is NOT treated as "allow" --
 * unlike an advisory hook (`post-edit-verify.mjs`, which stays informative
 * on a git failure since it's a nudge, not a gate), this is an ENFORCEMENT
 * guard, so an ambiguous git state fails CLOSED (blocks, with a diagnostic)
 * rather than silently turning enforcement off.
 *
 * Blocks by exiting 2 with a self-contained message -- hooks run in
 * parallel with no defined order, so this message can't assume any other
 * guard's message was seen first.
 */
import process from "node:process";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  isProtectedPath,
} from "../../bin/lib/protected-paths.mjs";

/** Thrown by the git runner for any failure that ISN'T "not a git repository". */
export class GitLookupError extends Error {}

/**
 * Returns a git runner bound to `git -C dir`. Distinguishes the expected,
 * silent case (`dir` genuinely isn't in a git repository -- returns `""`)
 * from every other failure (git missing, EACCES, a `dubious ownership`
 * refusal, a corrupt worktree pointer, which prints a DIFFERENT "not a git
 * repository: <path>" form with no "(or any ...)" suffix): those THROW
 * `GitLookupError` rather than returning `""`, so the caller can fail
 * closed instead of silently allowing.
 *
 * @param {string} dir Absolute directory path.
 * @returns {(args: string[]) => string}
 */
export function defaultGitFor(dir) {
  return function git(args) {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        // Don't let git's own stderr leak to this process's stderr.
        // `LC_ALL`/`LANGUAGE` pin git's message to English so the pattern
        // match below doesn't depend on the caller's locale.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
      }).trim();
    } catch (cause) {
      const message = String(cause?.stderr || cause?.message || "").trim();
      if (/not a git repository \(or any /i.test(message)) return "";
      throw new GitLookupError(message.split("\n")[0], { cause });
    }
  };
}

/**
 * `git rev-parse --git-dir`/`--git-common-dir` return a path RELATIVE TO
 * THE `-C` DIRECTORY whenever that directory is inside the working tree --
 * only `--show-toplevel` is documented to always return absolute. Resolved
 * against `boundDir`, then canonicalized (symlinks resolved) so a `boundDir`
 * reached through a symlink (macOS's `/tmp` -> `/private/tmp`) doesn't make
 * an already-absolute, already-canonical git output compare unequal to a
 * resolved-but-not-canonicalized one -- exactly the class of bug this
 * pack's own `post-edit-verify.mjs`-adjacent fix (PR1) closed for the same
 * reason.
 *
 * @param {(args: string[]) => string} git
 * @param {string} boundDir
 * @param {string[]} args
 * @returns {string} Canonicalized absolute path, or "" if the command
 *   returned "" (the expected not-a-repo case; a real failure THROWS
 *   instead, see `defaultGitFor`).
 */
function gitAbsPath(git, boundDir, args) {
  const raw = git(args);
  if (raw === "") return "";
  return canonicalize(resolve(boundDir, raw));
}

/**
 * Pure decision function -- exported for unit testing. Can throw
 * `GitLookupError` (propagated from `git`) when git itself fails
 * unexpectedly; the caller decides what that means (see `isEntryPoint`
 * body below: fail closed).
 *
 * @param {string} filePath The file_path from the tool_input payload.
 * @param {(args: string[]) => string} git A git runner bound to `boundDir`
 *   (see `defaultGitFor`).
 * @param {string} boundDir The same directory `git` was bound to -- the
 *   nearest existing ancestor of `filePath`.
 * @returns {boolean} true = block, false = allow.
 */
export function shouldBlock(filePath, git, boundDir) {
  const gitDir = gitAbsPath(git, boundDir, ["rev-parse", "--git-dir"]);
  if (gitDir === "") return false; // not in a git repo; nothing to enforce

  const commonDir = gitAbsPath(git, boundDir, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const isLinkedWorktree = gitDir !== commonDir;
  // The checkout that actually CONTAINS `filePath` -- the worktree's own
  // root for a linked worktree, the same as `mainRepoRoot` below otherwise.
  const toplevel = canonicalize(git(["rev-parse", "--show-toplevel"])); // always absolute

  // Scoped to the file's OWN checkout root (`toplevel`), never called bare
  // and never scoped to `mainRepoRoot` (the ORIGINAL main checkout's root,
  // computed below) -- both matter for different reasons. An unscoped
  // isProtectedPath(filePath) would treat ANY absolute path containing a
  // literal "/src/" or "/tests/" segment as protected, including a
  // completely unrelated repository the session happens to touch. Scoping
  // to `mainRepoRoot` INSTEAD of `toplevel` would be equally wrong the
  // other way: a sibling worktree's own root is not a path-prefix of
  // `mainRepoRoot` at all (it typically lives in a sibling directory), so
  // that scoping would wrongly report its real src/ files as "not
  // protected" and silently reopen the exact sibling-worktree gap this
  // guard exists to close -- confirmed by a regression test built for
  // exactly this case.
  if (!isProtectedPath(canonicalize(filePath), toplevel)) return false;

  if (!isLinkedWorktree) return true; // the main checkout itself; always blocked

  const mainRepoRoot = dirname(commonDir); // a linked worktree's common-dir is always <mainRepoRoot>/.git
  const sanctionedPrefix = resolve(mainRepoRoot, ".claude", "worktrees");
  const rel = relative(sanctionedPrefix, toplevel);
  // Inside sanctionedPrefix iff `rel` doesn't escape upward via a literal
  // ".." segment and isn't an absolute path (which `relative()` returns
  // instead of a ".."-prefixed one on Windows when the two paths are on
  // different drives). `rel === ""` (the sanctioned directory ITSELF, not a
  // named worktree under it) is correctly treated as NOT inside -- nothing
  // should ever write directly into `.claude/worktrees/` itself.
  const insideSanctioned =
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel);
  return !insideSanctioned;
}

// Kept as a duplicated, self-contained block rather than a shared helper --
// see `post-edit-verify.mjs`'s equivalent comment. `import.meta.url` is
// symlink-resolved by Node's ESM loader but `process.argv[1]` is not.
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

  const filePath = input?.tool_input?.file_path ?? "";
  if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

  // Cheap, unscoped pre-check first -- this can only produce a false
  // NEGATIVE (an obviously-unrelated path skips the git shell-out
  // entirely), never a false positive, so it's safe ahead of the properly
  // scoped check inside `shouldBlock`.
  if (!isProtectedPath(filePath)) process.exit(0);

  // Bind git to the nearest EXISTING ancestor of the write target -- a
  // Write creating a brand-new nested directory means `git -C <that dir>`
  // would otherwise fail outright.
  let probeDir = dirname(resolve(filePath));
  while (!existsSync(probeDir)) {
    const parent = dirname(probeDir);
    if (parent === probeDir) break;
    probeDir = parent;
  }
  const git = defaultGitFor(probeDir);

  let blocked;
  let lookupFailure;
  try {
    blocked = shouldBlock(filePath, git, probeDir);
  } catch (cause) {
    if (cause instanceof GitLookupError) {
      blocked = true;
      lookupFailure = cause.message;
    } else {
      throw cause; // truly unexpected -- surface as a visible hook crash, never silent
    }
  }

  if (!blocked) process.exit(0);

  process.stderr.write(
    lookupFailure !== undefined
      ? `guard-worktree-only: Blocked: git lookup failed for \`${filePath}\` ` +
          `(${lookupFailure}) -- refusing the write rather than allowing it ` +
          "with unknown worktree state.\n"
      : `guard-worktree-only: Blocked: refusing to write \`${filePath}\` outside a ` +
          "linked worktree under `.claude/worktrees/`. This project requires every " +
          "src/tests change to happen inside a worktree -- run the " +
          "`working-in-worktrees` skill's start mode first.\n",
  );
  process.exit(2);
}
