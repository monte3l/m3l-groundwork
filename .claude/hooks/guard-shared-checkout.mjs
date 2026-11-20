#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit, and Bash for git): implementation happens in a
 * linked git worktree off origin/main, never in a repository's main checkout.
 *
 *  - Write|Edit: blocks when the file belongs to a main worktree.
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
 * both ways, and a path built from a variable is judged from the hook's `cwd`.
 *
 * Blocks by exiting 2 with a message on stderr. It fails open on input it
 * cannot read; settings.json marks it `onFailure: block` for a crash.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
    } else if (c === "(" || c === ")" || c === "`") {
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

/** Every writing git command in one simple command, from every `git` word. */
export function gitWrites(words, cwd) {
  const hits = [];
  words.forEach((word, at) => {
    if (!isGit(word)) return;
    const hit = gitWriteAt(words, at, cwd);
    if (hit) hits.push(hit);
  });
  return hits;
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

if (import.meta.url === `file://${process.argv[1]}`) {
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

  if (tool === "Write" || tool === "Edit") {
    const filePath = str(toolInput.file_path);
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
    for (const { words, sep, top: topLevel } of expandCommands(
      commands,
      seps,
    )) {
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
