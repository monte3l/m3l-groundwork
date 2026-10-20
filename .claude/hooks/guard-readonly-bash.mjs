#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT
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
 * (a call with no `agent_type` is not restricted). Applying the read-only
 * restriction whenever `agent_type` names a read-only agent is fail-safe --
 * it only refuses more -- so no `agent_id` check is needed here.
 *
 * Design: an ALLOWLIST that fails closed. Anything this hook does not
 * recognize, cannot read or cannot finish classifying is BLOCKED. That matters
 * more than usual here: the hook is registered without `onFailure`, so a throw
 * or a timeout would let the command through. The entry point therefore turns
 * any classifier exception into a block, and the classifier caps its own
 * work: a command over MAX_COMMAND_LENGTH characters, or one nesting
 * substitutions, tool wrappers, `-c` shells or `find -exec` commands deeper
 * than MAX_DEPTH, blocks unread. A false positive costs a reviewer one
 * diagnostic command, handed back to the hub; a false negative lets a
 * read-only spoke mutate the repo. The checks:
 *
 * - Reading. Comments are stripped first (a `#` that begins a word, to the end
 *   of its line; quotes inside a comment open nothing). Every word is unquoted
 *   the way the shell would (`"rm"`, `r\m` and `git "commit"` match as
 *   `rm`/`git commit`); any word that cannot be -- `$'...'` ANSI-C quoting, a
 *   quote that never closes -- blocks, whatever the verb. Chain operators
 *   (`&&`, `||`, `|`, `&`, `;`, newline) inside a quoted string do not split
 *   the command. A write redirect to anything but `/dev/null`/`nul` blocks, and
 *   so does any `<<`/`<<<` here-document or here-string outside quotes, whose
 *   body is not inspected.
 * - Substitutions. `$(...)` and backtick spans (inside double quotes too; a
 *   backtick body unescaped as the shell does) and `<(...)` are classified
 *   recursively; `>(...)` blocks, and so does one that never closes. A
 *   `$(...)` inside single quotes is literal. `$((...))` is arithmetic unless
 *   its body reads as a command (two adjacent words, `$((rm x)|(cat))`).
 * - Verbs (READ_ONLY_VERBS). The effective verb of every segment -- after the
 *   prefix verbs `sudo env xargs command`, leading `VAR=value` assignments,
 *   reserved words and `time` are stripped, and after `npx`/`pnpm exec`/`pnpm
 *   dlx`/`npm exec` and `bash sh zsh dash ksh -c '...'` (also behind a
 *   wrapper's `-c`/`--call`/`--shell-mode`) are unwrapped -- must be on the
 *   list. Anything else blocks: `awk`, `python`, `curl`, `ln`, `rsync`,
 *   `eval`, `hostname`, a shell run without `-c`, and a verb built through
 *   expansion (`$X`, `r$(echo m)`). MUTATING_VERBS keeps its own reason.
 * - node runs only as `node [SAFE_FLAGS]... <script> [args]` (NODE_SAFE_FLAGS,
 *   NODE_SAFE_VALUE_FLAGS); every other option before the script, no script, a
 *   program fed through `<`, and a `NODE_OPTIONS` assignment block.
 *   `--version`/`-v`/`--help`/`-h` pass only alone.
 * - git (GIT_READ_SUBCOMMANDS). Only reading subcommands pass, plus the
 *   read-only forms of `branch tag config worktree stash remote submodule`
 *   (READ_ONLY_GIT_FORMS, with `branch`/`tag` judged against flag ALLOWLISTS,
 *   GIT_BRANCH_READ_FLAGS and GIT_TAG_READ_FLAGS, because their flags take
 *   abbreviations and bundled values no denylist can keep up with); every other
 *   subcommand, an unknown or missing one included, blocks. Before a bare
 *   `--`, `--output` blocks on every subcommand, as do `grep -O`, `ls-remote
 *   -u`/`--upload-pack`/`--exec` and `help -w`/`-i`/`-m`. `git -c`/
 *   `--config-env` keys are checked against GIT_EXEC_CONFIG_KEY and leading
 *   assignments against GIT_EXEC_ENV, both DENYLISTS of known
 *   command-executing keys and variables.
 * - Argument guards on allowlisted verbs that can also write or execute:
 *   `sed -i`/`-I`/`--in-place`, `-f`, or a script using `w`/`W`/`e` or the
 *   `s///w`/`e` flag (an unreadable script blocks too); `find
 *   -delete`/`-fprint*`/`-fls`, and every `-exec`/`-execdir`/`-ok`/`-okdir`
 *   command classified with the same allowlist (a `{}` or reserved word as its
 *   program blocks); `sort -o`/`--output`/`--compress-program`; a second
 *   `uniq` operand; `rg --pre`/`--pre-glob`/`--hostname-bin`; `tree -o`;
 *   `eslint --fix`/`-o`/`--output-file`/`--init`; `prettier --write`/`-w`;
 *   `knip --fix`; `file -C`; `vitest -u`; `tsc` without `--noEmit` or
 *   `-b`/`--build`, and `tsc --init`; `date -s`/`--set`.
 *
 * Residuals, deliberate:
 *
 * - A script file's contents: whatever runs through `node <script>`, `pnpm
 *   <script>` or `npm run <script>` can do anything its own code does; the
 *   hook does not read it. `pnpm`/`npm` keep a DENYLIST of mutating
 *   subcommands (MUTATING_SUBCOMMANDS) plus the fixer guards rather than an
 *   allowlist, because script names are project-defined.
 * - `tsc -b` and `vitest` write their own build outputs and caches.
 * - A prefix verb's OWN value-taking flag resolves the flag's value as the
 *   verb: `sudo -u root rm x`, `env -C /tmp rm x`, `xargs -n 1 rm`, and the
 *   natural `xargs -I {} rm -rf {}`, where `{}` reads as a grouping brace.
 * - System-state writes through allowlisted verbs other than the guarded
 *   ones (`sudo date 0101...` sets the clock through an operand).
 * - Shell grammar beyond the stripped reserved words is not modelled: a `case
 *   ... esac` body, a function definition or call (`f() { cat x; }; f`) and an
 *   alias run whatever they wrap, judged only by the words this hook sees.
 * - The exec denylists: a command-running git config key or variable not on
 *   GIT_EXEC_CONFIG_KEY/GIT_EXEC_ENV passes; a config FILE the user already
 *   controls (`.git/config`, `~/.gitconfig`) can set one and is never read;
 *   other tools' variables (`PAGER`, `EDITOR`, `LESSOPEN`, ...) and anything
 *   exported earlier in the session are not inspected.
 * - `gh` is not on the list (fail closed); it can be added later with its own
 *   read-form table.
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
  // The raw texts, read once: assignmentEnd scans them, and rebuilding the
  // array per assignment would make a long run of assignments quadratic.
  const raws = words.map((w) => w.raw);
  const raw = (k) => words[k].raw;
  const text = (k) => wordText(words[k]);
  let i = 0;
  const skipAssignments = (allowFlags) => {
    while (i < words.length) {
      const name = ASSIGNMENT.exec(raw(i))?.[1];
      if (name !== undefined) {
        assignments.push(name);
        i = assignmentEnd(raws, i);
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
        else {
          words[i] = toWord(rest);
          raws[i] = rest;
        }
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
  // Counted once and decremented, not recounted per `)`: a word ending in
  // thousands of `)` must not cost a quadratic scan.
  let closes = (end.match(/\)/g) ?? []).length;
  while (end.endsWith(")") && !end.endsWith("\\)") && closes > opens) {
    end = end.slice(0, -1);
    closes--;
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
// of the known ones -- see the module header's residuals. Matched
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
  // `remote` with no arguments or `-v` lists remotes; `show`/`get-url` read
  // one. `add`/`remove`/`set-url`/`prune`/... still block.
  remote: (args) =>
    args.length === 0 ||
    (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) ||
    args[0] === "show" ||
    args[0] === "get-url",
  submodule: (args) => args[0] === "status",
};

// The ALLOWLIST of git subcommands that only read, besides the read-only
// forms of READ_ONLY_GIT_FORMS; every other subcommand -- unknown ones
// included -- blocks.
const GIT_READ_SUBCOMMANDS = new Set([
  ...["status", "diff", "log", "show", "blame", "rev-parse", "rev-list"],
  ...["ls-files", "ls-tree", "cat-file", "describe", "shortlog", "grep"],
  ...["for-each-ref", "name-rev", "merge-base", "show-ref", "count-objects"],
  ...["whatchanged", "diff-tree", "diff-index", "diff-files", "cherry"],
  ...["version", "help", "ls-remote"],
]);

/**
 * Whether `name` (a long option, `=value` stripped) is `full` or an
 * abbreviation of it at least `min` characters long -- git, sed and sort all
 * accept an unambiguous prefix of a long option.
 *
 * @param {string} name
 * @param {string} full
 * @param {number} min
 * @returns {boolean}
 */
function abbreviates(name, full, min) {
  return name.length >= min && full.startsWith(name);
}

/**
 * Whether one git argument (`name` is its part before any `=`) makes
 * `git <sub>` write a file or run a program. On every subcommand: `--output`
 * or an abbreviation of it from `--outp` on (`--output-indicator-*` is
 * another flag). On `grep`: `-O` in a short cluster (digits included, as in
 * `-5Ovim`) or `--open-files-in-pager`, which run a pager on the matches.
 * On `ls-remote`: `-u`/`--upload-pack` and `--exec`, which run the given
 * program in place of git-upload-pack. On `help`: `-w`/`--web`, `-i`/
 * `--info` and `-m`/`--man`, which start a browser, info or man.
 *
 * @param {string} sub
 * @param {string} arg
 * @param {string} name
 * @returns {boolean}
 */
function isGitWriteArg(sub, arg, name) {
  if (abbreviates(name, "--output", 6)) return true;
  const isLong = arg.startsWith("--");
  switch (sub) {
    case "grep":
      return isLong
        ? abbreviates(name, "--open-files-in-pager", 4)
        : /^-[A-Za-z0-9]*O/.test(arg);
    case "ls-remote":
      return isLong
        ? abbreviates(name, "--upload-pack", 3) ||
            abbreviates(name, "--exec", 3)
        : /^-[A-Za-z]*u/.test(arg);
    case "help":
      return isLong
        ? ["--web", "--info", "--man"].some((full) =>
            abbreviates(name, full, 4),
          )
        : /^-[A-Za-z]*[wim]/.test(arg);
    default:
      return false;
  }
}

/**
 * The first argument of `git <sub>` that writes a file or runs a program
 * (isGitWriteArg), or undefined. Only the arguments before a bare `--` are
 * flags; after it they are paths (`git diff -- f --output=x` is allowed).
 *
 * @param {string} sub
 * @param {string[]} args
 * @returns {string | undefined}
 */
function gitWriteFlag(sub, args) {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).find((arg) =>
    isGitWriteArg(sub, arg, arg.split("=")[0]),
  );
}

/**
 * The verdict for `git <sub> <args>` once its global flags and environment
 * have been checked: a write flag (gitWriteFlag) blocks first, for every
 * subcommand, before any read-only form can return early; then a read-only
 * form (READ_ONLY_GIT_FORMS) is allowed, a known mutating subcommand keeps
 * its specific reason, an allowlisted read subcommand is allowed, and
 * anything else -- a missing or unknown subcommand included -- blocks.
 *
 * @param {string | undefined} sub
 * @param {string[]} args
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifyGitSubcommand(sub, args) {
  if (sub === undefined) {
    return {
      blocked: true,
      reason: `runs "git" with no subcommand, which is not on the read-only allowlist`,
    };
  }
  const flag = gitWriteFlag(sub, args);
  if (flag !== undefined) {
    return {
      blocked: true,
      reason: `runs "git ${sub} ${flag}", which writes a file or runs a program`,
    };
  }
  if (
    Object.hasOwn(READ_ONLY_GIT_FORMS, sub) &&
    READ_ONLY_GIT_FORMS[sub](args)
  ) {
    return undefined;
  }
  if (MUTATING_SUBCOMMANDS.git.has(sub)) {
    return {
      blocked: true,
      reason: `runs "git ${sub}", a mutating subcommand`,
    };
  }
  if (Object.hasOwn(READ_ONLY_GIT_FORMS, sub)) {
    return {
      blocked: true,
      reason: `runs "git ${sub}" in a form that is not on the read-only allowlist (only its read-only forms are)`,
    };
  }
  if (!GIT_READ_SUBCOMMANDS.has(sub)) {
    return {
      blocked: true,
      reason: `runs "git ${sub}", whose subcommand "${sub}" is not on the read-only allowlist`,
    };
  }
  return undefined;
}

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

// The ALLOWLIST of verbs a read-only spoke may run (after prefix verbs and
// tool wrappers are unwrapped); every other verb blocks. A verb built through
// expansion (`$X`, `r$(echo m)`) keeps its `$`/backtick and so is never on it.
const READ_ONLY_VERBS = new Set([
  // Plain readers.
  ...["cat", "head", "tail", "wc", "ls", "tree", "stat", "file", "du", "df"],
  ...["pwd", "echo", "printf", "true", "false", "test", "[", "[["],
  ...["grep", "egrep", "fgrep", "rg", "cut", "tr", "diff", "cmp", "comm"],
  ...["basename", "dirname", "realpath", "readlink", "date", "uname"],
  ...["whoami", "id", "which", "type", "jq", "column", "nl", "fold", "rev"],
  ...["tac", "paste", "expand", "unexpand", "seq", "expr", "printenv"],
  // Not `hostname`: given an operand, it sets the host name.
  // Harmless shell builtins: `cd` only moves the working directory, `read`
  // only sets a shell variable, `exit` and `:` run nothing.
  ...["cd", "read", "exit", ":"],
  // `command -v`/`-V` only: every other `command` is a prefix verb that
  // stripPrefixVerbs peels off, so `command` is never the verb otherwise.
  "command",
  // Guarded readers: allowed only without their write flags.
  ...["sed", "find", "sort", "uniq"],
  // Project check tools (the fixer guards still block their write flags).
  ...["eslint", "prettier", "tsc", "vitest", "knip", "publint", "attw"],
  // Judged by their own subcommand logic and the wrapper unwrapping.
  ...["git", "pnpm", "npm", "npx", "pnpx"],
  // Guarded: only `node [SAFE_FLAGS] <script> [args]` (see nodeHazard).
  "node",
]);

// Closing reserved words that end a compound command (`for ...; do ...;
// done`, `if ...; fi`, `{ ...; }`): `segments` leaves each as its own
// segment, and it runs nothing -- a redirect after it is scanned separately.
const CLOSING_RESERVED_WORDS = new Set(["done", "fi", "esac", "}"]);

