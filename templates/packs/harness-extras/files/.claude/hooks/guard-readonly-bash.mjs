#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): restrict read-only spokes to non-mutating shell
 * commands. A "spoke" here is a subagent the hub dispatches a piece of work
 * to (see CLAUDE.md's Agent Operating Model); a "read-only spoke" is one
 * whose job is to inspect the repo -- review it, research it, run a
 * diagnostic -- and never change it.
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
 * `-exec sh -c '...'`. Interpreters are not inspected either: a file write
 * from inside `node -e`, `python -c`, `perl -e`, `ruby -e` or a script they
 * run passes, since recognizing it would mean parsing another language.
 * `git -c key=value`/`--config-env` is checked against GIT_EXEC_CONFIG_KEY, a
 * DENYLIST of the known command-executing config keys (pagers, editors,
 * aliases, credential helpers, textconv, ...) -- a command-running key git
 * adds later, or one not on that list, passes. Leading `VAR=value`
 * assignments ahead of `git` are likewise checked against GIT_EXEC_ENV, a
 * DENYLIST of git's own command-executing environment variables; the
 * equivalent variables of other tools (`PAGER`, `EDITOR`, `LESSOPEN`, ...)
 * are not inspected at all, nor is a variable exported earlier in the session
 * rather than on the command itself. Command substitution is only inspected
 * for a redirect inside a double-quoted `"$(...)"`/backtick span; a bare
 * `$(...)`/backtick substitution outside double quotes, `<(...)` process
 * substitution and here-strings are not recursively classified, so
 * `echo $(rm x)` passes.
 *
 * `git branch` is the one exception to the denylist design: its flag surface
 * accepts unique-prefix abbreviations (`--unset` for `--unset-upstream`) and
 * bundled/inline values (`-uorigin/main`), which no denylist of spellings can
 * keep up with, so it is judged against GIT_BRANCH_READ_FLAGS, an ALLOWLIST
 * of its read-only flags -- anything else on `git branch` blocks.
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

// A leading `VAR=value` environment assignment; group 1 is the name.
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * The index just past the `VAR=value` assignment starting at `tokens[i]`. The
 * command is split on whitespace, so a quoted value containing a space
 * (`FOO='!touch pwn1'`) spans several tokens -- consume up to the one closing
 * the quote, or the rest of the command when it never closes.
 *
 * @param {string[]} tokens
 * @param {number} i
 * @returns {number}
 */
function assignmentEnd(tokens, i) {
  const value = tokens[i].slice(tokens[i].indexOf("=") + 1);
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return i + 1;
  if (value.length > 1 && value.endsWith(quote)) return i + 1;
  let j = i + 1;
  while (j < tokens.length && !tokens[j].endsWith(quote)) j++;
  return Math.min(j + 1, tokens.length);
}

/**
 * Drops a chain of leading `VAR=value` assignments and prefix verbs (with
 * their own flags/assignments) so the REAL command a prefix verb runs is
 * what `parseTokens` resolves the verb/subcommand from. The names of every
 * stripped assignment are returned too, since an environment variable can
 * itself make the real command run something (`GIT_PAGER=sh git log`).
 *
 * @param {string[]} tokens
 * @returns {{ tokens: string[], assignments: string[] }}
 */
function stripPrefixVerbs(tokens) {
  /** @type {string[]} */
  const assignments = [];
  let i = 0;
  const skipAssignments = (allowFlags) => {
    while (i < tokens.length) {
      const name = ASSIGNMENT.exec(tokens[i])?.[1];
      if (name !== undefined) {
        assignments.push(name);
        i = assignmentEnd(tokens, i);
      } else if (allowFlags && tokens[i].startsWith("-")) {
        i++;
      } else {
        return;
      }
    }
  };
  skipAssignments(false);
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
    skipAssignments(true);
  }
  return { tokens: tokens.slice(i), assignments };
}

