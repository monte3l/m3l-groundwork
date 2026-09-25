#!/usr/bin/env node
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
 * Fail-open by design (matching every sibling hook): a malformed payload, a
 * non-push command, signing not enabled, or a git failure all exit 0. The
 * literal-signature verdict is the only thing that blocks (exit 2). Pair
 * this with your remote's own "require signed commits" branch-protection
 * setting for the authoritative, unbypassable layer -- this hook is only the
 * earlier, local catch.
 */
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseGitPush,
  outgoingCommits,
  unsignedCommits,
  signingEnabled,
} from "../../bin/lib/signed-range.mjs";

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
    process.exit(0);
  }

  const command = input.tool_input?.command;
  const { isPush, dryRun } = parseGitPush(
    typeof command === "string" ? command : "",
  );
  if (!isPush || dryRun) process.exit(0);
  if (!signingEnabled()) process.exit(0);

  let bad;
  try {
    bad = unsignedCommits(outgoingCommits());
  } catch {
    process.exit(0); // cannot determine range -> defer to remote branch protection
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
