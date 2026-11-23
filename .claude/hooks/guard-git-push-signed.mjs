#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * PreToolUse guard (Bash): blocks a `git push` run through the agent's Bash
 * tool when any outgoing commit is unsigned or has an invalid signature --
 * and only on a machine where commit signing is already turned on.
 *
 * This is the FIRST Bash-matcher hook in this project's harness -- every
 * other PreToolUse hook inspects `tool_input.file_path`; this one inspects
 * `tool_input.command`.
 *
 * Opt-in, not always-on: `signingEnabled()` (bin/lib/signed-range.mjs) checks
 * whether THIS machine's git is configured to sign commits at all
 * (`commit.gpgsign`). A project whose author hasn't set up commit signing
 * gets no enforcement here -- the alternative (enforcing by default) would
 * hard-block every push on a machine with no GPG/SSH signing key configured,
 * which is not a safe default for a freshly bootstrapped project. Turn
 * signing on (`git config commit.gpgsign true`) and this guard turns on with
 * it, no other configuration step.
 *
 * Fails closed on a payload it cannot read, and open on the rest: a non-push
 * command, signing not enabled, or a range it cannot work out all exit 0. The
 * literal-signature verdict is the only other thing that blocks (exit 2). Pair
 * this with your remote's own "require signed commits" branch-protection
 * setting for the authoritative, unbypassable layer -- this hook is only the
 * earlier, local catch.
 *
 * It reads the command line the way a shell does (`bin/lib/signed-range.mjs`):
 * a push inside `&&`, `|`, a subshell, `$(...)` or `bash -c` counts, `git -C DIR`
 * and a `cd DIR` before it name the repository, and the refs a refspec names
 * (`HEAD:refs/heads/x`, `+branch`, `--all`) are what is vetted; a long option is
 * read by its unique prefix as git does, and one it does not know vets every
 * branch. Git runs with the repository's program settings overridden, and only
 * in the repository the hook runs in, its worktrees or CLAUDE_PROJECT_DIR; a
 * directory built at run time (`-C "$W"`, `~`) cannot be placed, so the hook's
 * own is vetted for it. A command word that is an expansion (`$G push`) is read
 * as a possible git. It is a local, best-effort check, not a security boundary.
 */
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The helper this guard needs. The template sync refreshes each file on its own,
// so a repository can hold this guard beside an older (or its own changed)
// signed-range.mjs; a static import of a missing name would crash the hook, and
// under `onFailure: "block"` refuse EVERY Bash call. It is loaded here instead,
// and when it cannot serve this guard the hook degrades (see below).
const HELPER_EXPORTS = [
  "parseGitPushes",
  "outgoingCommits",
  "unsignedCommits",
  "signingEnabled",
  "gitRunner",
  "trustedRoots",
  "dirsToVet",
];
async function loadHelper() {
  try {
    const lib = await import("../../bin/lib/signed-range.mjs");
    return HELPER_EXPORTS.every((name) => typeof lib[name] === "function") ? lib : null;
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Kept as a duplicated, self-contained block in every hook file rather than
// imported from a shared helper -- each hook stays a single independent
// file, which keeps this project's hook count easy to reason about against
// CLAUDE.md's hook budget. `import.meta.url` is symlink-resolved but
// `process.argv[1]` is not, so comparing them directly would be false under
// a symlinked invocation path -- and the guard below would then never run,
// i.e. silently fail open (exit 0) instead of blocking.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked directly, not when imported for testing.
if (isEntryPoint()) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  // A payload that cannot be read cannot be judged, so fail closed. The hook is
  // registered with onFailure: "block", which covers a crash but not a
  // deliberate exit 0, and exit 0 means allow.
  if (typeof input !== "object" || input === null) {
    process.stderr.write("[guard-git-push-signed] could not read the hook payload; blocking.\n");
    process.exit(2);
  }

  const command = input.tool_input?.command;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();

  // This guard and bin/lib/signed-range.mjs are one unit (sync.json refreshes
  // them as two files). If the helper is missing or older than the guard, the
  // push cannot be judged: a command that looks like a push is blocked with the
  // way out, any other command passes, so one stale file refuses no other call.
  const lib = await loadHelper();
  if (lib === null) {
    if (/\bgit\b[^;&|\n]*\bpush\b/.test(typeof command === "string" ? command : "")) {
      process.stderr.write(
        "[guard-git-push-signed] bin/lib/signed-range.mjs is missing or older than this guard; " +
          "refresh both files together (template sync, or copy them from blueprint/files/). Blocking the push.\n",
      );
      process.exit(2);
    }
    process.stderr.write("[guard-git-push-signed] bin/lib/signed-range.mjs is missing or older than this guard; not checking.\n");
    process.exit(0);
  }
  const { parseGitPushes, outgoingCommits, unsignedCommits, signingEnabled, gitRunner, trustedRoots, dirsToVet } = lib;

  // Every real push in the command line (a chain, a subshell, `bash -c`, a
  // `git -C DIR`, a `cd DIR` before it, a command word that is an expansion),
  // each vetted where it runs and for the refs it names, not for `HEAD` of
  // whatever directory the hook started in. A real directory the command line
  // names is vetted only if it is the repository the hook runs in, one of its
  // worktrees, or inside CLAUDE_PROJECT_DIR: another repository's own config can
  // name programs that git would run. A push from there goes unvetted here, like
  // a range the guard cannot work out. A directory that cannot be placed (built
  // from a variable, `~` or a backtick, or no directory) is not "somewhere else":
  // the hook's own directory is vetted for it.
  const roots = trustedRoots(cwd, process.env.CLAUDE_PROJECT_DIR);
  const bad = [];
  const seen = new Set();
  for (const push of parseGitPushes(typeof command === "string" ? command : "")) {
    if (push.dryRun || push.tips.length === 0) continue;
    for (const dir of dirsToVet(cwd, push.dirs, roots)) {
      const runGit = gitRunner(dir);
      if (!signingEnabled(runGit)) continue;
      try {
        for (const hit of unsignedCommits(outgoingCommits(runGit, push.tips), runGit)) {
          if (!seen.has(hit.sha)) {
            seen.add(hit.sha);
            bad.push(hit);
          }
        }
      } catch {
        // cannot determine the range -> defer to remote branch protection
      }
    }
  }
  if (bad.length === 0) process.exit(0);

  process.stderr.write(`\
[guard-git-push-signed] Blocked: refusing to push unsigned/unverified commits.
${bad.map(({ sha, code }) => `  - ${sha.slice(0, 12)} (%G? = ${code})`).join("\n")}

commit.gpgsign is enabled on this machine, so every commit pushed to the
remote must carry a valid signature. Re-sign the range, e.g.:
  git rebase --exec 'git commit --amend --no-edit -S' origin/main
Then retry the push.
`);
  process.exit(2);
}