// Global/wrapper flags -- per verb -- that consume the FOLLOWING token as
// their value, so the walk to find the subcommand must skip both. Without
// this, `git -C /tmp commit` or `pnpm --dir ./foo add lodash` resolve `sub`
// to the flag's *value* ("/tmp", "./foo") instead of the real subcommand,
// defeating MUTATING_SUBCOMMANDS entirely (a `--flag=value` inline form
// needs no entry here -- the value stays on the same token, which
// parseTokens already skips as "starts with -").
const FLAGS_WITH_VALUE = {
  git: new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
    "--config-env",
    "--attr-source",
    "--super-prefix",
    "--list-cmds",
  ]),
  pnpm: new Set(["-C", "--dir", "--filter", "--filter-prod"]),
  npm: new Set(["-C", "--prefix"]),
  // `npx -p pkg tool` / `pnpm dlx --package pkg tool`: the package to fetch,
  // not the tool that runs.
  npx: new Set(["-p", "--package"]),
};

/**
 * Index of the first positional (non-flag) token at or after `start`,
 * skipping each flag in `valueFlags` together with its value token; -1 when
 * there is none.
 *
 * @param {string[]} tokens
 * @param {number} start
 * @param {Set<string>} valueFlags
 * @returns {number}
 */
function firstPositionalIndex(tokens, start, valueFlags) {
  let j = start;
  while (j < tokens.length) {
    const t = tokens[j];
    if (valueFlags.has(t)) {
      j += 2; // skip the flag AND its value token
    } else if (t.startsWith("-")) {
      j += 1; // a flag that doesn't consume a following value
    } else {
      return j;
    }
  }
  return -1;
}

/**
 * The command verb and (for multi-word CLIs) subcommand of an already
 * tokenized command, skipping leading `VAR=value` environment assignments
 * and any global flags (per FLAGS_WITH_VALUE) that appear before the
 * subcommand. `subIndex` is the subcommand's index in `tokens` (-1 when there
 * is none), so a caller can read its arguments as `tokens.slice(subIndex + 1)`.
 * `assignments` names every stripped environment assignment.
 *
 * @param {string[]} rawTokens
 * @returns {{ verb: string, sub: string | undefined, subIndex: number, tokens: string[], assignments: string[] }}
 */
function parseTokens(rawTokens) {
  const { tokens, assignments } = stripPrefixVerbs(rawTokens);
  if (tokens.length === 0) {
    return { verb: "", sub: undefined, subIndex: -1, tokens: [], assignments };
  }

  const verb = baseName(tokens[0]);
  const subIndex = firstPositionalIndex(
    tokens,
    1,
    FLAGS_WITH_VALUE[verb] ?? new Set(),
  );
  const sub = subIndex === -1 ? undefined : tokens[subIndex];
  return { verb, sub, subIndex, tokens, assignments };
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
    "stash", // push/pop/drop/apply mutate the working tree; the read-only
    // forms (`stash list`/`stash show`) are exempted by
    // READ_ONLY_GIT_FORMS below.
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
    "format", // the conventional formatter-write script
    "lint:fix", // the conventional lint-autofix script
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
    "format",
    "lint:fix",
  ]),
};

// The ALLOWLIST of `git branch`'s read-only flags (see the module header for
// why branch alone is allowlisted), keyed by exact flag name. `value` says
// how the flag takes an argument: "none" (no `=value` form accepted),
// "optional" (inline `--flag=value` only), or "required" (inline, or else the
// following token is consumed as its value). `pattern` marks the flags that
// put `git branch` in list mode, where a positional is a pattern to match
// rather than a branch name to create -- `-v`/`-a`/`-r` do NOT (`git branch
// -v newb` creates `newb`).
const GIT_BRANCH_READ_FLAGS = new Map(
  /** @type {[string, { value: "none" | "optional" | "required", pattern?: true }][]} */ ([
    ["--show-current", { value: "none" }],
    ["-a", { value: "none" }],
    ["--all", { value: "none" }],
    ["-r", { value: "none" }],
    ["--remotes", { value: "none" }],
    ["-v", { value: "none" }],
    ["-vv", { value: "none" }],
    ["--verbose", { value: "none" }],
    ["-i", { value: "none" }],
    ["--ignore-case", { value: "none" }],
    ["--omit-empty", { value: "none" }],
    ["--no-color", { value: "none" }],
    ["--no-column", { value: "none" }],
    ["--no-abbrev", { value: "none" }],
    ["--color", { value: "optional" }],
    ["--column", { value: "optional" }],
    ["--abbrev", { value: "optional" }],
    ["--sort", { value: "required" }],
    ["--format", { value: "required" }],
    ["--list", { value: "none", pattern: true }],
    ["-l", { value: "none", pattern: true }],
    ["--merged", { value: "optional", pattern: true }],
    ["--no-merged", { value: "optional", pattern: true }],
    ["--contains", { value: "optional", pattern: true }],
    ["--no-contains", { value: "optional", pattern: true }],
    ["--points-at", { value: "optional", pattern: true }],
  ]),
);

