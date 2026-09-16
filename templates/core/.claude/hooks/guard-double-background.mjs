#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): block a command that combines `run_in_background:
 * true` with a shell-level detach construct (`nohup`, `disown`, or a trailing
 * `&`) in the same call.
 *
 * The two mechanisms both try to survive process/session churn, but stacking
 * them produces a false "completed" report instead of a working one: the
 * harness's own background-job tracking loses track of a process it never
 * actually owns (the shell already detached it), so a poll against the
 * harness-tracked job reports done while the real work is either still
 * running unobserved or was silently killed along with the polling wrapper.
 * Pick exactly one detachment mechanism per call: `run_in_background: true`
 * alone (the harness tracks it), or a plain foreground command wrapped in
 * `nohup <cmd> > <log> 2>&1 & disown` with the polling done separately
 * against the raw PID (`kill -0 $PID`) -- never both on the same invocation.
 *
 * Fail-open on everything ambiguous: a malformed payload, a missing/
 * non-boolean `run_in_background`, or a command with no detach construct all
 * exit 0. This is a DENYLIST of the three known detach constructs, not a
 * strict parse of the shell grammar -- extend `hasShellDetach` as new gaps
 * are found rather than reaching for a real shell parser.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Does `command` contain a shell-level detach construct: `nohup`, `disown`,
 * or a trailing background `&`?
 *
 * Both checks are anchored to avoid matching ordinary argument text, not
 * just shell operators:
 *
 * - `nohup`/`disown` only count in COMMAND POSITION -- the start of the
 *   whole string, or right after a command separator (`;`, `&`, `|`, `(`).
 *   An unanchored `\bnohup\b` would also fire on `grep -n nohup file.txt`
 *   (searching FOR the word) -- matching argument text, not an invocation.
 * - the bare `&` check excludes `&&` (logical AND), both fd-duplication
 *   redirect spellings -- `2>&1` (a `&` immediately preceded by `>`) and
 *   `&>`/`&>>` (bash's combined-redirect shorthand for `> file 2>&1`) -- and
 *   requires the `&` to sit at a command boundary (end-of-command or
 *   followed by whitespace), so an embedded query-string `&`
 *   (`...100&page=2`) isn't misread as backgrounding.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function hasShellDetach(command) {
  if (/(?:^|[;&|(])\s*(?:nohup|disown)\b/.test(command)) return true;
  return /(?<![&>])&(?![&>\S])/.test(command);
}

/**
 * Pure decision function -- exported for unit testing. Every ambiguous or
 * non-applicable input returns `false` (allow), and only one confirmed
 * verdict returns `true` (block).
 *
 * @param {string} command
 * @param {unknown} runInBackground raw `tool_input.run_in_background` value
 * @returns {boolean} true = block, false = allow
 */
export function shouldBlockDoubleBackground(command, runInBackground) {
  if (runInBackground !== true) return false;
  if (typeof command !== "string" || command.length === 0) return false;
  return hasShellDetach(command);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const command = input.tool_input?.command;
  const runInBackground = input.tool_input?.run_in_background;

  if (!shouldBlockDoubleBackground(command, runInBackground)) process.exit(0);

  process.stderr.write(`\
[guard-double-background] Blocked: this command combines \`run_in_background:
true\` with a shell-level detach construct (\`nohup\`, \`disown\`, or a
trailing \`&\`). Stacking both risks a false "completed" report -- the
harness loses track of a process the shell already detached. Pick exactly one:
  - \`run_in_background: true\` alone, polled via TaskOutput/Monitor, or
  - a foreground \`nohup <cmd> > <log> 2>&1 & disown\`, polled separately
    against the raw PID (\`kill -0 $PID\`) -- with run_in_background left false.
`);
  process.exit(2);
}
