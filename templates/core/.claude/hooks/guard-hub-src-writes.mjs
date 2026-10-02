#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit|Bash): blocks any hub-authored write into a
 * guarded source or test path, on any branch -- only the designated writer
 * subagents (`code-implementer`, `test-author`) may edit that code; every
 * other caller, including the hub itself, gets refused.
 *
 * Problem: `guard-branch-isolation.mjs` only fires while `HEAD` is `main`.
 * On a feature branch nothing else stops the hub itself from writing
 * directly into a guarded path instead of dispatching the write to a writer
 * spoke, as CLAUDE.md's Agent Operating Model requires -- and a Write/Edit
 * guard alone is bypassed by a Bash command that writes the same file
 * (`cat > src/a.ts <<EOF`, `sed -i`, `cp`, a `python -c` one-liner).
 *
 * The seam: the PreToolUse payload carries a top-level `agent_type` field
 * when the tool call fires inside a subagent context. The field is absent
 * (or empty) for hub-level calls, and contains the subagent's name for
 * spoke calls.
 *
 * The decision: block when BOTH conditions hold:
 *   (a) the target path is a guarded source/test path, AND
 *   (b) `agent_type` is NOT the name of an authorised writer spoke
 *       (`code-implementer` or `test-author`, per WRITER_SPOKES in
 *        bin/lib/agent-roster.mjs).
 *
 * Hub calls (absent/empty agent_type) and non-writer subagents are treated
 * identically -- both are blocked from guarded paths. Writer spokes are
 * allowed through. All other paths are allowed through unconditionally.
 *
 * Write|Edit: the target is `tool_input.file_path`, checked directly.
 *
 * Bash: the target is whatever `tool_input.command` visibly writes. A small
 * shell lexer below (no dependency, linear in the command's length)
 * understands single/double/ANSI-C quotes, backslash escapes, comments,
 * `$(...)`/backtick substitutions, subshell parens and brace groups
 * (substituted text is analysed recursively, nesting capped at MAX_DEPTH),
 * heredocs (`<<`, `<<-`, quoted or not -- the body is DATA, never parsed as
 * commands, but kept so an interpreter or patch reading it can be scanned),
 * here-strings, the separators `&& || ; | & newline`, and redirections
 * (`>`, `>>`, `>|`, `&>`, `N>`, `>&N`; an fd duplication is never a path).
 * Each simple command then has its leading `VAR=val` assignments and
 * wrappers (`sudo`, `env`, `nohup`, `time`, `command`, `exec`, `nice`,
 * `xargs`, `builtin`) stripped, `cd`/`pushd` tracked against the running
 * cwd, and `bash|sh|zsh -c STR` / `eval STR` re-lexed one level deeper. A
 * relative path is resolved against the running cwd (the payload's `cwd`,
 * so a worktree session resolves into its own worktree), `.`/`..` are
 * normalised lexically, and the result goes through the same
 * `isProtectedPath(abs, projectDir)` the Write|Edit path uses -- an absolute
 * path outside the project is never protected. Targets the lexer cannot
 * resolve statically (containing `$`, a backtick, a leading `~`) are
 * ignored; a glob is judged by its literal directory prefix and by its
 * whole path with every globbed segment a placeholder (`packages/<glob>/src`);
 * anything under `/dev/` (`/dev/null`, `/dev/stdout`, `/dev/fd/N`) is
 * ignored.
 *
 * An ANCESTOR of a guarded directory is a path that contains one beneath
 * it, judged lexically: the project root (a flat layout's own src/tests),
 * a workspace container (`packages`, `apps`, `libs`), or a package
 * directly inside one (`packages/cli`). A final glob segment is judged by
 * its parent: directly under the project root it counts when it could
 * expand to `src`, `tests` or a container (`rm -rf *`); directly under a
 * container it always counts, as it may name a package (`packages/c*`,
 * `packages/cl?`, `packages/[c]li`); directly under a package it counts
 * when it could expand to `src` or `tests` (`packages/cli/*`); anywhere else
 * it never does (`dist/*`, `coverage/*`, `packages/cli/dist/*`).
 * `packages/cli/dist`, `node_modules`, `coverage` and a linked worktree's
 * own root (`.claude/worktrees/<name>`) are not ancestors. A block on an
 * ancestor says so in its message.
 * `[[ ... ]]`, `[ ... ]` and `(( ... ))` are lexed as one unit, so a `<`,
 * `>`, `&&` or `||` inside a test expression is never a redirect or a
 * command boundary; a `$(...)`/backtick substitution inside `[[ ]]`/`[ ]`
 * is still analysed. An unquoted `;`, newline, lone `&` or lone `|` before
 * the closer means the text is not one test unit and is lexed normally.
 *
 * Bash write patterns detected (the reported rule is the tool's name, or
 * `redirect`):
 *   - an output redirect (`>`, `>>`, `>|`, `&>`, `N>`, `<>`, `>& file`)
 *   - `tee` (every operand)
 *   - `sed -i` / `--in-place` / a short-flag cluster containing `i`
 *   - `perl -i` / `-pi` (every file operand)
 *   - `cp`, `install`, `rsync`, `ln` -- the destination only (last operand,
 *     or `-t`/`--target-directory`; `install -d` creates every operand);
 *     sources never count. An ancestor destination counts too, unless it
 *     is a directory known to exist (the project root, a trailing `/`, a
 *     `-t` target, several sources) and every source lands as a named
 *     `dest/<basename>` that is neither guarded nor an ancestor -- a
 *     source copying a directory's contents (`dir/`, `dir/.`), a glob or an
 *     unresolvable name always counts
 *   - `rsync --remove-source-files` -- additionally every source, guarded
 *     or an ancestor, since rsync deletes what it copied
 *   - `mv` -- any operand, source or destination; an ancestor source, and
 *     an ancestor destination by the same rule as `cp`
 *   - `rm`, `unlink`, `rmdir`, `touch`, `truncate` -- any operand; for `rm`
 *     an ancestor operand too
 *   - `dd of=PATH`
 *   - `patch` (never with `--dry-run`, `--check` or `-C`) / `git apply`
 *     (never with `--check`, `--stat`, `--numstat` or `--summary`); blocked
 *     when an operand, `-d`/`--directory` or `patch -o` is a guarded path,
 *     or when the patch text (a heredoc, here-string or `<` stdin, or a
 *     named patch file read from disk) has a `diff --git`/`--- `/`+++ `
 *     header naming one
 *   - an interpreter (`python*`, `node`, `nodejs`, `deno`, `bun`, `ruby`,
 *     `perl`, `php`) whose inline code (`-c`/`-e`/`-p`/`-r`/`eval`), stdin
 *     (`-`, heredoc, here-string) or script FILE located OUTSIDE the project
 *     calls a write verb with a string literal resolving to a guarded path
 *     in the WRITTEN position: the first argument of `writeFile(Sync)`,
 *     `appendFile(Sync)`, `createWriteStream`, `file_put_contents`,
 *     `File.write`/`IO.write`/`Bun.write`, `Deno.writeTextFile(Sync)`,
 *     `truncate(Sync)`, and the delete verbs `Deno.remove(Sync)`, `rm(Sync)`, `rmdir(Sync)`, `unlink(Sync)`, `os.remove`,
 *     `os.removedirs`, `shutil.rmtree`, `File.delete`, `FileUtils.rm*`; the
 *     destination (second) argument of `copyFile(Sync)`, `cp`/`cpSync`,
 *     `copy`, `shutil.copy*`; either argument of `rename(Sync)`/
 *     `os.rename`/`os.replace`/`shutil.move`; the path of a write-mode
 *     `open`/`openSync`/`fopen` (`'w'`, `'a'`, `'x'`, `'c'`, `'r+'`..., as
 *     the second argument or a `mode=` keyword anywhere; or perl's
 *     `open(F, ">path")`, `open(F, '>', 'path')` and paren-less
 *     `open F, ">path"`); and the receiver of `Path('...').write_text`/
 *     `write_bytes`/`touch`/`unlink`/`rmdir`/`rename`/`replace`. For the
 *     tree-removing and moving verbs (`Deno.remove(Sync)`, `rm(Sync)`,
 *     `rename(Sync)`,
 *     `os.rename`/`os.replace`, `shutil.move`/`rmtree`, `FileUtils.rm*`,
 *     `Path.rename`/`replace`) an ancestor literal counts too. A guarded
 *     path that is only read, or a write verb aimed elsewhere, does not
 *     count. A script inside the project is trusted and never read.
 * Every other `git` subcommand, every read, test runner, linter and
 * formatter is allowed.
 *
 * Documented FALSE NEGATIVES -- this is a static screen over command text,
 * not a sandbox, and these writes pass it:
 *   - an interpreter running a script that lives inside the project, or any
 *     other indirection (a script that writes a second script, a pipe into
 *     an interpreter's stdin, `bash script.sh`)
 *   - `eval` of a computed string, and any target or code assembled at run
 *     time: variable-, glob-from-variable-, `~`- or command-substitution-
 *     expanded paths, `python -c` building the path from pieces or holding
 *     it in a variable, an interpreter write verb outside the list above
 *     (perl's `File::Path` `rmtree`/`remove_tree` among them), and perl's
 *     paren-less 3-arg `open F, '>', 'path'`
 *   - an interpreter write call whose argument list spans more than
 *     MAX_CALL_CHARS (1000) characters: it is not split, so not screened
 *     (reported as a note)
 *   - build steps, generators and formatters (`pnpm <script>`, `make`,
 *     codegen, `prettier --write`, `eslint --fix`) that write into src/tests
 *   - `mkdir`, `find -delete`, and `find -exec` -- always, whatever its
 *     operands, since `find`'s command line is never analysed; `xargs` is
 *     a false negative only without literal operands (`xargs rm <guarded>`
 *     is caught, the wrapper being stripped)
 *   - an ancestor the lexical rule above does not recognise: a workspace
 *     container under another name, a nested one (`packages/group/pkg`),
 *     or the root of a linked worktree (`.claude/worktrees/<name>`, so
 *     `rsync -a /tmp/x/ .` from inside one passes); and a mid-path glob is
 *     never read as possibly naming `src`/`tests` (`<glob>/a.ts`)
 *   - `tar`/`unzip`/`curl -o`/`wget -O`, `git checkout`/`restore`/`stash`
 *     (`stash pop`)/`reset`/`rm`/`mv`/`clean` (`git clean -fdx`), and editors (`vim -c ...`)
 *   - a redirect attached to a test expression (`[[ -f a ]] > file`): the
 *     whole `[[`/`[` command is skipped for redirects
 *   - `$(...)`/backtick substitutions inside an UNQUOTED heredoc body: the
 *     shell runs them, but the body is treated as data
 *   - a session cwd (or worktree) outside CLAUDE_PROJECT_DIR: every path
 *     resolves outside the project and so is never guarded
 *   - anything nested deeper than MAX_DEPTH, a path spelled through a
 *     symlinked alias of the project root, and a script or patch file larger
 *     than MAX_READ_BYTES (the depth and both size cases are reported as
 *     notes)
 *   - a tool run through a channel that bypasses PreToolUse hooks entirely
 * Hub-and-spoke is therefore a convention backed by a guard that raises the
 * bar, not a proof.
 *
 * Maintainer override: run the command yourself with the `!` prefix at the
 * Claude Code prompt (that is not a tool call, so no hook runs), or edit or
 * remove this hook's registration in .claude/settings.json.
 *
 * Visibility: when the detector gives up on part of a command -- the
 * nesting cap was hit (`nesting`), a script/patch exceeded MAX_READ_BYTES
 * (`size`), an interpreter write call's argument list exceeded
 * MAX_CALL_CHARS (`call size`), or a file exists but could not be read
 * (`read`; a file that simply does not exist is not noted) -- it still
 * allows, but records a note (a size cap is note-only: it never blocks), and the entry point prints one `allowed, but not fully analysed`
 * line to stderr. A fully analysed allowed command prints nothing.
 *
 * Fail-open: an unparseable payload, a Bash payload with no string command,
 * or an exception inside the Bash analysis exits 0 with a stderr line
 * saying so, so a malformed hook input never wedges the session. A
 * Write/Edit payload with no file_path has nothing to check and exits 0.
 */
import process from "node:process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  isAbsoluteLike,
  isProtectedPath,
} from "../../bin/lib/protected-paths.mjs";
import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs";

function isWriterSpoke(agentType) {
  return (
    typeof agentType === "string" &&
    agentType.length > 0 &&
    WRITER_SPOKES.has(agentType)
  );
}

/**
 * Pure decision function -- exported for unit testing.
 *
 * @param {string | undefined} filePath  The file_path from the tool_input payload.
 * @param {unknown} agentType            The top-level agent_type from the payload.
 * @param {string} [projectDir]          Scopes an absolute filePath to the project -- see isProtectedPath.
 * @returns {boolean} true = block, false = allow.
 */
export function shouldBlockHubSrcWrite(filePath, agentType, projectDir) {
  if (!filePath || typeof filePath !== "string") return false;
  if (!isProtectedPath(filePath, projectDir)) return false;
  return !isWriterSpoke(agentType);
}

// ---------------------------------------------------------------------------
// Bash detector -- lexer
// ---------------------------------------------------------------------------

/** Nesting cap for `$(...)`, backticks, `bash -c` and `eval`. */
const MAX_DEPTH = 3;
/** Largest script or patch file the detector will read from disk. */
const MAX_READ_BYTES = 1_000_000;

const WORD_BREAK = new Set([
  " ",
  "\t",
  "\n",
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
]);
// Longest first, so `<<-` wins over `<<` and `>>` over `>`.
const REDIRECT_OPS = [
  "<<<",
  "<<-",
  "<<",
  "<>",
  "<&",
  "<",
  ">>",
  ">|",
  ">&",
  ">",
];
const OUTPUT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const HEREDOC_OPS = new Set(["<<", "<<-"]);
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);
const PARAMETER_START = /[\w@*#?$!-]/;
// Test-expression openers and the word that closes each.
const TEST_CLOSERS = new Map([
  ["[[", "]]"],
  ["[", "]"],
]);
// Inside a test expression these are comparison/grouping operators, inert.
const TEST_INERT = new Set(["<", ">", "&", "|", "(", ")"]);
const NESTING_NOTE = `nesting depth cap (${MAX_DEPTH}) reached; the innermost command was not analysed`;

/** Records why the detector gave up on part of a command, when the caller asked. */
function addNote(notes, note) {
  if (notes) notes.add(note);
}

/**
 * Skips to just past the `close` that balances `depth` already-open
 * `open`s, honouring quotes and backslashes. Used where the text is not
 * worth lexing (arithmetic, `${...}`, anything past MAX_DEPTH).
 */
function skipBalanced(src, start, depth, open, close) {
  let level = depth;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end + 1;
    } else if (c === '"') {
      i = skipDoubleQuoted(src, i + 1);
    } else {
      if (c === open) level++;
      else if (c === close && --level === 0) return i + 1;
      i++;
    }
  }
  return src.length;
}

function skipDoubleQuoted(src, start) {
  let i = start;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === '"') return i + 1;
    else i++;
  }
  return src.length;
}

