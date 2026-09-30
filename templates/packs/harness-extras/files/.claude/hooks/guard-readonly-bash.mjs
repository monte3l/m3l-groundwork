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
 * flag's value as the verb, missing the real command. A nested shell's `-c`
 * command string (standalone `-c` or a short-option cluster like `-lc`) is
 * unwrapped and classified recursively wherever the verb resolves to a shell
 * -- behind `sudo`/`env`/`xargs`/`command`, leading `VAR=value` assignments,
 * or `npx`/`pnpm exec`/`pnpm dlx`/`npm exec` (whose own shell-mode flags,
 * `-c`/`--call`/`--shell-mode`, are unwrapped the same way) -- but only for
 * the shells `bash sh zsh dash ksh`; `eval`, `busybox sh` and a shell reached
 * through an unrecognized wrapper (`nice`, `nohup`, `timeout`, `xargs -I{}`,
 * ...) are not unwrapped unless listed -- `time` is the one such wrapper
 * stripped, alongside the leading reserved words `if then else elif do while
 * until ! {` and a glued `(`/`{`. Beyond that strip, shell grammar is not
 * modelled: a `case ... esac` body (`pat) rm x ;;` resolves `pat)` as the
 * verb), a function definition or call (`f() { rm x; }; f`) and an alias run
 * whatever they wrap unseen. A wrapper's "tool" word that holds whitespace
 * once unquoted (`npx "rm -rf src"`) is judged as a command string. Every word is unquoted
 * the way the shell would before it is compared (`"rm"`, `r\m` and `git
 * "commit"` match as `rm`/`git commit`); a verb or subcommand word, or a
 * nested command string, that uses `$'...'` ANSI-C quoting or whose quote
 * never closes blocks rather than being decoded. `find`'s `-exec` check only
 * inspects the immediate next token, missing `-execdir`/`-ok` and a chained
 * `-exec sh -c '...'`. Interpreters are not inspected either: a file write
 * from inside `node -e`, `python -c`, `perl -e`, `ruby -e` or a script they
 * run passes, since recognizing it would mean parsing another language.
 * `git -c key=value`/`--config-env` is checked against GIT_EXEC_CONFIG_KEY, a
 * DENYLIST of the known command-executing config keys (pagers, editors,
 * aliases, credential helpers, textconv, ...) -- a command-running key git
 * adds later, or one not on that list, passes; `include.path`/
 * `includeIf.<cond>.path` and the `GIT_CONFIG*` file-swapping variables block,
 * but a config FILE the user already controls (the repo's `.git/config`,
 * `~/.gitconfig`) can still set an exec key and is never read. Leading `VAR=value`
 * assignments ahead of `git` are likewise checked against GIT_EXEC_ENV, a
 * DENYLIST of git's own command-executing environment variables; the
 * equivalent variables of other tools (`PAGER`, `EDITOR`, `LESSOPEN`, ...)
 * are not inspected at all, nor is a variable exported earlier in the session
 * rather than on the command itself. Command substitution is only inspected
 * for a redirect inside a double-quoted `"$(...)"`/backtick span; a bare
 * `$(...)`/backtick substitution outside double quotes, `<(...)` process
 * substitution and here-strings are not recursively classified, so
 * `echo $(rm x)` passes. Chain operators (`&&`, `||`, `|`, `&`, `;`, newline)
 * inside a quoted string do not split the command; a `bash -c '...'` payload
 * therefore stays one segment and is re-split, with the same quote-aware
 * rules, when it is classified recursively. The exec-config-key list stays a
 * denylist even after its extension to drivers, filters and tool commands.
 *
 * `git branch` and `git tag` are the exceptions to the denylist design: their
 * flag surfaces accept unique-prefix abbreviations (`--unset` for
 * `--unset-upstream`), bundled/inline values (`-uorigin/main`) and
 * value-taking flags whose separated value can look like a list flag (`git tag
 * --format -l v2` creates `v2`), which no denylist of spellings can keep up
 * with, so each is judged against an ALLOWLIST of its read-only flags
 * (GIT_BRANCH_READ_FLAGS, GIT_TAG_READ_FLAGS) -- anything else blocks.
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
 * The length of the chain operator (`&&`, `||`, `|`, `&`, `;`, newline)
 * starting at `command[i]`, or 0 when there is none. A `|` immediately
 * preceded by `>` is the clobber-redirect operator (`>|`), not a pipe --
 * splitting it would chop `echo x >| file` into "echo x >" and "file", hiding
 * the redirect. Likewise a lone `&` is the background operator (which runs
 * the next command too) except where it belongs to a redirect: fd duplication
 * (`2>&1`, `>&2`, `<&3`) or the `&>`/`&>>` both-streams redirect.
 *
 * @param {string} command
 * @param {number} i
 * @returns {number}
 */