/**
 * Whether `git branch <args>` is read-only: every flag is on
 * GIT_BRANCH_READ_FLAGS (in a form it accepts), and there is either no
 * positional or a pattern-taking flag that makes positionals patterns.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
function isReadOnlyGitBranch(args) {
  let listMode = false;
  let positional = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (!arg.startsWith("-")) {
      positional = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const spec = GIT_BRANCH_READ_FLAGS.get(name);
    if (spec === undefined) return false; // unknown, abbreviated or bundled
    if (eq !== -1 && spec.value === "none") return false;
    if (spec.pattern === true) listMode = true;
    if (eq === -1 && spec.value === "required") k++; // consume its value
  }
  return !positional || listMode;
}

// `git -c <key>=<value>` / `--config-env=<key>=<env>` keys that make git run
// an arbitrary command (a pager, editor, alias with `!`, credential helper,
// textconv filter, ...). A DENYLIST of the known ones -- see the module
// header's accepted gaps. Matched case-insensitively, as git's keys are.
const GIT_EXEC_CONFIG_KEY =
  /^(?:.*\.pager|pager\..+|core\.(?:editor|fsmonitor|sshcommand|askpass|hookspath|gitproxy)|alias\..+|credential\.(?:.+\.)?helper|diff\.external|.*\.textconv|sequence\.editor|gpg\.(?:.+\.)?program)$/i;

/**
 * The first `-c`/`--config-env` override among git's global flags (the
 * tokens before the subcommand) whose key executes a command, or undefined.
 *
 * @param {string[]} globalTokens
 * @returns {string | undefined} the offending key
 */
function gitExecConfigKey(globalTokens) {
  for (let k = 0; k < globalTokens.length; k++) {
    const t = globalTokens[k];
    let assignment;
    if (t === "-c" || t === "--config-env") assignment = globalTokens[k + 1];
    else if (t.startsWith("--config-env=")) {
      assignment = t.slice("--config-env=".length);
    }
    if (assignment === undefined) continue;
    const key = assignment.replace(/^["']/, "").split("=")[0];
    if (GIT_EXEC_CONFIG_KEY.test(key)) return key;
  }
  return undefined;
}

// Environment variables that make git run an arbitrary command (a diff
// driver, pager, editor, ssh transport, askpass/proxy helper) or inject a
// config override the way `-c` does (GIT_CONFIG_PARAMETERS, the
// GIT_CONFIG_COUNT/KEY_n/VALUE_n triple), or point git at another program
// directory or hook template. Any value blocks -- the variable itself is the
// exec surface.
const GIT_EXEC_ENV =
  /^GIT_(?:EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|SSH|SSH_COMMAND|ASKPASS|PROXY_COMMAND|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\w+|CONFIG_VALUE_\w+|EXEC_PATH|TEMPLATE_DIR)$/;

const GIT_CONFIG_READ = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
]);
const GIT_CONFIG_WRITE = new Set([
  "--add",
  "--unset",
  "--unset-all",
  "--replace-all",
  "--edit",
  "-e",
  "--rename-section",
  "--remove-section",
]);
const GIT_TAG_DESTRUCTIVE = new Set([
  "-d",
  "--delete",
  "-a",
  "-s",
  "-f",
  "-m",
  "-u",
  "--annotate",
  "--sign",
  "--force",
]);

/** Whether any argument is a positional (not a flag). */
function hasPositional(args) {
  return args.some((a) => !a.startsWith("-"));
}