// The ALLOWLIST of `node` options that may precede the script: each changes
// only diagnostics, limits or the test runner, none runs other code. The
// first set takes no value; the second only an inline `=value`.
const NODE_SAFE_FLAGS = new Set([
  "--test",
  "--check",
  "-c",
  "--no-warnings",
  "--trace-warnings",
  "--enable-source-maps",
  "--no-deprecation",
  "--trace-deprecation",
]);
const NODE_SAFE_VALUE_FLAGS = new Set([
  "--stack-trace-limit",
  "--max-old-space-size",
  "--test-reporter",
  "--test-name-pattern",
]);
// Informational options, allowed only as node's sole argument.
const NODE_INFO_FLAGS = new Set(["--version", "-v", "--help", "-h"]);

/**
 * Why a `node` invocation is not `node [SAFE_FLAGS]... <script> [args]`, or
 * undefined when it is. The script is the first word not starting with `-`;
 * every word after it belongs to the script and is never judged as a node
 * option. Before it, only NODE_SAFE_FLAGS (bare) and NODE_SAFE_VALUE_FLAGS
 * (with `=value`) may appear. A script word starting with `<` is a redirect
 * or here-string feeding node its program on stdin; no script at all is a
 * REPL. `--version`/`-v`/`--help`/`-h` pass only as the sole argument.
 *
 * @param {string[]} tokens the command's tokens, `tokens[0]` being `node`
 * @returns {string | undefined} the reason, phrased to follow "runs"
 */
