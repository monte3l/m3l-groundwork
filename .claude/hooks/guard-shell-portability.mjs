#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * PreToolUse guard (Bash): blocks a command that is certain to fail in the
 * shell Claude Code runs it in, because it was written for bash or GNU
 * tools. About 950 Bash calls failed this way in 28 days across the org's
 * repositories, mostly the same few mistakes, and each cost a turn.
 *
 * Every rule fires only where the failure is certain, never where it is
 * merely possible. A glob that is attached to a flag (`--include=*.ts`) can
 * never match a file, so zsh always stops on it. A plain path glob such as
 * `docs/*.md` is checked against the directory the session is in, and only in
 * the first command of a line that never changes directory or shell options:
 * a later command may have created the files, so there it is left alone.
 *
 *   zsh (when $SHELL is zsh)
 *     - an unquoted `*` or `?` in a `--flag=value` word: `no matches found`
 *     - an unquoted `?name=` in a word, a URL query string: `no matches found`
 *     - a plain path glob that matches nothing in the working directory
 *     - a variable assigned a quoted multi-word string and then used unquoted
 *       as a command word, after `for x in`, or after `set --`: zsh does not
 *       split it, so the command, the loop or the arguments are wrong
 *   macOS (BSD tools)
 *     - `sed -i SCRIPT`: BSD `sed` takes SCRIPT as the backup suffix
 *     - `cat -A`: BSD `cat` has no `-A`
 *     - `head -n 0` and `head -n -N`: BSD `head` rejects a count of 0 or less
 *
 * Left out on purpose: an unquoted word that starts with `=` (`echo =====`).
 * It failed in every session until 19 November 2026 and ran fine after, so it
 * depends on a zsh option this hook cannot see, and a guard must not block a
 * command that works.
 *
 * The shell and the platform are read from the environment and passed in, so
 * Linux and bash users never see a false positive and the tests run anywhere.
 *
 * Fail closed on a payload that cannot be read, like the other guards (the
 * entry sets onFailure: "block"). Fail open on everything else: a command this
 * file cannot parse is allowed, because a bug here must not lock every Bash
 * call. This is a tokenizer for the cases above, not a shell grammar.
 */
import process from "node:process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A quoted or substituted character, in a word's `bare` text. A glob character
// that is still in `bare` was typed unquoted.
const Q = "\u0000";
const MAX_DEPTH = 8;

/** Index of the `)` that closes the `(` at `open`, skipping quotes. Throws if none. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") i++;
    else if (ch === "'") i = src.indexOf("'", i + 1);
    else if (ch === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
    if (i < 0 || i >= src.length) break;
  }
  throw new Error("unbalanced parenthesis");
}

/**
 * Split a command line into simple commands. Each command is a list of words
 * `{ value, bare }`: `value` is the text with quotes removed, `bare` is the same
 * with each quoted or substituted part collapsed to one `Q`. A `$( )` or
 * backtick body is parsed as commands of its own. A here-document body is
 * dropped. Throws on a construct it cannot read, which the caller treats as
 * "allow".
 *
 * @param {string} src
 * @param {number} [depth]
 * @returns {{ value: string, bare: string }[][]}
 */