// Git subcommands in MUTATING_SUBCOMMANDS that also have a purely read-only
// form, keyed by subcommand: each predicate takes the subcommand's arguments
// and returns true only for that read-only form. Anything else falls through
// to the MUTATING_SUBCOMMANDS block, so an unrecognized flag still blocks.
const READ_ONLY_GIT_FORMS = {
  branch: isReadOnlyGitBranch,
  worktree: (args) => args[0] === "list",
  stash: (args) => args[0] === "list" || args[0] === "show",
  config: (args) =>
    args.some((a) => GIT_CONFIG_READ.has(a)) &&
    !args.some((a) => GIT_CONFIG_WRITE.has(a)),
  tag: (args) =>
    !args.some((a) => GIT_TAG_DESTRUCTIVE.has(a)) &&
    (!hasPositional(args) || args.includes("-l") || args.includes("--list")),
};

/**
 * Whether a formatter/linter invocation writes files: `prettier --write`/`-w`
 * or `eslint --fix`/`--fix-*`. Any other tool returns undefined.
 *
 * @param {string} verb
 * @param {string[]} tokens
 * @returns {string | undefined} the offending flag, or undefined
 */
function fixerWriteFlag(verb, tokens) {
  if (verb === "prettier") {
    return tokens.find((t) => t === "--write" || t === "-w");
  }
  if (verb === "eslint") {
    return tokens.find((t) => t === "--fix" || t.startsWith("--fix-"));
  }
  return undefined;
}