function chainOperatorLength(command, i) {
  const c = command[i];
  const next = command[i + 1];
  if ((c === "&" && next === "&") || (c === "|" && next === "|")) return 2;
  if (c === "|") return command[i - 1] === ">" ? 0 : 1;
  if (c === "&") {
    const prev = command[i - 1];
    return prev === ">" || prev === "<" || next === ">" ? 0 : 1;
  }
  return c === ";" || c === "\n" ? 1 : 0;
}

/**
 * Split `command` at every boundary `boundaryAt(command, i)` reports (the
 * boundary's length, 0 for none) that does not sit inside a quoted string.
 * Quotes pair the way a POSIX shell pairs them -- the same rules the redirect
 * scan in classifyBashCommand uses: a backslash outside single quotes escapes
 * the next character (so `\"` opens nothing and `"\""` stays open), a
 * backslash inside single quotes is literal, and `$'...'` honors `\'`.
 * Returns undefined when a quote never closes, so each caller can pick its own
 * fail-closed fallback.
 *
 * @param {string} command
 * @param {(command: string, i: number) => number} boundaryAt
 * @returns {string[] | undefined}
 */
function splitUnquoted(command, boundaryAt) {
  /** @type {string[]} */
  const parts = [];
  let start = 0;
  /** @type {"'" | '"' | "$'" | undefined} */
  let quote;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (c === "\\") {
      i++; // escapes the next character (outside single quotes)
    } else if (quote !== undefined) {
      if (c === quote.at(-1)) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "$" && command[i + 1] === "'") {
      quote = "$'";
      i++;
    } else {
      const length = boundaryAt(command, i);
      if (length > 0) {
        parts.push(command.slice(start, i));
        i += length - 1;
        start = i + 1;
      }
    }
  }
  if (quote !== undefined) return undefined;
  parts.push(command.slice(start));
  return parts;
}

/**
 * Segment a shell command on its `&&`/`||`/`|`/`&`/`;`/newline chain operators,
 * ignoring any that sit inside a quoted string (`grep -E "a|b"`, `bash -c
 * 'x; y'`) -- see splitUnquoted. An unbalanced quote falls back to splitting
 * on every operator regardless of quoting (fail closed: an unterminated quote
 * must not hide a real chain).
 *
 * @param {string} command
 * @returns {string[]}
 */
function segments(command) {
  const parts =
    splitUnquoted(command, chainOperatorLength) ??
    command.split(/&&|\|\||(?<!>)\||(?<![<>])&(?!>)|;|\n/);
  return parts.map((s) => s.trim());
}

/**
 * Split one segment into its shell words on unquoted whitespace, keeping each
 * quoted span (quotes included) inside a single token, so `bash -c 'rm -rf
 * src'`'s payload is one token with its original whitespace intact. An
 * unbalanced quote falls back to a plain whitespace split.
 *
 * @param {string} segment
 * @returns {string[]}
 */
function words(segment) {
  const parts =
    splitUnquoted(segment, (s, i) => (/\s/.test(s[i]) ? 1 : 0)) ??
    segment.split(/\s+/);
  return parts.filter(Boolean);
}

