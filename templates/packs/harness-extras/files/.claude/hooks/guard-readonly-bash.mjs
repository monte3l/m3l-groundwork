#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): restrict read-only spokes to non-mutating shell
 * commands.
 *
 * Every reviewer/research spoke in `.claude/agents/*.md` declares itself
 * read-only in its system prompt and may hold the `Bash` tool for
 * legitimate reads (`git diff`, `pnpm lint`, coverage files, `grep`), but
 * nothing structurally stops one from running a mutating shell command
 * instead. This hook closes that gap at the point a subagent's Bash call
 * actually runs.
 *
 * The read-only roster is derived here, not hardcoded: every defined agent
 * under `.claude/agents/*.md` whose frontmatter `name` is not in
 * `WRITER_SPOKES` (`bin/lib/agent-roster.mjs` -- the same source
 * `guard-hub-src-writes.mjs` uses) counts as read-only, so the two
 * enforcement points can't drift apart on who's authorized to write what.
 *
 * Scope: only tool calls made from inside one of those read-only subagents
 * are checked -- identified via the hook payload's `agent_type` field
 * (present when `PreToolUse` fires inside a subagent context; absent for
 * the hub's own Bash calls, which this hook does not restrict).
 *
 * Design tradeoff, matching every sibling guard hook's fail-open
 * philosophy: this is a DENYLIST of known-mutating patterns, not a strict
 * allowlist. A stricter allowlist would be more airtight but would also
 * block legitimate read commands this hook's author didn't anticipate (a
 * false positive wedges a reviewer's diagnostic work; a false negative
 * merely defers to code review, which remains the authoritative backstop).
 * Extend MUTATING_PATTERNS as new gaps are found rather than flipping to an
 * allowlist.
 *
 * Known, accepted gaps in the prefix-verb/nested-shell handling (deliberate,
 * per the tradeoff above -- not oversights): a prefix verb's OWN value-taking
 * flag (`sudo -u root rm x`, `env -C /tmp rm x`, `xargs -n 1 rm`) resolves the
 * flag's value as the verb, missing the real command; `bash -c`/`sh -c`'s
 * nested-command regex requires a standalone `-c` (misses combined short
 * flags like `-lc`) and only inspects up to the closing quote (misses
 * `bash -c '...' extra-arg`); other shells (`zsh`, `dash`) and `eval` are not
 * recognized as nested-shell prefixes at all; `find`'s `-exec` check only
 * inspects the immediate next token, missing `-execdir`/`-ok` and a chained
 * `-exec sh -c '...'`.
 */
import process from "node:process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Extract the YAML frontmatter block's `name:` field, or `undefined`. CRLF
 * line endings are normalized first -- the frontmatter delimiter regex only
 * matches a bare `\n`, so an untouched CRLF file would never match at all,
 * silently producing zero read-only agents (which, per this hook's actual
 * usage, means the guard exits 0 -- allow -- for every agent). A quoted
 * value (`name: "some-agent"`) has its quotes stripped so it compares
 * correctly against `WRITER_SPOKES` and the incoming `agent_type`.
 */
function frontmatterName(filePath) {
  const content = readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "") // a leading BOM (a realistic artifact of a Windows editor)
    .replace(/\r\n/g, "\n");
  const match = content.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (match === null) return undefined;
  const nameLine = match[1].split("\n").find((line) => /^name:\s*/.test(line));
  return nameLine
    ?.replace(/^name:\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

/**
 * Every defined agent under `agentsDir` (`.claude/agents/*.md`) whose
 * frontmatter `name` is not in `WRITER_SPOKES`.
 *
 * @param {string} agentsDir absolute path to `.claude/agents/`
 * @returns {Set<string>}
 */
export function readOnlyAgentNames(agentsDir) {
  const names = new Set();
  if (!existsSync(agentsDir)) return names;
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = frontmatterName(join(agentsDir, entry.name));
    if (name !== undefined && !WRITER_SPOKES.has(name)) names.add(name);
  }
  return names;
}

/**
 * Segment a shell command on `&&`/`||`/single `|`/`;`/newline chain operators.
 * A `|` immediately preceded by `>` is the clobber-redirect operator (`>|`),
 * not a pipe, so it must not split -- otherwise `echo x >| file` gets
 * chopped into "echo x >" and "file", hiding the redirect from the
 * write-detection regex in classifyBashCommand.
 */
function segments(command) {
  return command.split(/&&|\|\||(?<!>)\||;|\n/).map((s) => s.trim());
}

/** Strip a leading path (e.g. `/usr/bin/rm` -> `rm`) for verb comparison. */
function baseName(token) {
  const parts = token.split(/[/\\]/);
  return parts[parts.length - 1];
}

// A "prefix verb" runs some OTHER command as its argument rather than
// mutating anything itself -- without unwrapping it, the real command
// hidden behind `sudo rm -rf x`, `env FOO=bar rm x`, or `xargs rm` is never
// inspected at all, and passes as if it were the harmless prefix alone.
const PREFIX_VERBS = new Set(["sudo", "env", "xargs", "command"]);

/**
 * Drops a chain of leading `VAR=value` assignments and prefix verbs (with
 * their own flags/assignments) so the REAL command a prefix verb runs is
 * what `parseSegment` resolves the verb/subcommand from.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function stripPrefixVerbs(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length && PREFIX_VERBS.has(baseName(tokens[i]))) {
    // `command -v`/`-V` looks a name up (prints its path/description) and
    // does not run it -- unlike every other use of `command` (and unlike
    // `sudo`/`env`/`xargs`), the following token is never executed, so it
    // must not be peeled off as the "real" verb.
    if (
      baseName(tokens[i]) === "command" &&
      (tokens[i + 1] === "-v" || tokens[i + 1] === "-V")
    ) {
      break;
    }
    i++;
    while (
      i < tokens.length &&
      (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
    ) {
      i++;
    }
  }
  return tokens.slice(i);
}

// Global/wrapper flags -- per verb -- that consume the FOLLOWING token as
// their value, so the walk to find the subcommand must skip both. Without
// this, `git -C /tmp commit` or `pnpm --dir ./foo add lodash` resolve `sub`
// to the flag's *value* ("/tmp", "./foo") instead of the real subcommand,
// defeating MUTATING_SUBCOMMANDS entirely (a `--flag=value` inline form
// needs no entry here -- the value stays on the same token, which
// parseSegment already skips as "starts with -").
const FLAGS_WITH_VALUE = {
  git: new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
  ]),
  pnpm: new Set(["-C", "--dir", "--filter", "--filter-prod"]),
  npm: new Set(["-C", "--prefix"]),
};

/**
 * The command verb and (for multi-word CLIs) subcommand of one shell
 * segment, skipping leading `VAR=value` environment assignments and any
 * global flags (per FLAGS_WITH_VALUE) that appear before the subcommand.
 *
 * @param {string} segment
 * @returns {{ verb: string, sub: string | undefined, tokens: string[] }}
 */
function parseSegment(segment) {
  const tokens = stripPrefixVerbs(segment.split(/\s+/).filter(Boolean));
  if (tokens.length === 0) return { verb: "", sub: undefined, tokens: [] };

  const verb = baseName(tokens[0]);
  const valueFlags = FLAGS_WITH_VALUE[verb] ?? new Set();
  let sub;
  let j = 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (valueFlags.has(t)) {
      j += 2; // skip the flag AND its value token
      continue;
    }
    if (t.startsWith("-")) {
      j += 1; // a flag that doesn't consume a following value
      continue;
    }
    sub = t;
    break;
  }
  return { verb, sub, tokens };
}