/** Reads a backtick substitution body starting just past the opening backtick. */
function readBacktick(src, start) {
  let inner = "";
  let i = start;
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      inner +=
        next === "`" || next === "\\" || next === "$" ? next : `\\${next}`;
      i += 2;
    } else {
      inner += src[i];
      i++;
    }
  }
  return { inner, end: Math.min(i + 1, src.length) };
}

function newWord() {
  // value: the word with quotes removed but expansions kept verbatim;
  // dynamic: contains an expansion, so its runtime value is unknown;
  // globAt: index in value of the first unquoted glob character, or -1.
  return { value: "", dynamic: false, tilde: false, globAt: -1, subs: [] };
}

/**
 * Lexes `src` from `start` into word / operator / redirect tokens. With
 * `nested` set it stops at the `)` closing a `$(` and reports where.
 * `notes` (optional Set) collects a note when a substitution body is
 * skipped at the nesting cap.
 */
function lex(src, start, depth, nested, notes) {
  const n = src.length;
  const tokens = [];
  const heredocs = [];
  // Per closer, the span [from, until] a failed search already covered:
  // any later search starting inside it stops at the same separator, so a
  // run of unclosed `[[` words cannot make the search quadratic.
  const closerMiss = new Map();
  let pendingRedirect = null;
  let parens = 0;
  let i = start;

  /**
   * Index of the standalone `closer` word ending a test expression that
   * starts at `i`, or -1. Quote- and substitution-aware; `&&`/`||` may
   * appear inside, but an unquoted `;`, newline, lone `&` or lone `|`
   * ends the search -- that text is not one test unit.
   */
  const findTestCloser = (closer) => {
    const miss = closerMiss.get(closer);
    if (miss !== undefined && i >= miss.from && i <= miss.until) return -1;
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
      } else if (c === "'") {
        const end = src.indexOf("'", j + 1);
        j = end === -1 ? n : end + 1;
      } else if (c === '"') {
        j = skipDoubleQuoted(src, j + 1);
      } else if (c === "`") {
        j = readBacktick(src, j + 1).end;
      } else if (c === "$" && src[j + 1] === "(") {
        j = skipBalanced(src, j + 2, 1, "(", ")");
      } else if (c === "\n" || c === ";") {
        break;
      } else if (c === "&" || c === "|") {
        if (src[j + 1] !== c) break;
        j += 2;
      } else if (
        src.startsWith(closer, j) &&
        (src[j - 1] === " " || src[j - 1] === "\t") &&
        (j + closer.length >= n || WORD_BREAK.has(src[j + closer.length]))
      ) {
        return j;
      } else {
        j++;
      }
    }
    closerMiss.set(closer, { from: i, until: j });
    return -1;
  };

  const atCommandStart = () => {
    const last = tokens[tokens.length - 1];
    return (
      last === undefined ||
      last.kind === "op" ||
      (last.kind === "word" && RESERVED_PREFIXES.has(last.word.value))
    );
  };

  const emitOp = (value) => {
    pendingRedirect = null;
    tokens.push({ kind: "op", value });
  };
  const emitRedirect = (op, fd) => {
    const redirect = { kind: "redirect", op, fd, target: null, body: null };
    tokens.push(redirect);
    pendingRedirect = redirect;
  };

  const readHeredocBodies = () => {
    for (const redirect of heredocs) {
      const delimiter = redirect.target.value;
      const stripTabs = redirect.op === "<<-";
      const bodyStart = i;
      let body = null;
      while (i < n && body === null) {
        const newline = src.indexOf("\n", i);
        const lineStart = i;
        let line = src.slice(i, newline === -1 ? n : newline);
        if (stripTabs) line = line.replace(/^\t+/, "");
        i = newline === -1 ? n : newline + 1;
        if (line === delimiter) body = src.slice(bodyStart, lineStart);
      }
      redirect.body = body ?? src.slice(bodyStart);
    }
    heredocs.length = 0;
  };

  const expandDollar = (word) => {
    const next = src[i + 1];
    if (next === "(") {
      let end;
      if (src[i + 2] === "(") {
        end = skipBalanced(src, i + 3, 2, "(", ")");
      } else if (depth < MAX_DEPTH) {
        const inner = lex(src, i + 2, depth + 1, true, notes);
        word.subs.push(inner.tokens);
        end = inner.end;
      } else {
        addNote(notes, NESTING_NOTE);
        end = skipBalanced(src, i + 2, 1, "(", ")");
      }
      word.value += src.slice(i, end);
      word.dynamic = true;
      i = end;
    } else if (next === "{") {
      const end = skipBalanced(src, i + 2, 1, "{", "}");
      word.value += src.slice(i, end);
      word.dynamic = true;
      i = end;
    } else {
      if (next !== undefined && PARAMETER_START.test(next)) {
        word.dynamic = true;
      }
      word.value += "$";
      i++;
    }
  };

  const expandBacktick = (word) => {
    const { inner, end } = readBacktick(src, i + 1);
    if (depth < MAX_DEPTH) {
      word.subs.push(lex(inner, 0, depth + 1, false, notes).tokens);
    } else {
      addNote(notes, NESTING_NOTE);
    }
    word.value += src.slice(i, end);
    word.dynamic = true;
    i = end;
  };

  const readDoubleQuoted = (word) => {
    i++;
    while (i < n && src[i] !== '"') {
      const c = src[i];
      if (c === "\\" && i + 1 < n && DOUBLE_QUOTE_ESCAPABLE.has(src[i + 1])) {
        if (src[i + 1] !== "\n") word.value += src[i + 1];
        i += 2;
      } else if (c === "$") {
        expandDollar(word);
      } else if (c === "`") {
        expandBacktick(word);
      } else {
        word.value += c;
        i++;
      }
    }
    i++;
  };

  const readWord = () => {
    const word = newWord();
    const wordStart = i;
    while (i < n && !WORD_BREAK.has(src[i])) {
      const c = src[i];
      if (c === "\\") {
        if (i + 1 < n && src[i + 1] !== "\n") word.value += src[i + 1];
        i += 2;
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        word.value += src.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else if (c === "$" && src[i + 1] === "'") {
        let j = i + 2;
        while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
        word.value += src.slice(i + 2, Math.min(j, n));
        i = j + 1;
      } else if (c === '"') {
        readDoubleQuoted(word);
      } else if (c === "$") {
        expandDollar(word);
      } else if (c === "`") {
        expandBacktick(word);
      } else {
        if (
          word.globAt === -1 &&
          (c === "*" || c === "?" || c === "[" || c === "{")
        ) {
          word.globAt = word.value.length;
        }
        if (c === "~" && i === wordStart) word.tilde = true;
        word.value += c;
        i++;
      }
    }
    return word;
  };

  const readRedirect = (fd) => {
    const op = REDIRECT_OPS.find((candidate) => src.startsWith(candidate, i));
    i += op.length;
    emitRedirect(op, fd);
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "\\" && next === "\n") {
      i += 2;
    } else if (c === "\n") {
      emitOp("\n");
      i++;
      if (heredocs.length > 0) readHeredocBodies();
    } else if (c === "#") {
      const newline = src.indexOf("\n", i);
      i = newline === -1 ? n : newline;
    } else if (c === ")") {
      if (nested && parens === 0) return { tokens, end: i + 1 };
      parens = Math.max(0, parens - 1);
      emitOp(")");
      i++;
    } else if (c === "(") {
      if (next === "(") {
        // `(( ... ))` arithmetic: never a redirect, never a command.
        i = skipBalanced(src, i + 2, 2, "(", ")");
        emitOp(";");
      } else {
        parens++;
        emitOp("(");
        i++;
      }
    } else if (c === ";") {
      emitOp(";");
      i += next === ";" || next === "&" ? 2 : 1;
    } else if (c === "&") {
      if (next === "&") {
        emitOp("&&");
        i += 2;
      } else if (next === ">") {
        const op = src[i + 2] === ">" ? "&>>" : "&>";
        i += op.length;
        emitRedirect(op, null);
      } else {
        emitOp("&");
        i++;
      }
    } else if (c === "|") {
      emitOp(next === "|" ? "||" : "|");
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (c === "<" || c === ">") {
      readRedirect(null);
    } else {
      let digitsEnd = i;
      while (digitsEnd < n && src[digitsEnd] >= "0" && src[digitsEnd] <= "9") {
        digitsEnd++;
      }
      if (digitsEnd > i && (src[digitsEnd] === "<" || src[digitsEnd] === ">")) {
        const fd = src.slice(i, digitsEnd);
        i = digitsEnd;
        readRedirect(fd);
      } else {
        const commandStart = !pendingRedirect && atCommandStart();
        const wordStart = i;
        const word = readWord();
        if (pendingRedirect) {
          pendingRedirect.target = word;
          if (HEREDOC_OPS.has(pendingRedirect.op)) {
            heredocs.push(pendingRedirect);
          }
          pendingRedirect = null;
        } else {
          tokens.push({ kind: "word", word });
          // `[[ ... ]]` / `[ ... ]`: one unit, so `<`, `>`, `&&` and `||`
          // inside the test expression are neither redirects nor
          // separators -- but its words are still lexed, so a `$(...)` or
          // backtick substitution inside is collected for analysis.
          const closer = TEST_CLOSERS.get(src.slice(wordStart, i));
          const closeAt =
            commandStart && closer !== undefined ? findTestCloser(closer) : -1;
          if (closer !== undefined && closeAt !== -1) {
            while (i < closeAt) {
              const inner = src[i];
              if (inner === " " || inner === "\t" || TEST_INERT.has(inner)) {
                i++;
              } else {
                tokens.push({ kind: "word", word: readWord() });
              }
            }
            tokens.push({
              kind: "word",
              word: { ...newWord(), value: closer },
            });
            i = Math.max(i, closeAt + closer.length);
          }
        }
      }
    }
  }
  return { tokens, end: n };
}