/**
 * The value a shell gives one word (see `words`), with its quoting removed:
 * single quotes are literal, double quotes honor a backslash only before `$`,
 * a backtick, `"`, `\` or a newline, and an unquoted backslash escapes the
 * next character. Undefined when a quote never closes, or when the word uses
 * `$'...'` ANSI-C quoting, whose escapes (`\n`, `\x3e`, ...) can produce chain
 * operators and redirects this guard does not decode -- the caller fails
 * closed on undefined.
 *
 * @param {string} word
 * @returns {string | undefined}
 */
function shellWordValue(word) {
  if (word.includes("$'")) return undefined;
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      if (end === -1) return undefined;
      out += word.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < word.length && word[j] !== '"'; j++) {
        if (word[j] === "\\" && j + 1 < word.length) {
          if ('$`"\\\n'.includes(word[j + 1])) j++;
        }
        out += word[j];
      }
      if (j >= word.length) return undefined;
      i = j;
    } else if (c === "\\") {
      i++;
      out += word[i] ?? "";
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * One shell word: `raw` is its source text (quotes included), `value` what the
 * shell makes of it (shellWordValue) -- undefined when it cannot be read.
 * Every verb/subcommand/flag comparison uses `value` (or `raw` when there is
 * none), so `"rm" x`, `r\m x` and `git "commit"` match exactly as bash runs
 * them; `raw` is kept for the things quoting itself decides: whether a word is
 * a `VAR=value` assignment, and a nested `-c` payload, which is re-parsed.
 *
 * @typedef {{ raw: string, value: string | undefined }} Word
 */

/** @param {string} raw @returns {Word} */
function toWord(raw) {
  return { raw, value: shellWordValue(raw) };
}

/** The text a word is matched by: its unquoted value, else its raw text. */
function wordText(word) {
  return word.value ?? word.raw;
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

// Shell reserved words (and `time`, a keyword in bash/zsh) that can sit in
// front of the command a segment actually runs -- `do rm x`, `then rm x`,
// `! rm x`, `{ rm x`, `time rm x`. `segments` already splits on `;`/newline,
// so each of these is the first word of the segment holding its command.
const LEADING_RESERVED_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "time",
]);

// Reserved words opening a segment that names no command at all: the `for
// NAME in WORDS` / `select NAME in WORDS` / `case WORD in` header. The body
// that follows (`do ...`, `pattern) ...`) is its own segment.
const HEADER_RESERVED_WORDS = new Set(["for", "select", "case"]);

/**
 * Drops a chain of leading shell reserved words/grouping tokens
 * (LEADING_RESERVED_WORDS, a `(`/`{` glued to the first word, `time`'s own
 * flags), `VAR=value` assignments and prefix verbs (with their own
 * flags/assignments) so the REAL command is what `parseTokens` resolves the
 * verb/subcommand from. A `for`/`select`/`case` header runs nothing and
 * resolves to no words. The names of every stripped assignment are returned
 * too, since an environment variable can itself make the real command run
 * something (`GIT_PAGER=sh git log`).
 *
 * An assignment is recognized from the RAW word, as the shell does (a quoted
 * `"FOO=1"` is a command name, not an assignment); reserved words, prefix
 * verbs and their flags are matched by their unquoted text.
 *
 * @param {Word[]} input
 * @returns {{ words: Word[], assignments: string[] }}
 */
