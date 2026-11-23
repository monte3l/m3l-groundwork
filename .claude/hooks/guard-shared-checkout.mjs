#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit|NotebookEdit, and Bash for git): implementation
 * happens in a linked git worktree off origin/main, never in a repository's
 * main checkout.
 *
 *  - Write|Edit|NotebookEdit: blocks when the file (`file_path`, or a
 *    notebook's `notebook_path`) belongs to a main worktree.
 *  - Bash: blocks `git commit`, `git switch -c|-C|--create` and
 *    `git checkout -b|-B` when the target (`git -C DIR`, a `cd DIR` before it,
 *    else the hook's `cwd`) is a main worktree. `git pull`, `git fetch` and
 *    `git worktree add` stay allowed: finishing-work pulls main, and worktrees
 *    are made from it.
 *
 * A path outside any git repository (plans, memory, scratchpad) passes. The
 * hook reads the directory from the input's `cwd`, never CLAUDE_PROJECT_DIR,
 * which stays at the starting root after a session enters a worktree. No path
 * is hardcoded, so the same script works in any repository.
 *
 * This is a guard against an agent's mistakes, not against someone trying to
 * get round it: a command built at run time (a variable, a sourced script) is
 * beyond a text parser. Within that, it reads a command line the way a shell
 * does, so text that only names a command (a commit message saying "a git
 * commit") is not a command. It looks through `bash -c '...'`, `eval`, a
 * here-document fed to a shell, `$(...)` and backticks, and it checks every
 * `git` word of a simple command, so a prefix such as `sudo`, `time`,
 * `if ...; then` or `xargs` does not hide it. Where it cannot tell, it errs
 * towards blocking: a `cd` that may or may not have moved the shell is checked
 * both ways, and a path built from a variable is judged from the hook's `cwd`,
 * unless the same command line set that variable to a literal value, outright
 * (`W=../wt; git -C "$W" commit`: not after `&&` or `||`, not inside `if`, `case`
 * or a brace group), which is then used. A command word that is an expansion
 * (`$G commit`, `sudo $G commit`, `xargs $G commit`) is judged as a possible git.
 *
 * Blocks by exiting 2 with a message on stderr. It fails open on input it
 * cannot read; settings.json marks it `onFailure: block` for a crash.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HINT =
  "Work in a worktree off origin/main: EnterWorktree, or `git worktree add ../<repo>.wt/<branch> -b <branch> origin/main`.";

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Nearest existing directory at or above `target`. */
function existingDir(target) {
  let dir = path.resolve(target);
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** The repository's top level when `dir` is in its main worktree, else null. */
export function mainWorktreeOf(target) {
  const dir = existingDir(target);
  if (!dir) return null;
  const out = git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  if (!out) return null;
  const [gitDir, common, top] = out.split("\n");
  if (!gitDir || !common || !top) return null;
  return fs.realpathSync(gitDir) === fs.realpathSync(common) ? top : null;
}

const WRITING = [
  /^commit$/,
  /^switch$/, // narrowed below to -c/-C/--create
  /^checkout$/, // narrowed below to -b/-B
];

const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/;
const SHELL = /(^|\/)(sh|bash|zsh|dash|ksh)$/;
const SHELL_COMMAND_FLAG = /^-[a-z]*c[a-z]*$/;

/**
 * Index of the parenthesis closing the one at `open`, or the last index. It
 * skips quoted text and escapes, and counts a `$(` inside double quotes.
 */
function closingParen(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      i = end === -1 ? line.length : end;
    } else if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === "$" && line[i + 1] === "(")
          i = closingParen(line, i + 1);
      }
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  return line.length - 1;
}

/** A shell run with no `-c`, so it reads its commands from input. */
const readsInput = (words) => {
  const shell = words.findIndex((w) => SHELL.test(w));
  return (
    shell >= 0 && !words.some((w, i) => i > shell && SHELL_COMMAND_FLAG.test(w))
  );
};

/**
 * Splits a command line into simple commands, each a list of words, the way a
 * shell reads it: quotes group words and are removed, `&&`, `||`, `;`, `|`,
 * `&`, parentheses, backticks and newlines end a command, and the body of a
 * here-document is skipped, unless a shell reads input, when it is read as
 * commands. A `$(...)` or backtick inside double quotes runs, so its body is
 * read as commands too.
 *
 * `seps[i]` is the separator before `commands[i]` (`&&`, `||`, `;`, `|`, `&`,
 * a newline or `(`). `grouped` is true when the line has a subshell or a
 * substitution, which makes a `cd` in it unreliable.
 *
 * @returns {{ commands: string[][], seps: string[], grouped: boolean }}
 */
export function simpleCommands(line) {
  const commands = [];
  const seps = [];
  const heredocs = [];
  const bodies = [];
  const nested = [];
  let grouped = false;
  let words = [];
  let word = null;
  let quote = null;
  let sep = ";";
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = (next) => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
      seps.push(sep);
    } else if (next === "\n" && (sep === "&&" || sep === "||" || sep === "|")) {
      // A newline right after `&&`, `||` or `|` continues the list: the next command
      // is still joined to the last one by it, so it stays conditional.
      return;
    }
    words = [];
    sep = next;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === "$" && line[i + 1] === "(") {
        const end = closingParen(line, i + 1);
        nested.push(line.slice(i + 2, end));
        word += line.slice(i, end + 1);
        i = end;
      } else if (quote === '"' && c === "`") {
        const close = line.indexOf("`", i + 1);
        const end = close === -1 ? line.length : close;
        nested.push(line.slice(i + 1, end));
        word += line.slice(i, end + 1);
        i = end;
      } else if (c === "\\" && quote === '"' && i + 1 < line.length) {
        word += line[++i];
      } else {
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "\n") {
      endCommand("\n");
      for (const { delimiter, indented } of heredocs.splice(0)) {
        const body = [];
        for (;;) {
          const end = line.indexOf("\n", i + 1);
          const text = line.slice(i + 1, end === -1 ? line.length : end);
          i = end === -1 ? line.length : end;
          const same =
            (indented ? text.replace(/^\t+/, "") : text) === delimiter;
          if (same || end === -1) break;
          body.push(text);
        }
        bodies.push(body.join("\n"));
      }
    } else if (c === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
      // `$((` is arithmetic only if it closes with `))`; else it is `$(` + `(`.
      // Either way a `<<` inside is not a here-document.
      const end = closingParen(line, i + 1);
      if (line.slice(end - 1, end + 1) !== "))") {
        nested.push(line.slice(i + 2, end));
        grouped = true;
      }
      word = (word ?? "") + "0";
      i = end;
    } else if (c === "$" && line[i + 1] === "(") {
      // A substitution stays one word, `$(...)`, so `git $(echo commit)` has an
      // unreadable subcommand and `$(echo git) commit` an unreadable command
      // word, which `gitWriteAt` and `gitWrites` judge as writing. Its body runs
      // as commands of its own.
      const end = closingParen(line, i + 1);
      nested.push(line.slice(i + 2, end));
      word = (word ?? "") + line.slice(i, end + 1);
      grouped = true;
      i = end;
    } else if (c === "`") {
      // Same for a backtick substitution: one word, body judged on its own.
      const close = line.indexOf("`", i + 1);
      const end = close === -1 ? line.length : close;
      nested.push(line.slice(i + 1, end));
      word = (word ?? "") + line.slice(i, end + 1);
      grouped = true;
      i = end;
    } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = HEREDOC.exec(line.slice(i));
      if (m) {
        heredocs.push({
          delimiter: m[2] ?? m[3] ?? m[4],
          indented: m[1] === "-",
        });
        endWord();
        i += m[0].length - 1;
      }
    } else if (c === "&" || c === "|") {
      const double = line[i + 1] === c;
      endCommand(double ? c + c : c);
      if (double) i++;
    } else if (c === ";") {
      endCommand(";");
    } else if (c === "(" || c === ")") {
      grouped = true;
      endCommand("(");
    } else {
      word = (word ?? "") + c;
    }
  }
  endCommand(";");
  // A here-document that a shell reads is a script, not text.
  if (commands.some(readsInput)) nested.push(...bodies);
  for (const body of nested) {
    const inner = simpleCommands(body);
    commands.push(...inner.commands);
    seps.push(...inner.seps);
    grouped = true;
  }
  return { commands, seps, grouped };
}