export function parseCommands(src, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("nested too deep");
  const commands = [];
  const heredocs = [];
  let words = [];
  let value = "";
  let bare = "";
  let open = false;

  const add = (v, b = v) => {
    value += v;
    bare += b;
    open = true;
  };
  const endWord = () => {
    if (open) words.push({ value, bare });
    value = "";
    bare = "";
    open = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const nested = (body) => commands.push(...parseCommands(body, depth + 1));

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "\\") {
      if (next !== "\n" && next !== undefined) add(next, Q);
      i += 2;
    } else if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated quote");
      add(src.slice(i + 1, end), Q);
      i = end + 1;
    } else if (ch === '"') {
      let text = "";
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          text += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(" && src[j + 2] !== "(") {
          const close = matchParen(src, j + 1);
          nested(src.slice(j + 2, close));
          text += src.slice(j, close + 1);
          j = close + 1;
        } else {
          text += src[j++];
        }
      }
      if (j >= src.length) throw new Error("unterminated quote");
      add(text, Q);
      i = j + 1;
    } else if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end < 0) throw new Error("unterminated backtick");
      nested(src.slice(i + 1, end));
      add(src.slice(i, end + 1), Q);
      i = end + 1;
    } else if (ch === "$" && next === "(") {
      const close = matchParen(src, i + 1);
      // `$(( ))` is arithmetic, not a command
      if (src[i + 2] !== "(") nested(src.slice(i + 2, close));
      add(src.slice(i, close + 1), Q);
      i = close + 1;
    } else if (ch === "$" && next === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) throw new Error("unterminated expansion");
      const raw = src.slice(i, end + 1);
      add(raw, raw.replace(/[*?[]/g, Q));
      i = end + 1;
    } else if (ch === "#" && !open) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === " " || ch === "\t") {
      endWord();
      i++;
    } else if (ch === "\n") {
      endCommand();
      let pos = i + 1;
      for (const hd of heredocs) {
        while (pos < src.length) {
          const stop = src.indexOf("\n", pos);
          const line = src.slice(pos, stop < 0 ? src.length : stop);
          pos = stop < 0 ? src.length : stop + 1;
          if ((hd.strip ? line.replace(/^\t+/, "") : line) === hd.delim) break;
        }
      }
      heredocs.length = 0;
      i = pos;
    } else if (ch === "<" && next === "<" && src[i + 2] !== "<" && src[i + 2] !== "(") {
      let j = i + 2;
      const strip = src[j] === "-";
      if (strip) j++;
      while (src[j] === " " || src[j] === "\t") j++;
      const quote = src[j] === "'" || src[j] === '"' ? src[j] : "";
      const stop = quote ? src.indexOf(quote, j + 1) : j + src.slice(j).search(/[\s;&|()<>]|$/);
      if (stop < 0) throw new Error("unterminated here-document tag");
      heredocs.push({ delim: src.slice(quote ? j + 1 : j, stop), strip });
      i = quote ? stop + 1 : stop;
      endWord();
    } else if (ch === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || next === ">")) {
      add(ch);
      i++;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      endCommand();
      i++;
    } else {
      add(ch);
      i++;
    }
  }
  endCommand();
  return commands;
}