function stripPrefixVerbs(input) {
  /** @type {string[]} */
  const assignments = [];
  const words = [...input];
  const raw = (k) => words[k].raw;
  const text = (k) => wordText(words[k]);
  let i = 0;
  const skipAssignments = (allowFlags) => {
    while (i < words.length) {
      const name = ASSIGNMENT.exec(raw(i))?.[1];
      if (name !== undefined) {
        assignments.push(name);
        i = assignmentEnd(
          words.map((w) => w.raw),
          i,
        );
      } else if (allowFlags && text(i).startsWith("-")) {
        i++;
      } else {
        return;
      }
    }
  };
  const skipReserved = () => {
    while (i < words.length) {
      const glued = /^[({]+/.exec(raw(i))?.[0];
      if (glued !== undefined) {
        const rest = raw(i).slice(glued.length);
        if (rest === "") i++;
        else words[i] = toWord(rest);
      } else if (LEADING_RESERVED_WORDS.has(text(i))) {
        const isTime = text(i) === "time";
        i++;
        if (isTime) while (i < words.length && text(i).startsWith("-")) i++;
      } else {
        return;
      }
    }
  };
  for (;;) {
    const start = i;
    skipReserved();
    if (i < words.length && HEADER_RESERVED_WORDS.has(text(i))) {
      return { words: [], assignments };
    }
    skipAssignments(false);
    if (i < words.length && PREFIX_VERBS.has(baseName(text(i)))) {
      // `command -v`/`-V` looks a name up (prints its path/description) and
      // does not run it -- unlike every other use of `command` (and unlike
      // `sudo`/`env`/`xargs`), the following token is never executed, so it
      // must not be peeled off as the "real" verb.
      const next = i + 1 < words.length ? text(i + 1) : undefined;
      if (baseName(text(i)) === "command" && (next === "-v" || next === "-V")) {
        break;
      }
      i++;
      skipAssignments(true);
    }
    if (i === start) break;
  }
  return { words: words.slice(i), assignments };
}

/**
 * Drop a subshell's closing `)` glued to a segment's last word (`(git
 * commit)` -> `git commit`), so it cannot defeat a verb/subcommand match. Only
 * surplus `)` are dropped -- a balanced `$(date)` is left intact -- and a word
 * that is nothing but `)` disappears.
 *
 * @param {Word[]} list
 * @returns {Word[]}
 */
function stripClosingParens(list) {
  const last = list.at(-1);
  if (last === undefined) return list;
  let end = last.raw;
  const opens = (end.match(/\(/g) ?? []).length;
  while (
    end.endsWith(")") &&
    !end.endsWith("\\)") &&
    (end.match(/\)/g) ?? []).length > opens
  ) {
    end = end.slice(0, -1);
  }
  if (end === last.raw) return list;
  const head = list.slice(0, -1);
  return end === "" ? head : [...head, toWord(end)];
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
  pnpm: new Set(["-C", "--dir", "-F", "--filter", "--filter-prod"]),
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
 * `assignments` names every stripped environment assignment. `tokens` holds
 * each remaining word's matching text (wordText), index-aligned with `words`.
 *
 * @param {Word[]} rawWords
 * @returns {{ verb: string, sub: string | undefined, subIndex: number, words: Word[], tokens: string[], assignments: string[] }}
 */
function parseTokens(rawWords) {
  const { words, assignments } = stripPrefixVerbs(rawWords);
  const tokens = words.map(wordText);
  if (tokens.length === 0) {
    return {
      verb: "",
      sub: undefined,
      subIndex: -1,
      words,
      tokens,
      assignments,
    };
  }

  const verb = baseName(tokens[0]);
  const subIndex = firstPositionalIndex(
    tokens,
    1,
    FLAGS_WITH_VALUE[verb] ?? new Set(),
  );
  const sub = subIndex === -1 ? undefined : tokens[subIndex];
  return { verb, sub, subIndex, words, tokens, assignments };
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

/** @typedef {{ value: "none" | "optional" | "required", pattern?: true }} ReadFlagSpec */

// The ALLOWLISTS of `git branch`'s and `git tag`'s read-only flags (see the
// module header for why these two are allowlisted), keyed by exact flag name.
// `value` says how the flag takes an argument: "none" (no `=value` form
// accepted), "optional" (inline `--flag=value` only), or "required" (inline,
// or else the following token is consumed as its value). `pattern` marks the
// flags that put the command in list mode, where a positional is a pattern to
// match rather than a name to create -- `-v`/`-a`/`-r` do NOT (`git branch -v
// newb` creates `newb`).
const GIT_BRANCH_READ_FLAGS = new Map(
  /** @type {[string, ReadFlagSpec][]} */ ([
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

// `git tag`'s counterpart of GIT_BRANCH_READ_FLAGS. `-n` also accepts attached
// digits (`-n3`), normalized to `-n` before lookup by isReadOnlyGitTag; it
// implies list mode, so a following positional is a pattern.
const GIT_TAG_READ_FLAGS = new Map(
  /** @type {[string, ReadFlagSpec][]} */ ([
    ["-n", { value: "none", pattern: true }],
    ["-i", { value: "none" }],
    ["--ignore-case", { value: "none" }],
    ["--omit-empty", { value: "none" }],
    ["--no-color", { value: "none" }],
    ["--no-column", { value: "none" }],
    ["--color", { value: "optional" }],
    ["--column", { value: "optional" }],
    ["--sort", { value: "required" }],
    ["--format", { value: "required" }],
    ["-l", { value: "none", pattern: true }],
    ["--list", { value: "none", pattern: true }],
    ["--contains", { value: "optional", pattern: true }],
    ["--no-contains", { value: "optional", pattern: true }],
    ["--merged", { value: "optional", pattern: true }],
    ["--no-merged", { value: "optional", pattern: true }],
    ["--points-at", { value: "required", pattern: true }],
  ]),
);

/**
 * Whether `<args>` is a read-only invocation per the flag allowlist `table`:
 * every flag is on it (in a form it accepts), and there is either no
 * positional or a pattern-taking flag that makes positionals patterns. A
 * "required"-value flag given without `=` consumes the next token, so that
 * value can never be mistaken for a flag (`--format -l v2` is create mode).
 *
 * @param {Map<string, ReadFlagSpec>} table
 * @param {string[]} args
 * @returns {boolean}
 */
function isReadOnlyByFlagTable(table, args) {
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
    const spec = table.get(name);
    if (spec === undefined) return false; // unknown, abbreviated or bundled
    if (eq !== -1 && spec.value === "none") return false;
    if (spec.pattern === true) listMode = true;
    if (eq === -1 && spec.value === "required") k++; // consume its value
  }
  return !positional || listMode;
}

/** `git branch <args>` is read-only, per GIT_BRANCH_READ_FLAGS. */
function isReadOnlyGitBranch(args) {
  return isReadOnlyByFlagTable(GIT_BRANCH_READ_FLAGS, args);
}

/** `git tag <args>` is read-only, per GIT_TAG_READ_FLAGS (`-n3` -> `-n`). */
function isReadOnlyGitTag(args) {
  return isReadOnlyByFlagTable(
    GIT_TAG_READ_FLAGS,
    args.map((a) => (/^-n\d+$/.test(a) ? "-n" : a)),
  );
}

// `git -c <key>=<value>` / `--config-env=<key>=<env>` keys that make git run
// an arbitrary command (a pager, editor, alias with `!`, credential helper,
// textconv filter, diff/merge driver, clean/smudge filter, upload-pack
// override, difftool/mergetool/browser/man viewer command, ...). A DENYLIST
// of the known ones -- see the module header's accepted gaps. Matched
// case-insensitively, as git's keys are.
const GIT_EXEC_CONFIG_KEY = new RegExp(
  `^(?:${[
    String.raw`.*\.pager`,
    String.raw`pager\..+`,
    String.raw`core\.(?:editor|fsmonitor|sshcommand|askpass|hookspath|gitproxy)`,
    String.raw`alias\..+`,
    String.raw`credential\.(?:.+\.)?helper`,
    String.raw`diff\.external`,
    String.raw`diff\..+\.command`,
    String.raw`.*\.textconv`,
    String.raw`filter\..+\.(?:clean|smudge|process)`,
    String.raw`merge\..+\.driver`,
    String.raw`remote\..+\.(?:uploadpack|receivepack|proxy|vcs)`,
    String.raw`(?:diff|merge)tool\..+\.cmd`,
    String.raw`web\.browser`,
    String.raw`browser\..+\.cmd`,
    String.raw`man\..+\.cmd`,
    String.raw`sequence\.editor`,
    String.raw`gpg\.(?:.+\.)?program`,
    // Not an exec key itself, but pulls in an arbitrary config file that can
    // set any of the keys above.
    String.raw`include(?:if\..+)?\.path`,
  ].join("|")})$`,
  "i",
);

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
// directory or hook template, or swap in another config file wholesale
// (GIT_CONFIG, GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_NOSYSTEM), which can set
// any exec key. Any value blocks -- the variable itself is the exec surface.
const GIT_EXEC_ENV =
  /^GIT_(?:EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|SSH|SSH_COMMAND|ASKPASS|PROXY_COMMAND|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\w+|CONFIG_VALUE_\w+|EXEC_PATH|TEMPLATE_DIR)$/;

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
// Git subcommands in MUTATING_SUBCOMMANDS that also have a purely read-only
// form, keyed by subcommand: each predicate takes the subcommand's arguments
// and returns true only for that read-only form. Anything else falls through
// to the MUTATING_SUBCOMMANDS block, so an unrecognized flag still blocks.
const READ_ONLY_GIT_FORMS = {
  branch: isReadOnlyGitBranch,
  worktree: (args) => args[0] === "list",
  stash: (args) => args[0] === "list" || args[0] === "show",
  // The legacy read flags (`--get`, `--list`, ...) or git >= 2.46's `get`/
  // `list` subcommands; its `set`/`unset`/`edit`/... subcommands and the
  // legacy `git config <name> <value>` write form still block.
  config: (args) =>
    (args[0] === "get" ||
      args[0] === "list" ||
      args.some((a) => GIT_CONFIG_READ.has(a))) &&
    !args.some((a) => GIT_CONFIG_WRITE.has(a)),
  tag: isReadOnlyGitTag,
};

// ESLint's one writing flag: `--fix` (or `--fix=<bool>`). `--fix-dry-run`
// only reports, and `--fix-type` merely narrows what a `--fix` would touch.
const ESLINT_FIX = /^--fix(?:=.*)?$/;

/**
 * Whether a formatter/linter invocation writes files: `prettier --write`/`-w`
 * or `eslint --fix`. Any other tool returns undefined.
 *
 * @param {string} verb
 * @param {string[]} tokens
 * @returns {string | undefined} the offending flag, or undefined
 */
function fixerWriteFlag(verb, tokens) {
  if (verb === "prettier") {
    return tokens.find((t) => t === "--write" || t === "-w");
  }
  if (verb === "eslint") return tokens.find((t) => ESLINT_FIX.test(t));
  return undefined;
}

// A package spec pinned to a version or dist-tag (`prettier@3`,
// `@scope/tool@latest`); group 1 is the bare package name, scope kept.
const PINNED_PACKAGE = /^(@[^/@]+\/[^@]+|[^@]+)@[^/]+$/;

/**
 * The tool a wrapper runs, with any `@<version>` pin stripped, so a pinned
 * `prettier@3` is judged as `prettier`. A scoped name keeps its scope.
 *
 * @param {string} spec
 * @returns {string}
 */
function unpinnedToolName(spec) {
  return PINNED_PACKAGE.exec(spec)?.[1] ?? spec;
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
const FIXER_FLAG = /^(?:--fix(?:=.*)?|--write|-w)$/;

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

// Shells whose `-c <command>` is unwrapped wherever a verb resolves to one --
// behind a prefix verb, an env assignment or a tool wrapper -- and the shell
// options that consume the following token as their value.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTIONS = new Set([
  "-o",
  "+o",
  "-O",
  "+O",
  "--rcfile",
  "--init-file",
]);

// A tool wrapper's own flags that run their value(s) as a shell command
// (`npx -c '<cmd>'`, `npm exec --call '<cmd>'`, `pnpm exec --shell-mode
// <cmd>`), keyed by wrapper verb.
const NPX_SHELL_FLAGS = new Set(["-c", "--call"]);
const WRAPPER_SHELL_FLAGS = {
  npx: NPX_SHELL_FLAGS,
  pnpx: NPX_SHELL_FLAGS,
  npm: NPX_SHELL_FLAGS,
  pnpm: new Set(["-c", "--shell-mode"]),
};

/**
 * For a shell invocation (`tokens[0]` is the shell), the index of the command
 * string its `-c` option runs -- `-c` alone or inside a short-option cluster
 * (`-lc`, `-ec`) -- which is the first operand after the options. -1 when no
 * `-c` is given (a script or an interactive shell); `tokens.length` when `-c`
 * is given but no operand follows.
 *
 * @param {string[]} tokens
 * @returns {number}
 */
function shellCommandIndex(tokens) {
  let dashC = false;
  for (let j = 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === "--" || t === "-") return dashC ? j + 1 : -1;
    if (SHELL_VALUE_OPTIONS.has(t)) {
      j++; // skip the option's value
    } else if (/^[-+]/.test(t)) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) dashC = true;
    } else {
      return dashC ? j : -1;
    }
  }
  return dashC ? tokens.length : -1;
}

/**
 * Classify a nested shell command given as shell words (see `words`), which a
 * shell or wrapper `via` runs: each word's unquoted value is joined and the
 * result classified recursively with classifyBashCommand. Fails closed --
 * blocks -- when there is no word or one cannot be read.
 *
 * @param {string} via e.g. `bash -c`, `npx -c`
 * @param {Word[]} payloadWords
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifyNestedCommand(via, payloadWords) {
  const values = payloadWords.map((w) => w.value);
  if (values.length === 0 || values.includes(undefined)) {
    return {
      blocked: true,
      reason: `runs a nested shell command via ${via} whose command string could not be read`,
    };
  }
  const nested = classifyBashCommand(values.join(" "));
  if (!nested.blocked) return undefined;
  return {
    blocked: true,
    reason: `runs a nested shell command via ${via} that ${nested.reason}`,
  };
}

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
    // duplication -- `2>&1` is excluded below as a `>&` operator whose target
    // is a digit string (see the `>&word` note). Global flag: a
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
          /(>{1,2}[|&]?\s*)?(?<!\\)(?:'[^']*'|"(?:\\[\s\S]|[^\\"])*")/g,
          (match, redirectOp) =>
            redirectOp !== undefined ||
            (match[0] === '"' && /\$\(|`/.test(match))
              ? match
              : `${match[0]}${match[0]}`,
        );
    //
    // `>&word` is fd duplication only when `word` is a digit string or `-`
    // (`>&2`, `2>&1`, `>&-`); any other word is a FILE both stdout and stderr
    // are written to (`>&out.txt`, `>& out.txt`), so that form is matched as
    // its own operator and its target examined like any other.
    for (const redirect of scan.matchAll(/(>&|>{1,2}\|?)\s*([^\s&|;]+)/g)) {
      const target = redirect[2].replace(/^["']|["']$/g, "");
      if (redirect[1] === ">&" && /^(?:\d+|-)$/.test(target)) continue;
      if (!/^(\/dev\/null|nul)$/i.test(target)) {
        return {
          blocked: true,
          reason: `writes to "${redirect[2]}" via shell redirection ("${redirect[0]}")`,
        };
      }
    }

    const verdict = classifyTokens(
      stripClosingParens(words(segment).map(toWord)),
    );
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

// `npm exec`'s own value flags on top of npm's global ones: the workspace to
// run in and the package to fetch, neither of them the tool that runs.
const NPM_EXEC_FLAGS_WITH_VALUE = new Set([
  ...FLAGS_WITH_VALUE.npm,
  "-w",
  "--workspace",
  "-p",
  "--package",
]);

/**
 * The value-taking flags of a tool wrapper (see wrappedToolStart), keyed by
 * its own verb -- `pnpm exec --filter x <tool>` must skip `x` by pnpm's
 * table, which npx's does not know.
 *
 * @param {string} verb
 * @returns {Set<string>}
 */
function wrapperValueFlags(verb) {
  switch (verb) {
    case "pnpm":
      return FLAGS_WITH_VALUE.pnpm;
    case "npm":
      return NPM_EXEC_FLAGS_WITH_VALUE;
    default:
      return FLAGS_WITH_VALUE.npx;
  }
}

/**
 * The command-level checks for one tokenized segment (everything except the
 * redirect scan, which needs the raw segment text). A tool wrapper (see
 * wrappedToolStart) recurses on `<tool> ...`, so a wrapped fixer is caught the
 * same as a bare one; `inherited` carries the environment assignments stripped
 * ahead of the wrapper, which the wrapped tool still sees. A verb word (or,
 * for a verb with MUTATING_SUBCOMMANDS, a subcommand word) that cannot be
 * unquoted -- `$'...'` ANSI-C quoting or a quote that never closes -- blocks,
 * since the command it names is unknown.
 *
 * @param {Word[]} rawWords
 * @param {readonly string[]} [inherited]
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifyTokens(rawWords, inherited = []) {
  const parsed = parseTokens(rawWords);
  const { verb, sub, subIndex, words, tokens } = parsed;
  const assignments = [...inherited, ...parsed.assignments];
  if (tokens.length === 0) return undefined;
  const unreadable =
    words[0].value === undefined
      ? words[0]
      : subIndex !== -1 &&
          MUTATING_SUBCOMMANDS[verb] !== undefined &&
          words[subIndex].value === undefined
        ? words[subIndex]
        : undefined;
  if (unreadable !== undefined) {
    return {
      blocked: true,
      reason: `runs a command word (${unreadable.raw}) whose quoting could not be read`,
    };
  }
  if (verb.length === 0) return undefined;

  if (SHELLS.has(verb)) {
    const commandIndex = shellCommandIndex(tokens);
    if (commandIndex !== -1) {
      return classifyNestedCommand(
        `${verb} -c`,
        words.slice(commandIndex, commandIndex + 1),
      );
    }
  }

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

  // A wrapper that runs another tool -- judge `<tool> ...` itself, its
  // version pin stripped. Its own flags, a `--` separator included, are
  // skipped to reach the tool, except a shell-mode flag (WRAPPER_SHELL_FLAGS),
  // whose value is a shell command rather than a tool name. pnpm's shell-mode
  // flag is a boolean switch, not a value flag, so its command is the words
  // from the tool position on -- any `--filter x` between them is pnpm's own.
  const wrapperEnd = wrappedToolStart(verb, sub, subIndex);
  if (wrapperEnd !== -1) {
    const toolIndex = firstPositionalIndex(
      tokens,
      wrapperEnd,
      wrapperValueFlags(verb),
    );
    const flagsEnd = toolIndex === -1 ? tokens.length : toolIndex;
    for (let k = wrapperEnd; k < flagsEnd; k++) {
      const t = tokens[k];
      if (WRAPPER_SHELL_FLAGS[verb].has(t)) {
        const payloadStart = verb === "pnpm" ? flagsEnd : k + 1;
        return classifyNestedCommand(`${verb} ${t}`, words.slice(payloadStart));
      }
      if (t.startsWith("--call=") && WRAPPER_SHELL_FLAGS[verb].has("--call")) {
        const inline = t.slice("--call=".length);
        return classifyNestedCommand(`${verb} --call`, [
          {
            raw: inline,
            value: words[k].value === undefined ? undefined : inline,
          },
          ...words.slice(k + 1),
        ]);
      }
    }
    // pnpm also accepts its shell-mode flag BEFORE the subcommand (`pnpm -c
    // exec '<cmd>'`, `pnpm -r --shell-mode exec ...`): the words from the
    // tool position on are then the shell command.
    const preFlag =
      verb === "pnpm"
        ? tokens.slice(1, subIndex).find((t) => WRAPPER_SHELL_FLAGS.pnpm.has(t))
        : undefined;
    if (preFlag !== undefined) {
      return classifyNestedCommand(
        `pnpm ${preFlag} ${sub}`,
        toolIndex === -1 ? [] : words.slice(toolIndex),
      );
    }
    if (toolIndex === -1) return undefined;
    // Fail closed: a "tool" word holding whitespace once unquoted (`npx "rm
    // -rf src"`) is no package name -- judge it as the command string it is.
    if (/\s/.test(words[toolIndex].value ?? "")) {
      return classifyNestedCommand(verb, words.slice(toolIndex));
    }
    const tool = unpinnedToolName(tokens[toolIndex]);
    return classifyTokens(
      [
        {
          raw: tool,
          value: words[toolIndex].value === undefined ? undefined : tool,
        },
        ...words.slice(toolIndex + 1),
      ],
      assignments,
    );
  }
  if (verb === "pnpm" && (sub === "eslint" || sub === "prettier")) {
    return classifyTokens(words.slice(subIndex), assignments);
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