// ---------------------------------------------------------------------------
// Bash detector -- path resolution
// ---------------------------------------------------------------------------

function basenameOf(name) {
  return name.slice(name.lastIndexOf("/") + 1);
}

/** Lexical resolution: `null` when `text` is relative and the cwd is unknown. */
function resolveAgainst(base, text) {
  if (isAbsoluteLike(text)) return posix.normalize(text);
  if (base === null) return null;
  return posix.normalize(`${base}/${text}`);
}

function isInsideProject(absPath, projectDir) {
  const root = projectDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const path = absPath.replace(/\\/g, "/").toLowerCase();
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Returns the resolved path when `text` names a guarded path (or a guarded
 * directory itself, e.g. `packages/cli/src/`), else null. With an unknown
 * cwd (after a `cd` the lexer could not follow) a relative path is matched
 * as-is -- the conservative side.
 */
function protectedPathString(text, ctx, base) {
  if (text === "" || text.startsWith("~")) return null;
  const resolved = resolveAgainst(base, text) ?? posix.normalize(text);
  if (resolved.startsWith("/dev/")) return null;
  const scope = isAbsoluteLike(resolved) ? ctx.projectDir : undefined;
  return isProtectedPath(resolved, scope) ||
    isProtectedPath(`${resolved}/`, scope)
    ? resolved
    : null;
}

function protectedTarget(word, ctx, base = ctx.cwd) {
  if (!word || word.dynamic || word.tilde) return null;
  if (word.globAt === -1) return protectedPathString(word.value, ctx, base);
  // Every expansion of a glob lives under its literal directory prefix, so
  // that prefix (plus a placeholder entry) decides -- as does the whole
  // path with each globbed segment a placeholder (`packages/*/src`). The
  // glob is reported.
  const prefix = word.value.slice(0, word.globAt);
  const entry = `${prefix.slice(0, prefix.lastIndexOf("/") + 1)}__glob__`;
  const placeholders = word.value
    .split("/")
    .map((segment) => (GLOB_CHAR.test(segment) ? "__glob__" : segment))
    .join("/");
  if (
    !protectedPathString(entry, ctx, base) &&
    !protectedPathString(placeholders, ctx, base)
  ) {
    return null;
  }
  return resolveAgainst(base, word.value) ?? word.value;
}

function firstProtected(words, ctx, rule, base = ctx.cwd) {
  for (const word of words) {
    const path = protectedTarget(word, ctx, base);
    if (path) return { path, rule };
  }
  return null;
}

// Workspace container directories: `<container>` and `<container>/<pkg>`
// each hold a whole package's src/tests beneath them.
const WORKSPACE_CONTAINERS = ["packages", "apps", "libs"];
const GUARDED_DIRS = ["src", "tests"];
const GLOB_CHAR = /[*?[{]/;
const MATCH_ANY = /^/;

/**
 * A matcher for one glob path segment. Brace expansion, and a character
 * class the RegExp engine rejects, both match anything -- the conservative
 * side for a guard.
 */
function globMatcher(pattern) {
  if (pattern.includes("{")) return MATCH_ANY;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const classEnd = c === "[" ? pattern.indexOf("]", i + 2) : -1;
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (classEnd !== -1) {
      const body = pattern.slice(i + 1, classEnd);
      const negate = body.startsWith("!") || body.startsWith("^");
      const members = (negate ? body.slice(1) : body).replace(
        /[\\\]^]/g,
        "\\$&",
      );
      source += `[${negate ? "^" : ""}${members}]`;
      i = classEnd;
    } else source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    // An out-of-order range (`[z-a]`): unmatchable for the shell too, but
    // matching anything here is the safe side.
    return MATCH_ANY;
  }
}

/** `resolved` relative to the project root; null when it lies outside it. */
function projectRelative(resolved, ctx) {
  if (isAbsoluteLike(resolved)) {
    if (!isInsideProject(resolved, ctx.projectDir)) return null;
    const root = ctx.projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
    return resolved.replace(/\\/g, "/").slice(root.length);
  }
  // Unknown cwd: a relative path is read as project-relative (conservative).
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

/**
 * True when project-relative `segments` name a directory that CONTAINS a
 * guarded tree: the project root (a flat layout's own src/tests), a
 * workspace container, or a package directly inside one. Only the last
 * segment is read as a glob (a mid-path glob is an opaque package name),
 * and only by what its PARENT is: under the project root it counts when it
 * could expand to `src`, `tests` or a container (`*`); under a workspace
 * container it always counts, since it may name a package (`packages/c*`);
 * under a package it counts when it could expand to `src` or `tests`
 * (`packages/cli/*`). Under anything else (`dist/*`, `packages/cli/dist/*`)
 * it never does.
 */
function containsGuardedTree(segments, globbed) {
  const n = segments.length;
  if (n === 0) return true;
  const last = segments[n - 1];
  const isContainer = (k) =>
    k >= 0 && WORKSPACE_CONTAINERS.includes(segments[k]);
  if (globbed && GLOB_CHAR.test(last)) {
    const matcher = globMatcher(last);
    const matchesAny = (names) => names.some((name) => matcher.test(name));
    if (n === 1) return matchesAny([...WORKSPACE_CONTAINERS, ...GUARDED_DIRS]);
    if (isContainer(n - 2)) return true;
    return isContainer(n - 3) && matchesAny(GUARDED_DIRS);
  }
  return isContainer(n - 1) || isContainer(n - 2);
}

/**
 * The resolved path when `word` names an ANCESTOR of a guarded directory
 * (see containsGuardedTree), else null. `root` reports the project root.
 */
function ancestorTarget(word, ctx, base = ctx.cwd) {
  if (!word || word.dynamic || word.tilde || word.value === "") return null;
  const resolved =
    resolveAgainst(base, word.value) ?? posix.normalize(word.value);
  if (resolved.startsWith("/dev/")) return null;
  const relative = projectRelative(resolved, ctx);
  if (relative === null) return null;
  const segments = relative
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  return containsGuardedTree(segments, word.globAt !== -1)
    ? { path: resolved, root: segments.length === 0 }
    : null;
}

function firstAncestor(words, ctx, rule) {
  for (const word of words) {
    const hit = ancestorTarget(word, ctx);
    if (hit) return { path: hit.path, rule, ancestor: true };
  }
  return null;
}

/** A source operand that copies a directory's CONTENTS (`dir/`, `dir/.`) or an unknown name. */
function copiedName(source) {
  if (source.dynamic || source.tilde || source.globAt !== -1) return null;
  if (source.value.endsWith("/")) return null;
  const name = basenameOf(source.value);
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * A cp/rsync/install/ln/mv destination that is an ancestor of a guarded
 * directory. Into a directory known to exist (the project root, a trailing
 * `/`, a `-t` target or several sources) each source lands as
 * `dest/<basename>`, blocked when that is guarded or itself an ancestor, or
 * when the source's name is unknown or it copies a directory's contents.
 * Any other ancestor destination may be a rename that creates the whole
 * tree, and is blocked.
 */
function ancestorDestination(name, sources, destination, into, ctx) {
  const dest = ancestorTarget(destination, ctx);
  if (!dest) return null;
  const hit = { path: dest.path, rule: name, ancestor: true };
  const knownDir =
    into ||
    dest.root ||
    destination.value.endsWith("/") ||
    destination.value.endsWith("/.");
  if (!knownDir) return hit;
  for (const source of sources) {
    const copied = copiedName(source);
    if (copied === null) return hit;
    const child = { ...newWord(), value: `${dest.path}/${copied}` };
    if (protectedTarget(child, ctx) || ancestorTarget(child, ctx)) return hit;
  }
  return null;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sizeNote(absPath) {
  return `size cap (${MAX_READ_BYTES} bytes) exceeded; ${absPath} was not scanned`;
}

/**
 * The default reader: a regular file of at most MAX_READ_BYTES. A file that
 * does not exist (ENOENT) is nothing to scan and is not noted; any other
 * failure -- a directory, a permission error -- is noted as a `read` gap.
 */
function readFromDisk(ctx, absPath) {
  let stats;
  try {
    stats = statSync(absPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      addNote(ctx.notes, `could not read ${absPath}: ${errorText(error)}`);
    }
    return null;
  }
  if (!stats.isFile()) {
    addNote(ctx.notes, `could not read ${absPath}: not a regular file`);
    return null;
  }
  if (stats.size > MAX_READ_BYTES) {
    addNote(ctx.notes, sizeNote(absPath));
    return null;
  }
  try {
    return readFileSync(absPath, "utf8");
  } catch (error) {
    addNote(ctx.notes, `could not read ${absPath}: ${errorText(error)}`);
    return null;
  }
}

function safeRead(ctx, absPath) {
  if (ctx.readFile === null) return readFromDisk(ctx, absPath);
  let text;
  try {
    text = ctx.readFile(absPath);
  } catch (error) {
    // An injected reader that throws is a read gap, noted -- the detector
    // itself does not throw on its account.
    addNote(ctx.notes, `could not read ${absPath}: ${errorText(error)}`);
    return null;
  }
  if (typeof text !== "string") return null;
  if (text.length > MAX_READ_BYTES) {
    addNote(ctx.notes, sizeNote(absPath));
    return null;
  }
  return text;
}

/** Reads the file a word names; with `trustProject`, a file inside the project is not read. */
function readTarget(word, ctx, trustProject, base = ctx.cwd) {
  if (!word || word.dynamic || word.tilde || word.globAt !== -1) return null;
  const absPath = resolveAgainst(base, word.value);
  if (absPath === null) return null;
  if (trustProject && isInsideProject(absPath, ctx.projectDir)) return null;
  return safeRead(ctx, absPath);
}

/** The text a command reads on stdin: the last heredoc, here-string or `<` file. */
function stdinText(redirects, ctx, trustProject) {
  let text = null;
  for (const redirect of redirects) {
    if (!redirect.target || (redirect.fd !== null && redirect.fd !== "0")) {
      continue;
    }
    if (HEREDOC_OPS.has(redirect.op)) text = redirect.body ?? "";
    else if (redirect.op === "<<<") text = redirect.target.value;
    else if (redirect.op === "<") {
      text = readTarget(redirect.target, ctx, trustProject);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Bash detector -- option parsing
// ---------------------------------------------------------------------------

function sliceWord(word, offset) {
  return {
    ...word,
    value: word.value.slice(offset),
    tilde: word.value[offset] === "~",
    globAt: word.globAt >= offset ? word.globAt - offset : -1,
    subs: [],
  };
}

const NO_OPTIONS = new Set();

/**
 * A getopt-ish split of `args` into options and operands. `withArg` names
 * options taking a value (attached or as the next word); `optionalRest`
 * names short options whose value can only be attached (`sed -i.bak`).
 * With `stopAtOperand`, parsing stops at the first operand and `rest` holds
 * it and everything after.
 */
function getopt(args, withArg = NO_OPTIONS, settings = {}) {
  const optionalRest = settings.optionalRest ?? NO_OPTIONS;
  const options = [];
  const operands = [];
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i];
    const value = word.value;
    if (value === "--") {
      i++;
      break;
    }
    if (!value.startsWith("-") || value === "-") {
      if (settings.stopAtOperand) break;
      operands.push(word);
      continue;
    }
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      if (eq !== -1) {
        options.push({
          name: value.slice(0, eq),
          value: sliceWord(word, eq + 1),
        });
      } else if (withArg.has(value)) {
        options.push({ name: value, value: args[i + 1] ?? null });
        i++;
      } else {
        options.push({ name: value, value: null });
      }
      continue;
    }
    for (let c = 1; c < value.length; c++) {
      const name = `-${value[c]}`;
      if (withArg.has(name) || optionalRest.has(name)) {
        if (c + 1 < value.length) {
          options.push({ name, value: sliceWord(word, c + 1) });
        } else if (withArg.has(name)) {
          options.push({ name, value: args[i + 1] ?? null });
          i++;
        } else {
          options.push({ name, value: null });
        }
        break;
      }
      options.push({ name, value: null });
    }
  }
  const rest = args.slice(i);
  return { options, operands: [...operands, ...rest], rest };
}

function optionValues(options, ...names) {
  return options
    .filter((option) => names.includes(option.name) && option.value !== null)
    .map((option) => option.value);
}

function hasOption(options, ...names) {
  return options.some((option) => names.includes(option.name));
}

// ---------------------------------------------------------------------------
// Bash detector -- per-command analysis
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;
const RESERVED_PREFIXES = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
]);
const WRAPPERS = new Map([
  [
    "sudo",
    {
      withArg: new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D"]),
    },
  ],
  ["env", { withArg: new Set(["-u", "-C", "-S", "-P", "--unset", "--chdir"]) }],
  ["nohup", { withArg: NO_OPTIONS }],
  ["time", { withArg: NO_OPTIONS }],
  ["command", { withArg: NO_OPTIONS }],
  ["exec", { withArg: new Set(["-a"]) }],
  ["nice", { withArg: new Set(["-n", "--adjustment"]) }],
  [
    "xargs",
    {
      withArg: new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a"]),
      optionalRest: new Set(["-i", "-l", "-e"]),
    },
  ],
  ["builtin", { withArg: NO_OPTIONS }],
]);

/** Drops leading assignments, reserved words and wrapper commands. */
function stripPrefixes(words) {
  let k = 0;
  while (k < words.length) {
    const word = words[k];
    if (ASSIGNMENT.test(word.value) || RESERVED_PREFIXES.has(word.value)) {
      k++;
      continue;
    }
    const name = basenameOf(word.value);
    const wrapper = word.dynamic ? undefined : WRAPPERS.get(name);
    if (!wrapper) break;
    const { options, rest } = getopt(words.slice(k + 1), wrapper.withArg, {
      optionalRest: wrapper.optionalRest,
      stopAtOperand: true,
    });
    // `command -v x` only looks `x` up; it runs nothing.
    if (name === "command" && hasOption(options, "-v", "-V")) return [];
    k = words.length - rest.length;
  }
  return words.slice(k);
}

const COPY_ARGS = new Map([
  ["cp", new Set(["-t", "--target-directory", "-S", "--suffix"])],
  [
    "install",
    new Set([
      "-m",
      "--mode",
      "-o",
      "--owner",
      "-g",
      "--group",
      "-t",
      "--target-directory",
      "-S",
      "--suffix",
    ]),
  ],
  [
    "rsync",
    new Set([
      "-e",
      "--rsh",
      "-f",
      "--filter",
      "-T",
      "--temp-dir",
      "-B",
      "--block-size",
      "--exclude",
      "--include",
      "--exclude-from",
      "--include-from",
      "--files-from",
      "--rsync-path",
      "-M",
      "--remote-option",
    ]),
  ],
  ["ln", new Set(["-t", "--target-directory", "-S", "--suffix"])],
  ["mv", new Set(["-t", "--target-directory", "-S", "--suffix"])],
]);
const REMOVE_ARGS = new Map([
  ["rm", NO_OPTIONS],
  ["unlink", NO_OPTIONS],
  ["rmdir", NO_OPTIONS],
  ["touch", new Set(["-r", "--reference", "-d", "--date", "-t"])],
  ["truncate", new Set(["-s", "--size", "-r", "--reference"])],
]);
const SED_ARGS = new Set([
  "-e",
  "--expression",
  "-f",
  "--file",
  "-l",
  "--line-length",
]);
const PATCH_ARGS = new Set([
  "-p",
  "--strip",
  "-d",
  "--directory",
  "-i",
  "--input",
  "-o",
  "--output",
  "-r",
  "--reject-file",
  "-B",
  "--prefix",
  "-z",
  "--suffix",
  "-F",
  "--fuzz",
  "-D",
  "--ifdef",
  "-V",
  "--version-control",
  "-Y",
  "--basename-prefix",
]);
const PATCH_DRY = ["--dry-run", "--check", "-C"];
const GIT_GLOBAL_ARGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);
const GIT_APPLY_ARGS = new Set([
  "-p",
  "-C",
  "--directory",
  "--exclude",
  "--include",
  "--whitespace",
  "--build-fake-ancestor",
]);
const GIT_APPLY_DRY = ["--check", "--stat", "--numstat", "--summary"];
const SHELL_ARGS = new Set(["-o", "-O"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const INTERPRETER =
  /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|deno|bun|ruby|perl|php)$/;
const PYTHON_ARGS = new Set(["-c", "-m", "-W", "-X", "-Q"]);
const NODE_ARGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--input-type",
  "-C",
  "--conditions",
  "--env-file",
  "--title",
]);
const RUBY_ARGS = new Set(["-e", "-r", "-I", "-C", "-E", "-F"]);
const PERL_ARGS = new Set(["-e", "-E", "-M", "-m", "-I"]);
const PERL_OPTIONAL = new Set(["-i", "-0", "-l", "-C", "-x", "-d", "-D"]);
const PHP_ARGS = new Set(["-r", "-f", "-c", "-d", "-z"]);