// Mutating subcommands per top-level verb (e.g. "git" -> "commit"). A verb
// that's always mutating regardless of subcommand belongs in
// MUTATING_VERBS below instead.
const MUTATING_SUBCOMMANDS = {
  git: new Set([
    "add",
    "commit",
    "push",
    "pull", // fetch + merge/rebase into the working tree
    "merge",
    "rebase",
    "cherry-pick",
    "reset",
    "checkout",
    "switch",
    "branch",
    "tag",
    "clean",
    "apply",
    "am",
    "revert",
    "restore",
    "rm",
    "mv",
    "gc",
    "worktree", // add/remove mutate the tree layout
    "config",
    "stash", // push/pop/drop/apply mutate the working tree; `stash list` is
    // read-only but the false positive here is cheap -- use `git stash
    // list` sparingly from a read-only spoke, or defer to the hub.
  ]),
  pnpm: new Set([
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "update",
    "publish",
    "version",
    "link",
    "unlink",
  ]),
  npm: new Set([
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "uninstall",
    "update",
    "publish",
    "version",
    "link",
    "unlink",
  ]),
};

// Verbs that mutate the filesystem regardless of subcommand.
const MUTATING_VERBS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "truncate",
  "dd",
  "tee",
]);

// `bash -c '...'`/`sh -c "..."` (optionally through a path like
// `/bin/bash`), capturing the quoted argument's inner content.
const SHELL_DASH_C =
  /^\s*(?:\S*\/)?(?:bash|sh)\s+(?:-\S+\s+)*-c\s+(['"])([\s\S]*)\1\s*$/;

/**
 * Classify a shell command as blocked (mutating) or allowed for a read-only
 * spoke. Denylist-based -- see the module header for the design tradeoff.
 *
 * @param {string} command
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function classifyBashCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { blocked: false };
  }

  for (const segment of segments(command)) {
    if (segment.length === 0) continue;

    // `bash -c '<command>'`/`sh -c '<command>'` runs the quoted argument as
    // its own shell command -- unwrap and recurse rather than reading only
    // the outer `bash -c` invocation, which is never itself mutating.
    const nestedShell = SHELL_DASH_C.exec(segment);
    if (nestedShell !== null) {
      const nested = classifyBashCommand(nestedShell[2]);
      if (nested.blocked) {
        return {
          blocked: true,
          reason: `runs a nested shell command via -c that ${nested.reason}`,
        };
      }
      continue;
    }

    // Write-redirection to a real file (not a discard target). No digit
    // lookbehind: `1>file`/`2>file` are ordinary fd-prefixed writes, not fd
    // duplication -- `2>&1` is excluded below because its target starts
    // with `&`, which the target class already rejects. Global flag: a
    // segment can carry more than one redirect (`cmd > /dev/null > real`),
    // and a decoy discard target must not short-circuit the scan past a
    // real one that follows it.
    for (const redirect of segment.matchAll(/(>{1,2}\|?)\s*([^\s&|;]+)/g)) {
      if (
        !/^(\/dev\/null|nul)$/i.test(redirect[2].replace(/^["']|["']$/g, ""))
      ) {
        return {
          blocked: true,
          reason: `writes to "${redirect[2]}" via shell redirection ("${redirect[0]}")`,
        };
      }
    }

    const { verb, sub, tokens } = parseSegment(segment);
    if (verb.length === 0) continue;

    if (MUTATING_VERBS.has(verb)) {
      return { blocked: true, reason: `runs "${verb}", a mutating command` };
    }

    if (
      verb === "sed" &&
      tokens.some(
        (t) => t === "-i" || t.startsWith("-i") || t.startsWith("--in-place"),
      )
    ) {
      return { blocked: true, reason: `runs "sed -i" (in-place edit)` };
    }

    if (verb === "find") {
      if (tokens.includes("-delete")) {
        return {
          blocked: true,
          reason: `runs "find ... -delete", which mutates matched files`,
        };
      }
      const execIndex = tokens.indexOf("-exec");
      if (execIndex !== -1) {
        const execVerb = baseName(tokens[execIndex + 1] ?? "");
        if (MUTATING_VERBS.has(execVerb)) {
          return {
            blocked: true,
            reason: `runs "find ... -exec ${execVerb}", which mutates matched files`,
          };
        }
      }
    }

    const mutatingSubs = MUTATING_SUBCOMMANDS[verb];
    if (
      mutatingSubs !== undefined &&
      sub !== undefined &&
      mutatingSubs.has(sub)
    ) {
      return {
        blocked: true,
        reason: `runs "${verb} ${sub}", a mutating subcommand`,
      };
    }
  }

  return { blocked: false };
}

// Deliberately inlined in every hook rather than shared: this pack's hook
// budget is exactly its three hooks, so a helper module would cost a slot.
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
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const agentType = input.agent_type;
  if (typeof agentType !== "string" || agentType.length === 0) process.exit(0);

  let readOnly;
  try {
    readOnly = readOnlyAgentNames(join(root, ".claude/agents"));
  } catch {
    process.exit(0); // can't determine the roster -> defer, don't wedge
  }
  if (!readOnly.has(agentType)) process.exit(0);

  const command = input.tool_input?.command;
  const verdict = classifyBashCommand(
    typeof command === "string" ? command : "",
  );
  if (!verdict.blocked) process.exit(0);

  process.stderr.write(`\
[guard-readonly-bash] Blocked: the "${agentType}" spoke is read-only, but this
command ${verdict.reason}.

Read-only spokes may inspect the repo but never mutate it -- that separation
is structural (CLAUDE.md § Agent Operating Model). If this command is
genuinely needed, hand the mutation back to the hub or to a writer spoke
(code-implementer / test-author) instead of running it here.
`);
  process.exit(2);
}