function nodeHazard(tokens) {
  const args = tokens.slice(1);
  if (args.length === 1 && NODE_INFO_FLAGS.has(args[0])) return undefined;
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      return arg.startsWith("<")
        ? `"node" with its program fed from a redirect ("${arg}")`
        : undefined;
    }
    const eq = arg.indexOf("=");
    const safe =
      eq === -1
        ? NODE_SAFE_FLAGS.has(arg)
        : NODE_SAFE_VALUE_FLAGS.has(arg.slice(0, eq));
    if (!safe) {
      return `"node" with option "${arg}", which is not on the read-only allowlist`;
    }
  }
  return `"node" with no script file (an interactive REPL)`;
}

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
 * result classified recursively with classifyCommandAt one level deeper.
 * Fails closed -- blocks -- when there is no word or one cannot be read.
 *
 * @param {string} via e.g. `bash -c`, `npx -c`
 * @param {Word[]} payloadWords
 * @param {number} depth the nesting depth of the command holding the payload
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifyNestedCommand(via, payloadWords, depth) {
  const values = payloadWords.map((w) => w.value);
  if (values.length === 0 || values.includes(undefined)) {
    return {
      blocked: true,
      reason: `runs a nested shell command via ${via} whose command string could not be read`,
    };
  }
  const nested = classifyCommandAt(values.join(" "), depth + 1);
  if (!nested.blocked) return undefined;
  return {
    blocked: true,
    reason: `runs a nested shell command via ${via} that ${nested.reason}`,
  };
}