// A write-verb CALL in interpreter code; the argument list after the `(`
// is then split and only the written-position argument is checked.
// Delete, move and truncate calls count as writes too.
const WRITE_CALL =
  /\b(Deno\.writeTextFileSync|Deno\.writeTextFile|Deno\.removeSync|Deno\.remove|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|file_put_contents|copyFileSync|copyFile|cpSync|cp|copy|renameSync|rename|openSync|open|fopen|truncateSync|truncate|rmSync|rm|rmdirSync|rmdir|unlinkSync|unlink|shutil\.copy\w*|shutil\.move|shutil\.rmtree|os\.rename|os\.replace|os\.remove|os\.removedirs|File\.delete|FileUtils\.rm\w*|(?:File|IO|Bun)\.write)\s*\(/g;
// Verbs that remove or move a whole directory tree: an ANCESTOR of a
// guarded directory as their target counts too (see containsGuardedTree).
const TREE_VERB =
  /^(?:Deno\.removeSync|Deno\.remove|rmSync|rm|renameSync|rename|shutil\.move|shutil\.rmtree|os\.rename|os\.replace|FileUtils\.rm\w*)$/;
// `\b` keeps `remove` (os.remove, Deno.remove) from reading as a move.
const MOVE_VERB = /rename|replace|\bmove/;
// `Path('...').write_text(...)`, `.unlink()`, `.rename(...)`...: the
// receiver is written, removed or moved.
const PATH_RECEIVER_WRITE =
  /\bPath\s*\(\s*[rRbBuU]?(['"])([^'"\n]{0,4096})\1\s*\)\s*\.(write_text|write_bytes|touch|unlink|rmdir|rename|replace)\s*\(/g;
// A whole argument that is one string literal (optionally a `kw=` keyword
// argument, optionally a Python string prefix).
const LITERAL_ARG = /^(?:\w+\s*=\s*)?[rRbBuU]{0,2}(['"`])([^'"`\n]*)\1$/;
// An fopen-style mode that writes: contains w, a, x, c (php) or +.
const WRITE_MODE = /^[rbtU]*[waxc+][rwaxcbtU+]*$/;
// perl's open modes, alone (3-arg form) or prefixed to the path (2-arg form).
const PERL_MODE_ONLY = /^(?:\+?>{1,2}|\+<)$/;
const PERL_MODE_PATH = /^(?:\+?>{1,2}|\+<)\s*(\S.*)$/;
// perl's paren-less 2-arg form: `open F, ">path"` / `open my $fh, ">path"`.
const PERL_BARE_OPEN =
  /\bopen\s+(?:my\s+)?\$?\w+\s*,\s*(['"])(?:\+?>{1,2}|\+<)\s*([^'"\n]{1,4096})\1/g;
const KWARG = /^\s*\w+\s*=[^=]/;
const MODE_KWARG = /^\s*mode\s*=[^=]/;
// An argument list longer than this is not split (keeps the scan linear).
const MAX_CALL_CHARS = 1000;
const CALL_SIZE_NOTE = `call size cap (${MAX_CALL_CHARS} chars) exceeded; an interpreter write call's arguments were not analysed`;
const SRC_OR_TESTS_SEGMENT = /(?:^|\/)(?:src|tests)(?:\/|$)/;
const PATCH_HEADER = /^(?:\+\+\+ |--- |diff --git )(.*)$/gm;

/** Index just past the quoted string opening at `i` (backslash-aware). */
function skipQuoted(code, i) {
  const quote = code[i];
  let j = i + 1;
  while (j < code.length && code[j] !== quote) j += code[j] === "\\" ? 2 : 1;
  return j;
}

/** One linear pass: the index of each `(`'s matching `)`, quotes skipped. */
function matchParens(code) {
  const close = new Map();
  const open = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === "`") i = skipQuoted(code, i);
    else if (c === "(") open.push(i);
    else if (c === ")" && open.length > 0) close.set(open.pop(), i);
  }
  return close;
}

/**
 * Splits the top-level arguments of the call whose `(` is at `openAt`;
 * null when it never closes or spans more than MAX_CALL_CHARS (so a flood
 * of unclosed calls stays linear). A call past the cap is noted in `notes`
 * -- it is allowed unscreened, but never silently.
 */
function splitArgs(code, openAt, parens, notes) {
  const closeAt = parens.get(openAt);
  if (closeAt === undefined) return null;
  if (closeAt - openAt > MAX_CALL_CHARS) {
    addNote(notes, CALL_SIZE_NOTE);
    return null;
  }
  const args = [];
  let depth = 0;
  let argStart = openAt + 1;
  for (let i = argStart; i < closeAt; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === "`") i = skipQuoted(code, i);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(code.slice(argStart, i));
      argStart = i + 1;
    }
  }
  args.push(code.slice(argStart, closeAt));
  return args;
}

function literalOf(arg) {
  if (typeof arg !== "string") return null;
  const match = LITERAL_ARG.exec(arg.trim());
  if (!match || match[2].includes("${")) return null;
  return match[2];
}

/** The literal path(s) a call writes, by verb and argument position. */
function writtenLiterals(verb, args) {
  if (verb === "open" || verb === "openSync" || verb === "fopen") {
    // A `mode=` keyword argument wins wherever it sits; otherwise the
    // second argument, unless that is some other keyword argument.
    const modeArg =
      args.find((arg) => MODE_KWARG.test(arg)) ??
      (KWARG.test(args[1] ?? "") ? undefined : args[1]);
    const mode = literalOf(modeArg);
    if (mode === null) return [];
    if (PERL_MODE_ONLY.test(mode.trim())) return [literalOf(args[2])];
    const perlPath = PERL_MODE_PATH.exec(mode);
    if (perlPath) return [perlPath[1]];
    return WRITE_MODE.test(mode) ? [literalOf(args[0])] : [];
  }
  if (MOVE_VERB.test(verb)) return [literalOf(args[0]), literalOf(args[1])];
  if (/^(?:copy|cp|shutil\.copy)/.test(verb)) return [literalOf(args[1])];
  // writeFile/appendFile/file_put_contents/createWriteStream/File|IO|Bun.write
  // and every delete/truncate verb: the first.
  return [literalOf(args[0])];
}

/**
 * Interpreter code: blocked only when a write verb's WRITTEN argument (not
 * any literal anywhere) is a string literal naming a guarded path.
 */
function scanCode(code, ctx, rule) {
  const check = (literal, tree) => {
    if (literal === null) return null;
    const text = literal.trim();
    if (SRC_OR_TESTS_SEGMENT.test(text)) {
      const path = protectedPathString(text, ctx, ctx.cwd);
      if (path) return { path, rule };
    }
    if (!tree) return null;
    const ancestor = ancestorTarget({ ...newWord(), value: text }, ctx);
    return ancestor ? { path: ancestor.path, rule, ancestor: true } : null;
  };
  for (const match of code.matchAll(PATH_RECEIVER_WRITE)) {
    const hit = check(match[2], MOVE_VERB.test(match[3]));
    if (hit) return hit;
  }
  for (const match of code.matchAll(PERL_BARE_OPEN)) {
    const hit = check(match[2], false);
    if (hit) return hit;
  }
  let parens = null;
  for (const match of code.matchAll(WRITE_CALL)) {
    parens ??= matchParens(code);
    const args = splitArgs(
      code,
      match.index + match[0].length - 1,
      parens,
      ctx.notes,
    );
    if (!args) continue;
    const tree = TREE_VERB.test(match[1]);
    for (const literal of writtenLiterals(match[1], args)) {
      const hit = check(literal, tree);
      if (hit) return hit;
    }
  }
  return null;
}

/** Patch text: blocked when a `diff --git`/`---`/`+++` header names a guarded path. */
function scanPatch(text, base, ctx, rule) {
  for (const match of text.matchAll(PATCH_HEADER)) {
    const candidates = match[0].startsWith("diff")
      ? match[1].split(" ")
      : [match[1].split("\t")[0].trim()];
    for (const candidate of candidates) {
      const path = candidate.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
      if (path === "" || path === "/dev/null") continue;
      const hit = protectedPathString(path, ctx, base);
      if (hit) return { path: hit, rule };
    }
  }
  return null;
}

function interpreterSource(name, args) {
  if (name.startsWith("python")) {
    const { options, rest } = getopt(args, PYTHON_ARGS, {
      stopAtOperand: true,
    });
    if (hasOption(options, "-m")) return { skip: true };
    const code = optionValues(options, "-c");
    return { code, script: rest[0] };
  }
  if (name === "node" || name === "nodejs" || name === "bun") {
    const { options, rest } = getopt(args, NODE_ARGS, { stopAtOperand: true });
    const operands =
      name === "bun" && rest[0]?.value === "run" ? rest.slice(1) : rest;
    const code = optionValues(options, "-e", "--eval", "-p", "--print");
    return { code, script: operands[0] };
  }
  if (name === "deno") {
    const { rest } = getopt(args, NO_OPTIONS, { stopAtOperand: true });
    if (rest[0]?.value === "eval")
      return { code: rest.slice(1, 2), script: undefined };
    const runArgs = rest[0]?.value === "run" ? rest.slice(1) : rest;
    const run = getopt(runArgs, NO_OPTIONS, { stopAtOperand: true });
    return { code: [], script: run.rest[0] };
  }
  if (name === "ruby") {
    const { options, rest } = getopt(args, RUBY_ARGS, { stopAtOperand: true });
    return { code: optionValues(options, "-e"), script: rest[0] };
  }
  if (name === "php") {
    const { options, rest } = getopt(args, PHP_ARGS, { stopAtOperand: true });
    const script = optionValues(options, "-f")[0] ?? rest[0];
    return { code: optionValues(options, "-r"), script };
  }
  // perl: in-place edits are handled by the caller; here only the code.
  const { options, operands } = getopt(args, PERL_ARGS, {
    optionalRest: PERL_OPTIONAL,
  });
  const code = optionValues(options, "-e", "-E");
  return { code, script: code.length > 0 ? undefined : operands[0] };
}

function analyseInterpreter(name, args, redirects, ctx) {
  if (name === "perl") {
    const { options, operands } = getopt(args, PERL_ARGS, {
      optionalRest: PERL_OPTIONAL,
    });
    if (hasOption(options, "-i")) {
      const files = hasOption(options, "-e", "-E")
        ? operands
        : operands.slice(1);
      const hit = firstProtected(files, ctx, name);
      if (hit) return hit;
    }
  }
  const source = interpreterSource(name, args);
  if (source.skip) return null;
  if (source.code.length > 0) {
    return scanCode(
      source.code.map((word) => word.value).join("\n"),
      ctx,
      name,
    );
  }
  const text =
    source.script && source.script.value !== "-"
      ? readTarget(source.script, ctx, true)
      : stdinText(redirects, ctx, true);
  return text ? scanCode(text, ctx, name) : null;
}

function analyseSed(args, ctx) {
  const { options, operands } = getopt(args, SED_ARGS, {
    optionalRest: new Set(["-i"]),
  });
  if (!hasOption(options, "-i", "--in-place")) return null;
  // BSD `sed -i '' ...` passes the (empty) backup suffix as its own word.
  const files = operands[0]?.value === "" ? operands.slice(1) : operands;
  const hasScript = hasOption(options, "-e", "--expression", "-f", "--file");
  return firstProtected(hasScript ? files : files.slice(1), ctx, "sed");
}

function analyseCopy(name, args, ctx) {
  const { options, operands } = getopt(args, COPY_ARGS.get(name));
  const targets =
    name === "rsync" ? [] : optionValues(options, "-t", "--target-directory");
  if (name === "mv") {
    const hit = firstProtected([...operands, ...targets], ctx, name);
    if (hit) return hit;
  } else if (name === "install" && hasOption(options, "-d", "--directory")) {
    return firstProtected(operands, ctx, name);
  }
  const into = targets.length > 0 || operands.length > 2;
  const sources = targets.length > 0 ? operands : operands.slice(0, -1);
  const destination =
    targets.length > 0 ? targets[targets.length - 1] : operands.at(-1);
  // A whole ancestor moved away takes its src/tests with it; so does
  // `rsync --remove-source-files`, which deletes every file it copied.
  const removesSources =
    name === "mv" ||
    (name === "rsync" && hasOption(options, "--remove-source-files"));
  if (removesSources) {
    const moved =
      (name === "rsync" ? firstProtected(sources, ctx, name) : null) ??
      firstAncestor(sources, ctx, name);
    if (moved) return moved;
  }
  if (targets.length > 0) {
    const hit = firstProtected(targets, ctx, name);
    if (hit) return hit;
  } else if (operands.length < 2) {
    return null;
  }
  // `host:path` is a remote rsync destination, never a local write.
  if (name === "rsync" && /^[^/]*:/.test(destination.value)) return null;
  return (
    firstProtected([destination], ctx, name) ??
    ancestorDestination(name, sources, destination, into, ctx)
  );
}

function analysePatch(args, redirects, ctx) {
  const rule = "patch";
  const { options, operands } = getopt(args, PATCH_ARGS);
  if (hasOption(options, ...PATCH_DRY)) return null;
  const directory = optionValues(options, "-d", "--directory")[0];
  let base = ctx.cwd;
  if (directory) {
    const hit = firstProtected([directory], ctx, rule);
    if (hit) return hit;
    base =
      directory.dynamic || directory.tilde
        ? null
        : resolveAgainst(ctx.cwd, directory.value);
  }
  const outputs = optionValues(options, "-o", "--output");
  const written = firstProtected(
    [...outputs, ...operands.slice(0, 1)],
    ctx,
    rule,
    base,
  );
  if (written) return written;
  const patchFile = optionValues(options, "-i", "--input")[0] ?? operands[1];
  const text =
    patchFile && patchFile.value !== "-"
      ? readTarget(patchFile, ctx, false)
      : stdinText(redirects, ctx, false);
  return text ? scanPatch(text, base, ctx, rule) : null;
}

function analyseGit(args, redirects, ctx) {
  const { options, rest } = getopt(args, GIT_GLOBAL_ARGS, {
    stopAtOperand: true,
  });
  if (rest[0]?.value !== "apply") return null;
  const rule = "patch (git apply)";
  let base = ctx.cwd;
  for (const dir of optionValues(options, "-C")) {
    base = dir.dynamic || dir.tilde ? null : resolveAgainst(base, dir.value);
  }
  const applyCtx = { ...ctx, cwd: base };
  const apply = getopt(rest.slice(1), GIT_APPLY_ARGS);
  if (hasOption(apply.options, ...GIT_APPLY_DRY)) return null;
  const directory = optionValues(apply.options, "--directory")[0];
  let root = base;
  if (directory) {
    const hit = firstProtected([directory], applyCtx, rule);
    if (hit) return hit;
    root =
      directory.dynamic || directory.tilde
        ? null
        : resolveAgainst(base, directory.value);
  }
  const files = apply.operands.filter((word) => word.value !== "-");
  const named = firstProtected(files, applyCtx, rule);
  if (named) return named;
  const texts =
    files.length > 0
      ? files.map((word) => readTarget(word, applyCtx, false))
      : [stdinText(redirects, applyCtx, false)];
  for (const text of texts) {
    const hit = text ? scanPatch(text, root, ctx, rule) : null;
    if (hit) return hit;
  }
  return null;
}

function analyseString(text, ctx, depth) {
  if (depth + 1 > MAX_DEPTH) {
    addNote(ctx.notes, NESTING_NOTE);
    return null;
  }
  return analyseTokens(
    lex(text, 0, depth + 1, false, ctx.notes).tokens,
    { ...ctx },
    depth + 1,
  );
}

function analyseShell(args, redirects, ctx, depth) {
  const { options, rest } = getopt(args, SHELL_ARGS, { stopAtOperand: true });
  if (hasOption(options, "-c")) {
    return rest[0] ? analyseString(rest[0].value, ctx, depth) : null;
  }
  if (rest.length > 0) return null;
  const text = stdinText(redirects, ctx, true);
  return text ? analyseString(text, ctx, depth) : null;
}

function changeDirectory(args, ctx) {
  const target = getopt(args).operands[0];
  if (!target || target.value === "-" || target.dynamic || target.tilde) {
    ctx.cwd = null;
    return;
  }
  ctx.cwd = resolveAgainst(ctx.cwd, target.value);
}

function analyseInvocation(name, args, redirects, ctx, depth) {
  if (INTERPRETER.test(name)) {
    return analyseInterpreter(name, args, redirects, ctx);
  }
  if (SHELLS.has(name)) return analyseShell(args, redirects, ctx, depth);
  if (COPY_ARGS.has(name)) return analyseCopy(name, args, ctx);
  if (REMOVE_ARGS.has(name)) {
    const { operands } = getopt(args, REMOVE_ARGS.get(name));
    return (
      firstProtected(operands, ctx, name) ??
      (name === "rm" ? firstAncestor(operands, ctx, name) : null)
    );
  }
  switch (name) {
    case "cd":
    case "pushd":
      changeDirectory(args, ctx);
      return null;
    case "popd":
      ctx.cwd = null;
      return null;
    case "tee":
      return firstProtected(getopt(args).operands, ctx, "tee");
    case "sed":
      return analyseSed(args, ctx);
    case "dd":
      return firstProtected(
        args
          .filter((word) => word.value.startsWith("of="))
          .map((word) => sliceWord(word, 3)),
        ctx,
        "dd",
      );
    case "patch":
      return analysePatch(args, redirects, ctx);
    case "git":
      return analyseGit(args, redirects, ctx);
    case "eval":
      return analyseString(
        args.map((word) => word.value).join(" "),
        ctx,
        depth,
      );
    default:
      return null;
  }
}

function isOutputRedirect(redirect) {
  if (!redirect.target) return false;
  if (OUTPUT_OPS.has(redirect.op)) return true;
  return redirect.op === ">&" && !/^(?:\d+|-)$/.test(redirect.target.value);
}

function analyseCommand(command, ctx, depth) {
  const nested = [
    ...command.words,
    ...command.redirects.map((redirect) => redirect.target),
  ];
  for (const word of nested) {
    for (const sub of word?.subs ?? []) {
      const hit = analyseTokens(sub, { ...ctx }, depth + 1);
      if (hit) return hit;
    }
  }
  const words = stripPrefixes(command.words);
  const head = words[0];
  if (head && !head.dynamic) {
    const hit = analyseInvocation(
      basenameOf(head.value),
      words.slice(1),
      command.redirects,
      ctx,
      depth,
    );
    if (hit) return hit;
    if (head.value === "[[" || head.value === "[") return null;
  }
  for (const redirect of command.redirects) {
    if (!isOutputRedirect(redirect)) continue;
    const path = protectedTarget(redirect.target, ctx);
    if (path) return { path, rule: "redirect" };
  }
  return null;
}

function analyseTokens(tokens, ctx, depth) {
  const savedCwds = [];
  let command = { words: [], redirects: [] };
  for (const token of tokens) {
    if (token.kind === "op") {
      const hit = analyseCommand(command, ctx, depth);
      if (hit) return hit;
      command = { words: [], redirects: [] };
      if (token.value === "(") savedCwds.push(ctx.cwd);
      else if (token.value === ")" && savedCwds.length > 0) {
        ctx.cwd = savedCwds.pop();
      }
    } else if (token.kind === "word") {
      command.words.push(token.word);
    } else {
      command.redirects.push(token);
    }
  }
  return analyseCommand(command, ctx, depth);
}

/**
 * Finds the first guarded path a Bash command visibly writes to -- exported
 * for unit testing. It never executes anything: the command is only lexed,
 * and the only filesystem access is reading a script located outside the
 * project or a named patch file. It is written so that no command text
 * makes it throw (reader failures become notes); the entry point still
 * wraps it in a fail-open catch in case that design has a hole.
 *
 * @param {string} command  The `tool_input.command` text.
 * @param {{ cwd: string, projectDir: string, readFile?: (absPath: string) => string | undefined, notes?: Set<string> }} opts
 *   `cwd` resolves relative paths; `projectDir` scopes absolute ones (see
 *   isProtectedPath); `readFile` defaults to a size-capped real read;
 *   `notes`, when given, receives one line per part of the command the
 *   detector could not analyse (`nesting`, `size`, `call size`, `read`).
 * @returns {{ path: string, rule: string, ancestor?: true } | null} The
 *   resolved path and the rule that matched (`redirect`, or the writing
 *   tool's name), or null. `ancestor` is set when the path is not itself
 *   guarded but CONTAINS a guarded tree (see containsGuardedTree).
 */
export function findBashWriteToProtectedPath(command, opts) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (!opts || typeof opts.projectDir !== "string") return null;
  const ctx = {
    cwd:
      typeof opts.cwd === "string" && opts.cwd !== ""
        ? posix.normalize(opts.cwd.replace(/\\/g, "/"))
        : null,
    projectDir: opts.projectDir,
    readFile: typeof opts.readFile === "function" ? opts.readFile : null,
    notes: opts.notes instanceof Set ? opts.notes : null,
  };
  return analyseTokens(lex(command, 0, 0, false, ctx.notes).tokens, ctx, 0);
}

/**
 * Bash counterpart of shouldBlockHubSrcWrite -- exported for unit testing.
 * Writer spokes are never blocked; any other caller is blocked when the
 * command writes into a guarded path.
 *
 * @param {string} command
 * @param {unknown} agentType  The top-level agent_type from the payload.
 * @param {{ cwd: string, projectDir: string, readFile?: (absPath: string) => string | undefined, notes?: Set<string> }} opts
 *   Same as findBashWriteToProtectedPath; `notes` stays empty for a writer
 *   spoke, whose command is not analysed at all.
 * @returns {{ path: string, rule: string } | null} The write to block, or null to allow.
 */
export function shouldBlockHubBashWrite(command, agentType, opts) {
  if (isWriterSpoke(agentType)) return null;
  return findBashWriteToProtectedPath(command, opts);
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

function runWriteGuard(input) {
  const filePath = input.tool_input?.file_path ?? "";
  const agentType = input.agent_type;
  // Canonicalized (case-correct, symlinks resolved) where the real
  // filesystem can confirm it -- isProtectedPath's own case-insensitive
  // comparison (see its doc comment) is the fallback for whatever a
  // not-yet-existing path can't be canonicalized against.
  const projectDir = canonicalize(
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  );
  // Only an ABSOLUTE filePath has a filesystem anchor worth canonicalizing --
  // canonicalize() resolves a relative path against this hook's own cwd,
  // which is not necessarily the project the write actually targets, and
  // isProtectedPath already matches a relative filePath as-is (see its doc
  // comment). Leaving a relative filePath unresolved here keeps that
  // contract instead of silently changing what it's compared against.
  const scopedFilePath =
    filePath && isAbsoluteLike(filePath) ? canonicalize(filePath) : filePath;
  if (!shouldBlockHubSrcWrite(scopedFilePath, agentType, projectDir)) {
    process.exit(0);
  }
  process.stderr.write(
    "guard-hub-src-writes: Hub-authored write to a guarded path detected.\n" +
      `  Path: ${filePath}\n` +
      "  Dispatch the write to 'code-implementer' (src/**) or 'test-author' (tests/**) instead.\n" +
      "  See: CLAUDE.md's Agent Operating Model.\n",
  );
  process.exit(2);
}

function runBashGuard(input) {
  const command = input.tool_input?.command;
  if (typeof command !== "string") {
    process.stderr.write(
      `guard-hub-src-writes: Bash payload has no string tool_input.command (got ${typeof command}); allowing without analysis.\n`,
    );
    process.exit(0);
  }
  const notes = new Set();
  let hit;
  try {
    // Both anchors canonicalized, so a payload cwd spelled through a
    // symlink (macOS's /var -> /private/var) still lands inside projectDir.
    const cwd = canonicalize(
      typeof input.cwd === "string" && input.cwd !== ""
        ? input.cwd
        : process.cwd(),
    );
    const projectDir = canonicalize(process.env.CLAUDE_PROJECT_DIR ?? cwd);
    hit = shouldBlockHubBashWrite(command, input.agent_type, {
      cwd,
      projectDir,
      notes,
    });
  } catch (error) {
    // Fail open -- a detector bug must never wedge every Bash call -- but
    // say so on stderr, with the stack, rather than allowing silently.
    process.stderr.write(
      `guard-hub-src-writes: Bash analysis failed (detector bug), allowing the command:\n${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(0);
  }
  if (!hit) {
    if (notes.size > 0) {
      process.stderr.write(
        `guard-hub-src-writes: allowed, but not fully analysed: ${[...notes].join("; ")}\n`,
      );
    }
    process.exit(0);
  }
  const what = hit.ancestor
    ? "writes, removes or replaces an ancestor of a guarded path (a directory with a guarded src/tests tree beneath it)"
    : "writes to a guarded path";
  process.stderr.write(
    `guard-hub-src-writes: Hub-authored Bash command ${what}.\n` +
      `  Path: ${hit.path}\n` +
      `  Rule: ${hit.rule}\n` +
      "  Why: hub-and-spoke -- a Bash write into a guarded src/tests path is refused for every caller except the writer spokes, the same allowlist as Write/Edit.\n" +
      "  Fix: dispatch the change to 'code-implementer' (src/**) or 'test-author' (tests/**).\n" +
      "  Override (maintainer): run the command yourself with the `!` prefix at the Claude Code prompt (not a tool call, so no hook runs), or edit/remove this hook's registration in .claude/settings.json.\n" +
      "  See: CLAUDE.md's Agent Operating Model.\n",
  );
  process.exit(2);
}

// Only run when invoked directly, not when imported for testing.
if (isEntryPoint()) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    process.stderr.write(
      `guard-hub-src-writes: unparseable hook payload (${errorText(error)}); allowing without analysis.\n`,
    );
    process.exit(0);
  }
  if (input === null || typeof input !== "object") {
    process.stderr.write(
      "guard-hub-src-writes: unparseable hook payload (not a JSON object); allowing without analysis.\n",
    );
    process.exit(0);
  }
  const isBash =
    input.tool_name === "Bash" ||
    (input.tool_name === undefined &&
      typeof input.tool_input?.command === "string");
  if (isBash) runBashGuard(input);
  else runWriteGuard(input);
}