const RESERVED = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "}", "time"]);
const WRAPPERS = new Set(["env", "command", "sudo", "nohup", "exec"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const isBare = (w) => w.bare === w.value;
/** Is `text` one or more quoted placeholders and nothing else? (No regex: a control character in one trips `no-control-regex`.) */
const allQuoted = (text) => text.length > 0 && [...text].every((c) => c === Q);

/** Index of the command word: past `do`, `if`, `!`, `VAR=x` prefixes and `env`-like wrappers. */
function headIndex(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (isBare(w) && (RESERVED.has(w.value) || ASSIGNMENT.test(w.value) || WRAPPERS.has(w.value))) i++;
    else break;
  }
  return i;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Is there whitespace outside any `$( )`, backtick or `${ }` in a quoted string? Only that is certainly several words. */
function hasLiteralSpace(text) {
  return /\s/.test(text.replace(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{[^}]*\}/g, ""));
}

// A plain path glob: letters, digits and a few path characters, with `*` or `?`. No brackets, braces, `~` or `$`.
const PATH_GLOB = /^[A-Za-z0-9_.@%+,/-]*[*?][A-Za-z0-9_.@%+,/*?-]*$/;
const MOVES_OR_CONFIGURES = new Set(["cd", "pushd", "popd", "setopt", "unsetopt", "noglob", "emulate", "source", "."]);

/** Does a plain path glob match at least one entry under `cwd`, as zsh would expand it? `**` and a trailing `/` are not handled. */
function globMatches(pattern, cwd) {
  const parts = pattern.split("/");
  const absolute = pattern.startsWith("/");
  let bases = [absolute ? "/" : cwd];
  for (let k = absolute ? 1 : 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === "") continue;
    if (!/[*?]/.test(part)) {
      bases = bases.map((b) => path.join(b, part)).filter((p) => existsSync(p));
    } else {
      const re = new RegExp(
        `^${[...part].map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[\\^$.|+(){}[\]]/g, "\\$&"))).join("")}$`,
      );
      const next = [];
      for (const base of bases) {
        let names;
        try {
          names = readdirSync(base);
        } catch {
          continue;
        }
        for (const n of names) if (re.test(n) && (part.startsWith(".") || !n.startsWith("."))) next.push(path.join(base, n));
      }
      bases = next;
    }
    if (bases.length === 0) return false;
  }
  return true;
}

/** `NAME` of a word that is an unquoted `$NAME` or `${NAME}`, else null. */
function plainVariable(word) {
  if (!isBare(word)) return null;
  const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(word.value);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * Describe each way `command` is certain to fail. Empty when it is fine, when
 * the environment is neither zsh nor macOS, or when it cannot be read.
 *
 * @param {string} command
 * @param {{ shell?: string, platform?: string }} [env]
 * @returns {string[]}
 */
export function findProblems(command, { shell = "", platform = "", cwd = "" } = {}) {
  const zsh = /(^|\/)zsh$/.test(shell);
  const mac = platform === "darwin";
  if (!zsh && !mac) return [];
  let commands;
  try {
    commands = parseCommands(command);
  } catch {
    return [];
  }

  const problems = [];
  const seen = new Set();
  const report = (key, text) => {
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(text);
  };
  // Variables holding a quoted string with spaces, in the order the line sets them.
  const multiword = new Set();
  // A glob is only checked against the files on disk in the first command of a line that never
  // changes directory or shell options: a later command may have created the files, and a `cd`
  // moves the directory the glob is read in.
  const staticLine = !commands.some((w) => MOVES_OR_CONFIGURES.has(w[headIndex(w)]?.value));
  const splitMessage = (name) =>
    `\`$${name}\` holds several words and zsh does not split it. Use an array (\`${name}=(a b)\` and \`"\${${name}[@]}"\`), \`\${=${name}}\` for one deliberate split, or write each argument out.`;

  for (const words of commands) {
    const h = headIndex(words);
    const head = words[h];
    const name = head && isBare(head) ? head.value : "";
    const isTest = words.some((w) => w.value === "[[" && isBare(w)) || name === "case";

    // Track assignments and `for` loops so a later use can be judged.
    for (const w of words.slice(0, h + 1)) {
      const eq = w.bare.indexOf("=");
      if (eq <= 0 || !NAME.test(w.bare.slice(0, eq))) continue;
      const quoted = allQuoted(w.bare.slice(eq + 1)) && hasLiteralSpace(w.value.slice(eq + 1));
      if (quoted) multiword.add(w.bare.slice(0, eq));
      else multiword.delete(w.bare.slice(0, eq));
    }
    if (name === "for" && words[h + 1] && NAME.test(words[h + 1].value) && words[h + 2]?.value === "in") {
      const items = words.slice(h + 3);
      if (items.some((w) => allQuoted(w.bare) && hasLiteralSpace(w.value))) multiword.add(words[h + 1].value);
      else multiword.delete(words[h + 1].value);
      for (const w of items) {
        const v = plainVariable(w);
        if (zsh && v && multiword.has(v)) report(`split:${v}`, splitMessage(v));
      }
    }

    if (zsh) {
      const v = head ? plainVariable(head) : null;
      if (v && multiword.has(v)) report(`split:${v}`, splitMessage(v));
      if (name === "set") {
        const dash = words.findIndex((w) => w.value === "--" && isBare(w));
        for (const w of dash < 0 ? [] : words.slice(dash + 1)) {
          const sv = plainVariable(w);
          if (sv && multiword.has(sv)) report(`split:${sv}`, splitMessage(sv));
        }
      }
      if (!isTest) {
        for (const w of words.slice(h + 1)) {
          if (
            cwd &&
            staticLine &&
            words === commands[0] &&
            isBare(w) &&
            PATH_GLOB.test(w.value) &&
            !w.value.startsWith("-") &&
            !w.value.endsWith("/") &&
            !w.value.includes("**") &&
            !ASSIGNMENT.test(w.value) &&
            !globMatches(w.value, cwd)
          ) {
            report(
              `nomatch:${w.value}`,
              `\`${w.value}\` matches nothing in ${cwd}. zsh stops with \`no matches found\` before the command starts. Check the path, or quote the pattern if the command should receive it.`,
            );
          } else if (/^--?[A-Za-z][\w-]*=.*[*?]/.test(w.bare)) {
            report(
              `glob:${w.value}`,
              `\`${w.value}\` has an unquoted \`*\` or \`?\`. zsh expands it before the command starts, nothing matches, and it stops with \`no matches found\`. Quote it: \`${w.value.replace(/=(.*)$/, "='$1'")}\`.`,
            );
          } else if (/\?[A-Za-z_][\w-]*=/.test(w.bare)) {
            report(`query:${w.value}`, `\`${w.value}\` has an unquoted \`?\` (a URL query string). zsh reads it as a glob and stops with \`no matches found\`. Quote the whole URL.`);
          }
        }
      }
    }

    if (mac) {
      const args = words.slice(h + 1);
      const at = (n) => args[n]?.value;
      if (name === "sed") {
        const k = args.findIndex((w) => w.value === "-i" && isBare(w));
        const after = k < 0 ? undefined : at(k + 1);
        if (after !== undefined && after !== "" && !after.startsWith(".")) {
          report("sed-i", "BSD `sed -i` takes the next word as the backup suffix, so `sed -i 's/a/b/' f` fails. Write `sed -i '' 's/a/b/' f`, or use the Edit tool.");
        }
      }
      if (name === "cat" && args.some((w) => isBare(w) && /^-[A-Za-z]*A/.test(w.value))) {
        report("cat-A", "BSD `cat` has no `-A`. Use `cat -vet` (it shows tabs as `^I` and line ends as `$`).");
      }
      if (name === "head") {
        const k = args.findIndex((w) => (w.value === "-n" || w.value === "-c") && isBare(w));
        if (k >= 0 && /^(0|-\d+)$/.test(at(k + 1) ?? "")) {
          report(
            "head-count",
            "BSD `head` rejects a count of 0 or less (`head -n 0`, `head -n -3`). To drop the last line use `sed '$d'`; to print nothing, skip the command.",
          );
        }
      }
    }
  }
  return problems;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Kept as a duplicated, self-contained block in every hook file rather than
// imported from a shared helper: each hook stays a single independent file.
// `import.meta.url` is symlink-resolved but `process.argv[1]` is not, so
// comparing them directly would be false under a symlinked invocation path,
// and the guard below would then never run, i.e. silently fail open.
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
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    process.stderr.write("[guard-shell-portability] could not read the hook payload; blocking.\n");
    process.exit(2);
  }

  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) process.exit(0);

  let problems = [];
  try {
    problems = findProblems(command, {
      shell: process.env.SHELL ?? "",
      platform: process.platform,
      cwd: typeof input.cwd === "string" ? input.cwd : "",
    });
  } catch {
    // A bug in the analysis must not block every Bash call.
    process.exit(0);
  }
  if (problems.length === 0) process.exit(0);

  process.stderr.write(
    `[guard-shell-portability] Blocked: this command would fail here.\n${problems.map((p) => `  - ${p}`).join("\n")}\nFix it and run it again.\n`,
  );
  process.exit(2);
}