/**
 * The index of the `)` closing the `(` at `open`, or -1 when it never closes.
 * Quoted spans and backtick spans are skipped whole, so a `)` inside them does
 * not count; a nested `(` (a nested `$(`, a subshell) deepens the match.
 *
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closingParen(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
    } else if (c === "'" || c === "`") {
      j = text.indexOf(c, j + 1);
      if (j === -1) return -1;
    } else if (c === '"') {
      j++;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return -1;
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return j;
    }
  }
  return -1;
}

/**
 * The index of the backtick closing the one at `open` (skipping escaped
 * backticks), or -1 when it never closes.
 *
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closingBacktick(text, open) {
  for (let j = open + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "`") return j;
  }
  return -1;
}

// How deep substitutions, tool wrappers, nested `-c` shells and `find -exec`
// commands may nest before the command is blocked as unreadable, and the
// longest command classified at all. The hook has no `onFailure`, so a stack
// overflow or a run past the hook timeout would ALLOW the command: both caps
// turn that into a block, and together they bound the work per command.
const MAX_DEPTH = 32;
const MAX_COMMAND_LENGTH = 65_536;
const TOO_DEEP = Object.freeze({
  blocked: /** @type {const} */ (true),
  reason: "nests substitutions, wrappers or shells too deeply to read",
});

/**
 * `command` with every shell comment removed: an unquoted `#` that begins a
 * word (at the start, or after whitespace or an operator character) up to the
 * end of its line. Quote characters inside a comment open nothing, so a
 * comment such as `# don't` cannot swallow the lines after it. Done once, up
 * front, so the segment splitter and the substitution scanner both read the
 * command without its comments. Quotes pair as in splitUnquoted.
 *
 * @param {string} command
 * @returns {string}
 */
function stripComments(command) {
  if (!command.includes("#")) return command;
  let out = "";
  let start = 0;
  /** @type {"'" | '"' | "$'" | undefined} */
  let quote;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (c === "\\") {
      i++;
    } else if (quote !== undefined) {
      if (c === quote.at(-1)) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "$" && command[i + 1] === "'") {
      quote = "$'";
      i++;
    } else if (c === "#" && (i === 0 || /[\s;&|()<>]/.test(command[i - 1]))) {
      const newline = command.indexOf("\n", i);
      out += command.slice(start, i);
      if (newline === -1) return out;
      start = newline;
      i = newline - 1;
    }
  }
  return out + command.slice(start);
}

// Two identifier-like words separated only by whitespace (`rm x`, `-rf x`):
// what a command looks like and arithmetic never does (`a + b`, `1+2`).
const COMMAND_LIKE = /(?:^|[^\w$])[A-Za-z_]\w*\s+[A-Za-z_]/;

/**
 * Whether a `$((...))` body reads as a command (a subshell inside a command
 * substitution, `$((rm x)|(cat))`) rather than arithmetic, per COMMAND_LIKE.
 * Nested `$(...)`/backtick spans are replaced by `0` first, innermost out, so
 * `$(( $(date +%s) + 1 ))` stays arithmetic; when they nest past MAX_DEPTH
 * the body is treated as a command (fail closed).
 *
 * @param {string} body the text between `$((` and `))`
 * @returns {boolean}
 */