// Conventional lint/format script names (run via `pnpm <script>`/`pnpm run
// <script>`/`npm run <script>`) that forward trailing args to a fixer-capable
// tool, and the fixer flags that make one of them rewrite files.
const FIXER_SCRIPTS = new Set([
  "lint",
  "eslint",
  "prettier",
  "format",
  "lint:fix",
]);
const FIXER_FLAG = /^(?:--fix(?:-.*)?|--write|-w)$/;

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
    //
    // Quoted spans are blanked first unless they ARE a redirect's target, so
    // a `>` inside a quoted argument (`grep "=> {" src`, `--format="%h > %s"`)
    // is not mistaken for a redirect, while `echo x > "out.txt"` keeps its
    // quoted target and is classified exactly as an unquoted one. Quotes are
    // paired the way a POSIX shell pairs them: a backslash-escaped quote
    // outside quotes (`\"`) is a literal and opens nothing, `\"` inside double
    // quotes does not close them, and a backslash inside single quotes is
    // literal. An unbalanced quote is left un-blanked (fail closed).
    //
    // Two cases skip blanking, also failing closed. A double-quoted span
    // holding a `$(...)`/backtick command substitution is kept, since the
    // shell still runs the substitution -- a `>` inside it is a real redirect
    // (`echo "$(date > out)"`). And a segment using `$'...'` ANSI-C quoting is
    // not blanked at all: its `\'` escape pairs differently from a plain
    // single quote, so the pairing above would desync and swallow a real
    // redirect that follows (`echo $'\'' > out #'`).
    const scan = segment.includes("$'")
      ? segment
      : segment.replace(
          /(>{1,2}\|?\s*)?(?<!\\)(?:'[^']*'|"(?:\\[\s\S]|[^\\"])*")/g,
          (match, redirectOp) =>
            redirectOp !== undefined ||
            (match[0] === '"' && /\$\(|`/.test(match))
              ? match
              : `${match[0]}${match[0]}`,
        );
    for (const redirect of scan.matchAll(/(>{1,2}\|?)\s*([^\s&|;]+)/g)) {
      if (
        !/^(\/dev\/null|nul)$/i.test(redirect[2].replace(/^["']|["']$/g, ""))
      ) {
        return {
          blocked: true,
          reason: `writes to "${redirect[2]}" via shell redirection ("${redirect[0]}")`,
        };
      }
    }

    const verdict = classifyTokens(segment.split(/\s+/).filter(Boolean));
    if (verdict !== undefined) return verdict;
  }

  return { blocked: false };
}

/**
 * Where a tool wrapper's own arguments start, or -1 when `verb`/`sub` is not
 * one: `npx`/`pnpx [-p pkg] <tool>`, `pnpm dlx`/`pnpm exec <tool>` and
 * `npm exec`/`npm x <tool>`.
 *
 * @param {string} verb
 * @param {string | undefined} sub
 * @param {number} subIndex
 * @returns {number}
 */
function wrappedToolStart(verb, sub, subIndex) {
  if (verb === "npx" || verb === "pnpx") return 1;
  if (verb === "pnpm" && (sub === "dlx" || sub === "exec")) {
    return subIndex + 1;
  }
  if (verb === "npm" && (sub === "exec" || sub === "x")) return subIndex + 1;
  return -1;
}

/**
 * The command-level checks for one tokenized segment (everything except the
 * redirect scan, which needs the raw segment text). A tool wrapper (see
 * wrappedToolStart) recurses on `<tool> ...`, so a wrapped fixer is caught the
 * same as a bare one; `inherited` carries the environment assignments stripped
 * ahead of the wrapper, which the wrapped tool still sees.
 *
 * @param {string[]} rawTokens
 * @param {readonly string[]} [inherited]
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifyTokens(rawTokens, inherited = []) {
  const parsed = parseTokens(rawTokens);
  const { verb, sub, subIndex, tokens } = parsed;
  const assignments = [...inherited, ...parsed.assignments];
  if (verb.length === 0) return undefined;

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

  const writeFlag = fixerWriteFlag(verb, tokens);
  if (writeFlag !== undefined) {
    return {
      blocked: true,
      reason: `runs "${verb} ${writeFlag}", which rewrites files`,
    };
  }

  // A wrapper that runs another tool -- judge `<tool> ...` itself. Its own
  // flags, a `--` separator included, are skipped to reach the tool.
  const wrapperEnd = wrappedToolStart(verb, sub, subIndex);
  if (wrapperEnd !== -1) {
    const toolIndex = firstPositionalIndex(
      tokens,
      wrapperEnd,
      FLAGS_WITH_VALUE.npx,
    );
    return toolIndex === -1
      ? undefined
      : classifyTokens(tokens.slice(toolIndex), assignments);
  }
  if (verb === "pnpm" && (sub === "eslint" || sub === "prettier")) {
    return classifyTokens(tokens.slice(subIndex), assignments);
  }

  if (verb === "git") {
    const envVar = assignments.find((name) => GIT_EXEC_ENV.test(name));
    if (envVar !== undefined) {
      return {
        blocked: true,
        reason: `sets ${envVar}, which makes git run an arbitrary command`,
      };
    }
    const key = gitExecConfigKey(
      tokens.slice(1, subIndex === -1 ? undefined : subIndex),
    );
    if (key !== undefined) {
      return {
        blocked: true,
        reason: `overrides git config "${key}", which runs an arbitrary command`,
      };
    }
  }

  const mutatingSubs = MUTATING_SUBCOMMANDS[verb];
  if (mutatingSubs === undefined || sub === undefined) return undefined;
  const args = tokens.slice(subIndex + 1);

  if (verb === "git" && READ_ONLY_GIT_FORMS[sub]?.(args) === true) {
    return undefined;
  }

  // `pnpm run <script>`/`npm run <script>`: the script name is what runs, so
  // classify it as the subcommand (`run format` blocks, `run format:check`
  // does not). Its own value flags (`run --filter x format`) are skipped.
  const scriptIndex =
    (verb === "pnpm" || verb === "npm") && sub === "run"
      ? firstPositionalIndex(tokens, subIndex + 1, FLAGS_WITH_VALUE[verb])
      : subIndex;
  if (scriptIndex === -1) return undefined;
  const script = tokens[scriptIndex];
  const shown = sub === script ? sub : `run ${script}`;
  if (mutatingSubs.has(script)) {
    return {
      blocked: true,
      reason: `runs "${verb} ${shown}", a mutating subcommand`,
    };
  }

  // A lint/format script handed a fixer flag (`pnpm lint --fix`, `pnpm run
  // lint -- --fix`) forwards it to the tool, which then rewrites files.
  if (FIXER_SCRIPTS.has(script)) {
    const fixFlag = tokens
      .slice(scriptIndex + 1)
      .find((t) => FIXER_FLAG.test(t));
    if (fixFlag !== undefined) {
      return {
        blocked: true,
        reason: `runs "${verb} ${shown} ${fixFlag}", which rewrites files`,
      };
    }
  }
  return undefined;
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