/**
 * The simple commands to judge: each one, plus what a shell wrapper runs
 * (`bash -c '...'`, `eval ...`), read as commands in turn. `top` is false for
 * a nested one.
 *
 * @returns {{ words: string[], sep: string, top: boolean }[]}
 */
export function expandCommands(commands, seps, top = true) {
  const out = [];
  commands.forEach((words, index) => {
    out.push({ words, sep: seps[index] ?? ";", top });
    const shell = words.findIndex((w) => SHELL.test(w));
    if (shell >= 0) {
      const flag = words.findIndex(
        (w, i) => i > shell && SHELL_COMMAND_FLAG.test(w),
      );
      if (flag >= 0 && words[flag + 1] !== undefined) {
        const inner = simpleCommands(words[flag + 1]);
        out.push(...expandCommands(inner.commands, inner.seps, false));
      }
    }
    const evalAt = words.indexOf("eval");
    if (evalAt >= 0) {
      const inner = simpleCommands(words.slice(evalAt + 1).join(" "));
      out.push(...expandCommands(inner.commands, inner.seps, false));
    }
  });
  return out;
}

const isGit = (w) => w === "git" || w.endsWith("/git");

/** The writing git command whose word is at `at`, with the directory it uses. */
function gitWriteAt(words, at, cwd) {
  let dir = cwd;
  let i = at + 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && words[i + 1]) {
      dir = path.resolve(dir, words[i + 1]);
      i += 2;
    } else if (words[i] === "-c") {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = words[i];
  // A subcommand that is still an expansion (`git $S`) cannot be read: judge it
  // as a writing command rather than approve it.
  if (sub && /[$`]/.test(sub)) return { dir, sub };
  if (!sub || !WRITING.some((re) => re.test(sub))) return null;
  const rest = words.slice(i + 1);
  if (
    sub === "switch" &&
    !rest.some((w) => /^(-c|-C|--create|--force-create)$/.test(w))
  )
    return null;
  if (sub === "checkout" && !rest.some((w) => /^(-b|-B)$/.test(w))) return null;
  return { dir, sub };
}

/**
 * Words a shell command may start with that run what follows them: `sudo $G
 * commit`, `time $G commit`, `env X=1 $G commit`, `xargs $G commit`,
 * `if true; then $G commit`. The command word is the first one after them, their
 * options, their `NAME=value` words and a bare number (`timeout 5`, `nice -n 5`).
 */
const COMMAND_PREFIXES = new Set([
  "sudo", "doas", "time", "command", "builtin", "exec", "nohup", "env", "xargs",
  "nice", "ionice", "timeout", "stdbuf", "setsid", "if", "then", "do", "else",
  "elif", "while", "until", "!", "{",
]);

/** The index of the word a simple command runs, after the prefixes above, or -1. */
function commandWordAt(words) {
  let afterPrefix = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (COMMAND_PREFIXES.has(w.slice(w.lastIndexOf("/") + 1))) {
      afterPrefix = true;
    } else if (/^[A-Za-z_]\w*=/.test(w)) {
      // a `NAME=value` word before the command
    } else if (!(afterPrefix && (/^-/.test(w) || /^\d+$/.test(w)))) {
      // Options and numbers belong to a prefix (`nice -n 5`, `timeout 5`); a user name after
      // `sudo -u` is not skipped, so a command after it is not seen: a limit of a text parser.
      return i;
    }
  }
  return -1;
}

/** An expansion (`$G`, `${G}`, a backtick) where a command word is: it may be git. */
const EXPANSION_WORD = /^(?:\$|`)/;

/** Every writing git command in one simple command, from every `git` word. */
export function gitWrites(words, cwd) {
  const hits = [];
  const commandAt = commandWordAt(words);
  words.forEach((word, at) => {
    // A command word that is an expansion (`$G commit`, `sudo $G commit`) may be git.
    if (!isGit(word) && !(at === commandAt && EXPANSION_WORD.test(word))) return;
    const hit = gitWriteAt(words, at, cwd);
    if (hit) hits.push(hit);
  });
  return hits;
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^$`*?~\s]*)$/;

/**
 * The variable a simple command sets to a literal value (`W=../wt`), or null.
 * A value built from another expansion, a glob or `~` is not literal.
 */
export function literalAssignment(words) {
  const text = words[0] === "export" ? words.slice(0, 2).join(" ") : words[0];
  if (words.length !== (words[0] === "export" ? 2 : 1)) return null;
  const m = ASSIGNMENT.exec(text);
  return m ? { name: m[1], value: m[2] } : null;
}

/** Words that set, bind or read a variable in a way the parser does not model. */
const VARIABLE_WORDS = new Set([
  "source", ".", "eval", "declare", "typeset", "local", "read", "mapfile",
  "readarray", "getopts", "let", "unset", "for", "while", "until", "select",
  "coproc", "readonly", "nameref",
]);

const isGitWord = (w) => w === "git" || w.endsWith("/git");

/**
 * Words that open, close or continue a compound command. A literal assignment
 * inside one (`if false; then W=wt; fi`) may never run, and a line with any of
 * them is not one the parser models.
 */
const CONTROL_WORDS = new Set([
  "if", "then", "else", "elif", "fi", "case", "esac", "do", "done", "{", "}", "!",
  "while", "until", "for", "select",
]);

/**
 * The literal `VAR=value` assignments of a command line that may be trusted,
 * as a Map, or an empty Map. Deliberately conservative: one doubtful thing
 * anywhere in the line clears the whole map, and the guard then judges from
 * `cwd`, as it does for a variable it knows nothing about.
 *
 * A name is kept only if (a) it is set once, by a plain literal at an
 * unconditional position of a top-level command (the line start, `;` or a
 * newline, and not piped or backgrounded, with no `&&` or `||` anywhere before
 * it, a newline after one included), and (b) it appears nowhere else in
 * the line except as `$NAME` or `${NAME}` in the operand of `git -C` or `cd`,
 * after the assignment. Any other word that contains `=`, any word that is or
 * contains a `source`, `.`, `eval`, `declare`, `read`, `for`, `while`... token,
 * a compound-command keyword (`if`, `then`, `fi`, `case`, `do`, `done`, `{`, `}`,
 * `!`), `printf -v`, or an `export` with an expansion, clears the map.
 *
 * @param {{ words: string[], sep: string, top: boolean }[]} entries
 * @returns {Map<string, string>}
 */
export function trustedVars(entries, grouped) {
  const none = new Map();
  if (grouped) return none;
  if (entries.some((entry) => entry.words.some((word) => CONTROL_WORDS.has(word)))) return none;
  const found = [];
  entries.forEach((entry, index) => {
    if (!entry.top || (entry.sep !== ";" && entry.sep !== "\n")) return;
    // Anything that came before it joined by `&&` or `||` may have decided that this never runs.
    if (entries.slice(0, index + 1).some((earlier) => earlier.sep === "&&" || earlier.sep === "||")) return;
    const next = entries[index + 1];
    if (next && next.top && (next.sep === "|" || next.sep === "&")) return;
    const assigned = literalAssignment(entry.words);
    if (assigned) found.push({ ...assigned, index });
  });
  const assignmentAt = new Set(found.map((f) => f.index));
  const names = found.map((f) => f.name);
  if (new Set(names).size !== names.length) return none;
  for (const [index, { words, top }] of entries.entries()) {
    if (assignmentAt.has(index)) continue;
    for (const [at, word] of words.entries()) {
      if (word.includes("=")) return none;
      for (const token of word.split(/[\s;|&(){}`$<>"']+/)) {
        if (VARIABLE_WORDS.has(token)) return none;
      }
      if (word === "-v" && words[0] === "printf") return none;
      if (words[0] === "export" && /[$`]/.test(word)) return none;
      for (const { name, index: set } of found) {
        if (!word.includes(name)) continue;
        const operand =
          top &&
          index > set &&
          ((words[0] === "cd" && at === 1) ||
            (words[at - 1] === "-C" && words.slice(0, at).some(isGitWord)));
        const ref = new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "g");
        if (!operand || word.replace(ref, "").includes(name)) return none;
      }
    }
  }
  return new Map(found.map((f) => [f.name, f.value]));
}

/** `$NAME` and `${NAME}` replaced by a literal value seen earlier; others stay. */
export function expandVars(word, vars) {
  if (vars.size === 0 || !word.includes("$")) return word;
  return word.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (whole, a, b) => vars.get(a ?? b) ?? whole,
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function block(message) {
  process.stderr.write(`Blocked: ${message} ${HINT}\n`);
  process.exit(2);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  // Valid JSON that is not an object (`null`, a string, a number) or fields of
  // the wrong type are not a payload this hook understands. A crash would be
  // read as a failure and, under `onFailure: block`, block the tool call.
  if (input === null || typeof input !== "object" || Array.isArray(input))
    process.exit(0);
  const str = (value) => (typeof value === "string" ? value : "");
  const toolInput =
    input.tool_input !== null && typeof input.tool_input === "object"
      ? input.tool_input
      : {};
  const cwd = str(input.cwd) || process.cwd();
  const tool = str(input.tool_name);

  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    const filePath = str(toolInput.file_path) || str(toolInput.notebook_path);
    if (filePath) {
      const top = mainWorktreeOf(path.resolve(cwd, filePath));
      if (top) block(`\`${filePath}\` is in the main checkout of ${top}.`);
    }
  } else if (tool === "Bash") {
    const command = str(toolInput.command);
    const { commands, seps, grouped } = simpleCommands(command);
    // The directories the next command may run in. A top-level `cd DIR` is only
    // followed when it is certain to have moved the shell: joined to the next
    // command by `&&` (if the cd fails, that command never runs). After `;`, a
    // newline, a pipe or `&` the shell may or may not have moved, so both places
    // are checked; after `||` the next command runs only if the cd failed, so
    // only the old place counts. With a subshell or a substitution in the line,
    // or a path built from a variable, a `cd` is ignored.
    let dirs = [cwd];
    let pending = null;
    // Literal `VAR=value` assignments of the line, so `W=../wt; git -C "$W"
    // commit` is judged in the directory it names and not in `cwd`. See
    // `trustedVars`: anything doubtful leaves the map empty.
    const entries = expandCommands(commands, seps);
    const vars = trustedVars(entries, grouped);
    for (const { words: raw, sep, top: topLevel } of entries) {
      const assigned = topLevel ? literalAssignment(raw) : null;
      if (assigned && vars.get(assigned.name) === assigned.value) continue;
      const words =
        topLevel && !grouped ? raw.map((w) => expandVars(w, vars)) : raw;
      if (pending && topLevel) {
        dirs =
          sep === "&&"
            ? pending.moved
            : sep === "||"
              ? pending.before
              : [...new Set([...pending.before, ...pending.moved])];
        pending = null;
      }
      if (
        topLevel &&
        !grouped &&
        words[0] === "cd" &&
        words[1] &&
        !/^-|[$~*?]/.test(words[1])
      ) {
        const moved = dirs
          .map((d) => path.resolve(d, words[1]))
          .filter(isDirectory);
        pending = { before: dirs, moved: moved.length > 0 ? moved : dirs };
        continue;
      }
      for (const dir of dirs) {
        for (const hit of gitWrites(words, dir)) {
          const top = mainWorktreeOf(hit.dir);
          if (top)
            block(
              `\`git ${hit.sub}\` would run in the main checkout of ${top}.`,
            );
        }
      }
    }
  }
  process.exit(0);
}