function isCommandLikeArithmetic(body) {
  let text = body.replace(/`[^`]*`/g, "0");
  for (let k = 0; k < MAX_DEPTH && text.includes("$("); k++) {
    text = text.replace(/\$\([^()]*\)/g, "0");
  }
  return text.includes("$(") || COMMAND_LIKE.test(text);
}

/**
 * Classify every command and process substitution in `command` that the
 * shell would run: `$(...)` and backtick spans outside single quotes (inside
 * double quotes too) and `<(...)` outside any quotes, each body classified
 * recursively with classifyCommandAt one level deeper. A backtick body is
 * unescaped first (`` \` `` -> `` ` ``, `\\` -> `\`, `\$` -> `$`), as the
 * shell does, so an escaped nested backtick is seen. `>(...)` blocks outright
 * -- its body receives the outer command's output as input to act on -- and
 * so does a `<<`/`<<<` here-document or here-string, whose body is not
 * inspected. An arithmetic `$((...))` is not a command, but a substitution
 * inside it still is; a `$((...))` body that reads as a command
 * (isCommandLikeArithmetic) is classified as one. Fails closed -- blocks --
 * on a `$(`, `<(` or backtick that never closes. A `$'...'` span is literal
 * here; classifyTokens fails closed on it.
 *
 * @param {string} command
 * @param {number} depth
 * @param {boolean} [arithmetic] scanning an arithmetic expression, where `<<`
 *   is a shift, not a here-document
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifySubstitutions(command, depth, arithmetic = false) {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  /** @type {"'" | '"' | "$'" | undefined} */
  let quote;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote === "$'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (quote === undefined && !arithmetic && c === "<" && next === "<") {
      return {
        blocked: true,
        reason:
          "uses a here-document or here-string, whose body is not inspected",
      };
    }
    if (c === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quote === undefined && c === "'") {
      quote = "'";
      continue;
    }
    if (quote === undefined && c === "$" && next === "'") {
      quote = "$'";
      i++;
      continue;
    }

    /** @type {{ kind: string, body: string } | undefined} */
    let found;
    if (c === "$" && next === "(") {
      const close = closingParen(command, i + 1);
      if (close === -1) return unbalancedSubstitution("$(");
      const body = command.slice(i + 2, close);
      const expression =
        body.startsWith("(") && body.endsWith(")")
          ? body.slice(1, -1)
          : undefined;
      if (expression !== undefined && !isCommandLikeArithmetic(expression)) {
        // `$((...))` arithmetic: scan its expression for substitutions only.
        const inner = classifySubstitutions(expression, depth + 1, true);
        if (inner !== undefined) return inner;
      } else {
        found = { kind: "command substitution", body };
      }
      i = close;
    } else if (c === "`") {
      const close = closingBacktick(command, i);
      if (close === -1) return unbalancedSubstitution("`");
      found = {
        kind: "command substitution",
        body: command.slice(i + 1, close).replace(/\\([`$\\])/g, "$1"),
      };
      i = close;
    } else if (quote === undefined && c === ">" && next === "(") {
      return {
        blocked: true,
        reason: `runs an output process substitution (">(...)"), whose command acts on this command's output`,
      };
    } else if (quote === undefined && c === "<" && next === "(") {
      const close = closingParen(command, i + 1);
      if (close === -1) return unbalancedSubstitution("<(");
      found = {
        kind: "process substitution",
        body: command.slice(i + 2, close),
      };
      i = close;
    }
    if (found === undefined) continue;
    const nested = classifyCommandAt(found.body, depth + 1);
    if (nested.blocked) {
      return {
        blocked: true,
        reason: `runs a ${found.kind} that ${nested.reason}`,
      };
    }
  }
  return undefined;
}

/**
 * The fail-closed verdict for a substitution opened by `opener` that never
 * closes, so its body cannot be read.
 *
 * @param {string} opener
 * @returns {{ blocked: true, reason: string }}
 */
function unbalancedSubstitution(opener) {
  return {
    blocked: true,
    reason: `opens a substitution ("${opener}") that never closes, so the command it runs could not be read`,
  };
}

/**
 * classifyBashCommand at nesting depth `depth` (see MAX_DEPTH): every
 * recursion -- a substitution body, a nested `-c` shell, a wrapped tool, a
 * `find -exec` command -- comes back through here or classifyTokens one level
 * deeper, so the depth cap bounds all of them.
 *
 * @param {string} rawCommand
 * @param {number} depth
 * @returns {{ blocked: boolean, reason?: string }}
 */
function classifyCommandAt(rawCommand, depth) {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  const command = stripComments(rawCommand);
  if (command.trim().length === 0) return { blocked: false };

  // Substitutions run before the command that holds them, so judge each one
  // first. Scanned over the whole command rather than per segment: a chain
  // operator inside `$(a | b)` belongs to the substitution, not the outer
  // chain, and splitting on it first would cut the substitution in two.
  const substitution = classifySubstitutions(command, depth);
  if (substitution !== undefined) return substitution;

  for (const segment of segments(command)) {
    if (segment.length === 0) continue;

    // `bash -c '<command>'`/`sh -c '<command>'` runs the quoted argument as
    // its own shell command -- unwrap and recurse rather than reading only
    // the outer `bash -c` invocation, which is never itself mutating.
    const nestedShell = SHELL_DASH_C.exec(segment);
    if (nestedShell !== null) {
      const nested = classifyCommandAt(nestedShell[2], depth + 1);
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
      [],
      depth,
    );
    if (verdict !== undefined) return verdict;
  }

  return { blocked: false };
}

/**
 * Classify a shell command as blocked or allowed for a read-only spoke.
 * Allowlist-based and failing closed -- a command too long or nested too
 * deeply to read blocks -- see the module header for the design.
 *
 * @example
 * ```js
 * import { classifyBashCommand } from "./guard-readonly-bash.mjs";
 * classifyBashCommand("git status"); // { blocked: false }
 * classifyBashCommand("echo $(rm x)").blocked; // true
 * ```
 *
 * @param {string} command
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function classifyBashCommand(command) {
  if (typeof command !== "string") return { blocked: false };
  if (command.length > MAX_COMMAND_LENGTH) {
    return { blocked: true, reason: "is too long to classify" };
  }
  return classifyCommandAt(command, 0);
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

/** @typedef {{ blocked: true, reason: string }} Blocked */

/**
 * What in a sed script writes a file or runs a shell command -- the `w`, `W`
 * or `e` command, or the `w`/`e` flag of `s///` -- or what makes it
 * unreadable, or undefined when neither. A small parser over sed's command
 * syntax (addresses, `s`/`y` delimiters, text and label arguments), so a `w`
 * inside a regex or a replacement (`s/w/x/`) is not mistaken for the
 * command. A label (`:a`, `b a`, `t a`, `T a`) is its first word only:
 * GNU and BSD sed disagree about where a label ends, so any text after it is
 * parsed as more script (`b end w out` is caught). Best effort: an
 * unterminated address or `s`/`y` is reported unreadable (fail closed), and
 * a multi-line `a\`/`i\`/`c\` text block may be over-reported.
 *
 * @param {string} script
 * @returns {{ unreadable: boolean, what: string } | undefined}
 */
function sedScriptHazard(script) {
  const n = script.length;
  let i = 0;
  const readDelimited = (/** @type {string} */ d) => {
    while (i < n) {
      const c = script[i];
      i += c === "\\" ? 2 : 1;
      if (c === d) return true;
    }
    return false;
  };
  const readAddress = () => {
    if (script[i] === "/" || script[i] === "\\") {
      const d = script[i] === "/" ? "/" : script[i + 1];
      i += script[i] === "/" ? 1 : 2;
      if (d === undefined || !readDelimited(d)) return false;
      while (i < n && /[IM]/.test(script[i])) i++;
      return true;
    }
    while (i < n && /[\d$~+]/.test(script[i])) i++;
    return true;
  };
  const skip = (/** @type {RegExp} */ pattern) => {
    while (i < n && pattern.test(script[i])) i++;
  };
  const unterminated = { unreadable: true, what: "an unterminated address" };
  for (;;) {
    skip(/[\s;{}!]/);
    if (i >= n) return undefined;
    if (script[i] === "#") {
      skip(/[^\n]/);
      continue;
    }
    if (!readAddress()) return unterminated;
    skip(/\s/);
    if (script[i] === ",") {
      i++;
      skip(/\s/);
      if (!readAddress()) return unterminated;
    }
    skip(/[\s!]/);
    if (i >= n) return undefined;
    const command = script[i++];
    switch (command) {
      case "w":
      case "W":
      case "e":
        return { unreadable: false, what: `the "${command}" command` };
      case "s":
      case "y": {
        const d = script[i++];
        if (d === undefined || !readDelimited(d) || !readDelimited(d)) {
          return {
            unreadable: true,
            what: `an unterminated "${command}" command`,
          };
        }
        const start = i;
        skip(/[^\s;}#]/);
        const flag = /[we]/.exec(command === "s" ? script.slice(start, i) : "");
        if (flag !== null) {
          return { unreadable: false, what: `the "${flag[0]}" flag of "s"` };
        }
        break;
      }
      case "a":
      case "i":
      case "c":
      case "r":
      case "R":
        skip(/[^\n]/); // text or a file name, up to the end of the line
        break;
      case "b":
      case "t":
      case "T":
      case ":":
        skip(/[ \t]/);
        skip(/[^;\s]/); // the label's first word; the rest is parsed as script
        break;
      default:
        break; // a command without arguments (`p`, `d`, `n`, `=`, ...)
    }
  }
}

/**
 * The verdict for a `sed` invocation: an in-place edit (a short cluster
 * holding `i`, or BSD's `I`, or an abbreviation of `--in-place`), a script file (`-f`/
 * `--file`, whose contents the hook cannot read), or a script -- given with
 * `-e`/`--expression`, else the first operand -- that writes or executes
 * (sedScriptHazard) blocks.
 *
 * @param {string[]} tokens `tokens[0]` is `sed`
 * @returns {Blocked | undefined}
 */
function classifySed(tokens) {
  const inPlace = { blocked: true, reason: `runs "sed -i" (in-place edit)` };
  const scriptFile = {
    blocked: true,
    reason: `runs "sed -f", whose script file cannot be inspected`,
  };
  /** @type {string[]} */
  const scripts = [];
  /** @type {string[]} */
  const operands = [];
  let explicit = false;
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === "--") {
      operands.push(...tokens.slice(k + 1));
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (abbreviates(name, "--in-place", 3)) return inPlace;
      if (abbreviates(name, "--file", 4)) return scriptFile;
      if (abbreviates(name, "--expression", 3)) {
        explicit = true;
        scripts.push(eq === -1 ? (tokens[++k] ?? "") : t.slice(eq + 1));
      } else if (abbreviates(name, "--line-length", 3) && eq === -1) {
        k++; // its value
      }
    } else if (t.startsWith("-") && t.length > 1) {
      if (/[iI]/.test(t)) return inPlace;
      for (let j = 1; j < t.length; j++) {
        if (t[j] === "f") return scriptFile;
        if (t[j] === "e") {
          explicit = true;
          scripts.push(t.slice(j + 1) || (tokens[++k] ?? ""));
          break;
        }
        if (t[j] === "l") {
          if (j + 1 === t.length) k++; // its value is the next token
          break;
        }
      }
    } else {
      operands.push(t);
    }
  }
  // With any -e, every operand is an input file; otherwise the first is the
  // script.
  if (!explicit && operands.length > 0) scripts.push(operands[0]);
  for (const script of scripts) {
    const hazard = sedScriptHazard(script);
    if (hazard !== undefined) {
      return {
        blocked: true,
        reason: hazard.unreadable
          ? `runs a sed script that could not be read (${hazard.what})`
          : `runs a sed script using ${hazard.what}, which writes a file or runs a command`,
      };
    }
  }
  return undefined;
}

// `find` actions that write or delete files, and those that run a command
// on each match.
const FIND_WRITE_ACTIONS = new Set([
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// Shell reserved words: find runs its exec command through execvp, with no
// shell, so none of these means anything there -- and classifyTokens, which
// reads shell grammar, would strip or skip them and judge the wrong word.
const SHELL_RESERVED_WORDS = new Set([
  ...["{", "}", "if", "then", "else", "elif", "fi", "do", "done"],
  ...["while", "until", "for", "case", "esac", "select", "time", "!"],
]);

/**
 * The verdict for a `find` invocation: a write action blocks, and each
 * exec action's command (up to its terminating `;`, or a `+` right after
 * `{}`) is classified with classifyTokens -- the same allowlist -- blocking
 * when it blocks, when it is missing, or when no terminator follows.
 *
 * @param {Word[]} words
 * @param {string[]} tokens `tokens[0]` is `find`, index-aligned with `words`
 * @param {number} depth the nesting depth of the `find` command
 * @returns {Blocked | undefined}
 */
function classifyFind(words, tokens, depth) {
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (FIND_WRITE_ACTIONS.has(t)) {
      return {
        blocked: true,
        reason: `runs "find ... ${t}", which writes or deletes files`,
      };
    }
    if (!FIND_EXEC_ACTIONS.has(t)) continue;
    let end = k + 1;
    while (
      end < tokens.length &&
      tokens[end] !== ";" &&
      !(tokens[end] === "+" && tokens[end - 1] === "{}")
    ) {
      end++;
    }
    if (end >= tokens.length || end === k + 1) {
      return {
        blocked: true,
        reason: `runs "find ... ${t}" with no command or no terminating ";" or "+", so what it runs could not be read`,
      };
    }
    // The program find runs is the first word itself: a match (`{}`) or a
    // reserved word there, even behind a prefix verb, is no command this
    // guard can judge.
    const program = parseTokens(words.slice(k + 1, end)).tokens[0] ?? "";
    for (const first of [tokens[k + 1], program]) {
      if (first.includes("{}") || SHELL_RESERVED_WORDS.has(first)) {
        return {
          blocked: true,
          reason: `runs "find ... ${t} ${first}", whose program is a matched file or a shell reserved word`,
        };
      }
    }
    const nested = classifyTokens(words.slice(k + 1, end), [], depth + 1);
    if (nested !== undefined) {
      return {
        blocked: true,
        reason: `runs "find ... ${t}" whose command ${nested.reason}`,
      };
    }
    k = end;
  }
  return undefined;
}

/**
 * The verdict for a `sort` invocation: an output file (`-o`, a short cluster
 * holding `o`, an abbreviation of `--output`) or a compressor program
 * (`--compress-program`, which sort runs) blocks. Arguments after a bare
 * `--` are files.
 *
 * @param {string[]} tokens `tokens[0]` is `sort`
 * @returns {Blocked | undefined}
 */
function classifySort(tokens) {
  for (const t of tokens.slice(1)) {
    if (t === "--") break;
    const name = t.split("=")[0];
    const hit = t.startsWith("--")
      ? abbreviates(name, "--output", 3) ||
        abbreviates(name, "--compress-program", 4)
      : t.startsWith("-") && t.includes("o");
    if (hit) {
      return {
        blocked: true,
        reason: `runs "sort ${t}", which writes a file or runs a program`,
      };
    }
  }
  return undefined;
}

// `uniq`'s long options that take their value as the following token.
const UNIQ_VALUE_OPTIONS = ["--skip-fields", "--skip-chars", "--check-chars"];

/**
 * The verdict for a `uniq` invocation: a second operand is the file uniq
 * writes its output to, so more than one blocks. Option values (`-f N`,
 * `-s N`, `-w N` and their long forms) are not operands.
 *
 * @param {string[]} tokens `tokens[0]` is `uniq`
 * @returns {Blocked | undefined}
 */
function classifyUniq(tokens) {
  /** @type {string[]} */
  const operands = [];
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === "--") {
      operands.push(...tokens.slice(k + 1));
      break;
    }
    if (t.startsWith("--")) {
      if (
        !t.includes("=") &&
        UNIQ_VALUE_OPTIONS.some((full) => abbreviates(t, full, 4))
      ) {
        k++;
      }
    } else if (t.startsWith("-") && t.length > 1) {
      const at = t.search(/[fsw]/);
      if (at !== -1 && at + 1 === t.length) k++; // value is the next token
    } else {
      operands.push(t);
    }
  }
  if (operands.length <= 1) return undefined;
  return {
    blocked: true,
    reason: `runs "uniq" with a second operand ("${operands[1]}"), which is the file it writes`,
  };
}

/**
 * The argument guards of the verbs on READ_ONLY_VERBS that also have a
 * writing form: the guarded readers (`sed`, `find`, `sort`, `uniq`) and the
 * tools checked by toolWriteReason. Any other verb returns undefined.
 *
 * @param {string} verb
 * @param {Word[]} words
 * @param {string[]} tokens
 * @param {number} depth
 * @returns {Blocked | undefined}
 */
function classifyGuardedReader(verb, words, tokens, depth) {
  switch (verb) {
    case "sed":
      return classifySed(tokens);
    case "find":
      return classifyFind(words, tokens, depth);
    case "sort":
      return classifySort(tokens);
    case "uniq":
      return classifyUniq(tokens);
    default: {
      const why = toolWriteReason(verb, tokens);
      return why === undefined ? undefined : { blocked: true, reason: why };
    }
  }
}

/**
 * Whether `tsc` is given `--noEmit` (not followed by an explicit `false`).
 * tsc matches option names case-insensitively.
 *
 * @param {string[]} lower the lowercased arguments
 * @returns {boolean}
 */
function tscNoEmit(lower) {
  const k = lower.findIndex((t) => t === "--noemit" || t === "--noemit=true");
  return k !== -1 && lower[k + 1] !== "false";
}

/**
 * The reason an allowlisted tool's flags make it write a file, run another
 * program or change system state, or undefined. Only the arguments before a
 * bare `--` are read as flags. `rg --pre`/`--pre-glob`/`--hostname-bin` run
 * a program; `tree -o`/`--output`, `eslint -o`/`--output-file`/`--init`,
 * `knip --fix`/`--fix-type`, `file -C`/`--compile` and `vitest -u`/`--update`
 * write files; `tsc` emits unless given `--noEmit` or `-b`/`--build`, and
 * `--init` always writes; `date -s`/`--set` sets the clock.
 *
 * @param {string} verb
 * @param {string[]} tokens `tokens[0]` is the verb
 * @returns {string | undefined} the full reason, starting with "runs"
 */
function toolWriteReason(verb, tokens) {
  const end = tokens.indexOf("--");
  const args = tokens.slice(1, end === -1 ? undefined : end);
  const short = (/** @type {RegExp} */ pattern) =>
    args.find((t) => /^-[^-]/.test(t) && pattern.test(t));
  const long = (/** @type {(name: string) => boolean} */ test) =>
    args.find((t) => t.startsWith("--") && test(t.split("=")[0]));
  /** @type {string | undefined} */
  let flag;
  switch (verb) {
    case "rg":
      flag = long((n) => ["--pre", "--pre-glob", "--hostname-bin"].includes(n));
      break;
    case "tree":
      flag = short(/o/) ?? long((n) => abbreviates(n, "--output", 5));
      break;
    case "eslint":
      flag =
        args.find((t) => t === "-o" || t === "--init") ??
        long((n) => n === "--output-file");
      break;
    case "knip":
      flag = long((n) => n === "--fix" || n === "--fix-type");
      break;
    case "file":
      flag = short(/C/) ?? long((n) => n === "--compile");
      break;
    case "vitest":
      flag = args.find((t) => t === "-u") ?? long((n) => n === "--update");
      break;
    case "date":
      flag = short(/^-[uRjn]*s/) ?? long((n) => abbreviates(n, "--set", 3));
      if (flag !== undefined) {
        return `runs "date ${flag}", which sets the system clock`;
      }
      return undefined;
    case "tsc": {
      const lower = args.map((t) => t.toLowerCase());
      if (lower.includes("--init")) {
        return `runs "tsc --init", which writes a tsconfig.json`;
      }
      if (
        tscNoEmit(lower) ||
        lower.includes("-b") ||
        lower.includes("--build")
      ) {
        return undefined;
      }
      return `runs "tsc" without --noEmit or --build, which emits compiled files`;
    }
    default:
      return undefined;
  }
  return flag === undefined
    ? undefined
    : `runs "${verb} ${flag}", which writes a file or runs a program`;
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
 * Every recursion it makes -- a wrapped tool, a nested `-c` command, a
 * guarded reader's `find -exec` -- goes one level deeper (see MAX_DEPTH).
 *
 * @param {Word[]} rawWords
 * @param {readonly string[]} [inherited]
 * @param {number} [depth]
 * @returns {{ blocked: true, reason: string } | undefined}
 */
function classifyTokens(rawWords, inherited = [], depth = 0) {
  if (depth > MAX_DEPTH) return TOO_DEEP;
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
        depth,
      );
    }
  }

  if (MUTATING_VERBS.has(verb)) {
    return { blocked: true, reason: `runs "${verb}", a mutating command` };
  }
  if (CLOSING_RESERVED_WORDS.has(verb)) return undefined;
  if (!READ_ONLY_VERBS.has(verb)) {
    return {
      blocked: true,
      reason: `runs "${verb}", which is not on the read-only allowlist`,
    };
  }

  // Fail closed on any argument that cannot be unquoted (`$'-e'`, a quote
  // that never closes): what the verb receives is unknown, so no flag guard
  // below could be trusted to have seen it.
  const opaque = words.find((w) => w.value === undefined);
  if (opaque !== undefined) {
    return {
      blocked: true,
      reason: `passes an argument (${opaque.raw}) whose quoting could not be read`,
    };
  }

  if (verb === "node") {
    if (assignments.includes("NODE_OPTIONS")) {
      return {
        blocked: true,
        reason: `sets NODE_OPTIONS, which makes node load or run other code`,
      };
    }
    const hazard = nodeHazard(tokens);
    if (hazard !== undefined)
      return { blocked: true, reason: `runs ${hazard}` };
  }

  const guarded = classifyGuardedReader(verb, words, tokens, depth);
  if (guarded !== undefined) return guarded;

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
        return classifyNestedCommand(
          `${verb} ${t}`,
          words.slice(payloadStart),
          depth,
        );
      }
      if (t.startsWith("--call=") && WRAPPER_SHELL_FLAGS[verb].has("--call")) {
        const inline = t.slice("--call=".length);
        return classifyNestedCommand(
          `${verb} --call`,
          [
            {
              raw: inline,
              value: words[k].value === undefined ? undefined : inline,
            },
            ...words.slice(k + 1),
          ],
          depth,
        );
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
        depth,
      );
    }
    if (toolIndex === -1) return undefined;
    // Fail closed: a "tool" word holding whitespace once unquoted (`npx "rm
    // -rf src"`) is no package name -- judge it as the command string it is.
    if (/\s/.test(words[toolIndex].value ?? "")) {
      return classifyNestedCommand(verb, words.slice(toolIndex), depth);
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
      depth + 1,
    );
  }
  if (verb === "pnpm" && (sub === "eslint" || sub === "prettier")) {
    return classifyTokens(words.slice(subIndex), assignments, depth + 1);
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
    return classifyGitSubcommand(
      sub,
      subIndex === -1 ? [] : tokens.slice(subIndex + 1),
    );
  }

  const mutatingSubs = MUTATING_SUBCOMMANDS[verb];
  if (mutatingSubs === undefined || sub === undefined) return undefined;

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
  let verdict;
  try {
    verdict = classifyBashCommand(typeof command === "string" ? command : "");
  } catch {
    // No `onFailure` is set for this hook, so a crash here would ALLOW the
    // command: a classifier failure blocks instead.
    verdict = {
      blocked: true,
      reason: "could not be classified (the guard failed on it)",
    };
  }
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
