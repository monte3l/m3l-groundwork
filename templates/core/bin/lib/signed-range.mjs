/**
 * Shared git-signature helpers for the push-time guard.
 *
 * @see .claude/hooks/guard-git-push-signed.mjs -- the agent-side PreToolUse
 * hook that inspects a `git push` Bash command before it runs.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Signature codes that `git`'s `%G?` placeholder considers acceptable:
 *   G = a good (validly verified) signature,
 *   U = a good signature with unknown validity (signer key not in the local
 *       trust store) -- still cryptographically valid, so we accept it.
 * Everything else -- N (none), B (bad), E (cannot check), X/Y/R
 * (expired/revoked) -- is treated as unsigned/unverified.
 */
const VALID_SIGNATURE_CODES = new Set(["G", "U"]);

/** A git setting from the user's own scopes (global, then system), never a repository's. */
function userSetting(key) {
  for (const scope of ["--global", "--system"]) {
    try {
      const value = execFileSync("git", ["config", scope, "--get", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (value) return value;
    } catch {
      // not set in this scope
    }
  }
  return null;
}

let overrides;

/**
 * `-c` overrides for every git call. A repository's own config can name
 * programs that git then runs (`gpg.program` and its `gpg.ssh.program` and
 * `gpg.x509.program` siblings when a signature is checked, `core.fsmonitor`,
 * `core.hooksPath`), and the guard asks git about repositories that a command
 * line names. A `-c` setting wins over every config file, so the programs are
 * the ones the user's global or system config names, or the defaults, and the
 * rest are off.
 */
function safeOverrides() {
  overrides ??= [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", `gpg.program=${userSetting("gpg.program") ?? "gpg"}`,
    "-c", `gpg.openpgp.program=${userSetting("gpg.openpgp.program") ?? userSetting("gpg.program") ?? "gpg"}`,
    "-c", `gpg.ssh.program=${userSetting("gpg.ssh.program") ?? "ssh-keygen"}`,
    "-c", `gpg.x509.program=${userSetting("gpg.x509.program") ?? "gpgsm"}`,
  ];
  return overrides;
}

/**
 * Git runner for the repository at `dir` (the hook's own directory when
 * omitted); returns stdout as a string. Injectable for tests. stderr is
 * discarded so expected failures while probing candidate bases (e.g. "no
 * upstream configured") don't leak into the hook's output -- the throw is what
 * callers act on. Every call carries {@link safeOverrides}.
 *
 * @param {string} [dir]
 * @returns {(args: string[]) => string}
 */
export function gitRunner(dir) {
  return (args) =>
    execFileSync("git", [...safeOverrides(), ...(dir ? ["-C", dir] : []), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
}

/**
 * The directories whose repositories the guard may ask git about: the
 * top level of the repository the hook runs in, its worktrees, and
 * `projectDir` (CLAUDE_PROJECT_DIR) when given. A directory a command line
 * names that lies elsewhere is somebody else's repository: the guard does not
 * run git in it, and the push goes unvetted here, like a range it cannot work
 * out (the signed-commits ruleset on the remote still holds).
 *
 * @param {string} cwd
 * @param {string} [projectDir]
 * @param {(args: string[]) => string} [runGit] git in `cwd`
 * @returns {string[]} real paths
 */
export function trustedRoots(cwd, projectDir, runGit = gitRunner(cwd)) {
  const roots = new Set();
  const add = (dir) => {
    try {
      roots.add(realpathSync(dir));
    } catch {
      // gone, or not a path
    }
  };
  try {
    add(runGit(["rev-parse", "--show-toplevel"]).trim());
    for (const line of runGit(["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) add(line.slice("worktree ".length));
    }
  } catch {
    // not in a repository
  }
  if (projectDir) add(projectDir);
  return [...roots];
}

/**
 * Whether `dir` is one of `roots` or inside one.
 *
 * @param {string} dir
 * @param {string[]} roots from {@link trustedRoots}
 * @returns {boolean}
 */
export function isTrustedDir(dir, roots) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  return roots.some((root) => {
    const rel = path.relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

const defaultRunGit = gitRunner();

const SHELL = /(^|\/)(sh|bash|zsh|dash|ksh)$/;
const SHELL_COMMAND_FLAG = /^-[a-z]*c[a-z]*$/;

/** Index of the parenthesis closing the one at `open`, or the last index. */
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
      }
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  return line.length - 1;
}

/**
 * Splits a command line into simple commands, each a list of words, the way a
 * shell reads it: quotes group words and are removed, and `&&`, `||`, `;`, `|`,
 * `&`, parentheses and newlines end a command. What a command runs inside
 * `$(...)`, backticks, `bash -c '...'` or `eval ...` is read as commands too
 * (after the ones of the line itself), so a push in any of them is seen. A
 * comment is skipped. Text that only names a command (`echo 'git push'`) is one
 * word, not a command.
 *
 * @param {string} line
 * @param {number} [depth] nesting level, to bound the recursion
 * @returns {string[][]}
 */
export function simpleCommands(line, depth = 0) {
  const commands = [];
  if (depth > 6) return commands;
  const nested = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const substitution = (open, end, body) => {
    nested.push(body);
    word = (word ?? "") + line.slice(open, end + 1);
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === "$" && line[i + 1] === "(") {
        const end = closingParen(line, i + 1);
        substitution(i, end, line.slice(i + 2, end));
        i = end;
      } else if (quote === '"' && c === "`") {
        const close = line.indexOf("`", i + 1);
        const end = close === -1 ? line.length : close;
        substitution(i, end, line.slice(i + 1, end));
        i = end;
      } else if (quote === '"' && c === "\\" && i + 1 < line.length) {
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
      // A backslash before a newline joins the lines.
      if (line[i + 1] === "\n") i++;
      else word = (word ?? "") + line[++i];
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "#" && word === null) {
      const end = line.indexOf("\n", i);
      i = end === -1 ? line.length : end - 1;
    } else if (c === "$" && line[i + 1] === "(") {
      const end = closingParen(line, i + 1);
      substitution(i, end, line.slice(i + 2, end));
      i = end;
    } else if (c === "`") {
      const close = line.indexOf("`", i + 1);
      const end = close === -1 ? line.length : close;
      substitution(i, end, line.slice(i + 1, end));
      i = end;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
    } else {
      word = (word ?? "") + c;
    }
  }
  endCommand();
  for (const body of nested) commands.push(...simpleCommands(body, depth + 1));
  for (const words of [...commands]) {
    const shell = words.findIndex((w) => SHELL.test(w));
    if (shell >= 0) {
      const flag = words.findIndex((w, i) => i > shell && SHELL_COMMAND_FLAG.test(w));
      if (flag >= 0 && words[flag + 1] !== undefined) {
        commands.push(...simpleCommands(words[flag + 1], depth + 1));
      }
    }
    const evalAt = words.indexOf("eval");
    if (evalAt >= 0) commands.push(...simpleCommands(words.slice(evalAt + 1).join(" "), depth + 1));
  }
  return commands;
}

// `git` global options that consume the following token as their argument, so
// we can skip past them when hunting for the subcommand (e.g. `git -c k=v push`).
const GLOBAL_OPTS_WITH_ARG = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

// The long options of `git push`, with whether each takes a value. Git matches a
// long option by any unique prefix (`--mir`, `--dry`), and `--no-NAME` negates
// one. A value is the next token (`-o -n` pushes the option string "-n", it is
// not a dry run) unless the option was written `--name=value`; an optional value
// is only ever attached with `=`.
const PUSH_LONG_OPTIONS = new Map([
  ["all", "none"],
  ["branches", "none"],
  ["mirror", "none"],
  ["delete", "none"],
  ["tags", "none"],
  ["follow-tags", "none"],
  ["prune", "none"],
  ["atomic", "none"],
  ["dry-run", "none"],
  ["porcelain", "none"],
  ["force", "none"],
  ["force-with-lease", "optional"],
  ["force-if-includes", "none"],
  ["thin", "none"],
  ["verbose", "none"],
  ["quiet", "none"],
  ["progress", "none"],
  ["verify", "none"],
  ["set-upstream", "none"],
  ["signed", "optional"],
  ["recurse-submodules", "required"],
  ["push-option", "required"],
  ["repo", "required"],
  ["receive-pack", "required"],
  ["exec", "required"],
  ["ipv4", "none"],
  ["ipv6", "none"],
]);

/** `refs/tags/NAME` with nothing that makes it a revision expression: no `^`, `~`, `@{`, `{`, `:` or glob. */
const PLAIN_TAG_REF = /^refs\/tags\/[^^~:@{}*?[\\\s]+$/;

/** Short options of `git push`; `o` takes a value. */
const PUSH_SHORT_OPTIONS = new Set("fnuqvd46o");

/**
 * The long option `name` (no dashes, no `=value`) stands for: an exact name, or
 * a unique prefix of one, with `no-` for a negation. Null when it is unknown or
 * ambiguous (git refuses both, so a push using one does not happen, but the
 * guard must not take it for something harmless).
 *
 * @param {string} name
 * @returns {{ name: string, takes: string, negated: boolean } | null}
 */
function resolveLongOption(name) {
  if (PUSH_LONG_OPTIONS.has(name)) return { name, takes: PUSH_LONG_OPTIONS.get(name), negated: false };
  const negated = name.startsWith("no-");
  const bare = negated ? name.slice(3) : name;
  if (bare === "") return null;
  if (negated && PUSH_LONG_OPTIONS.has(bare)) return { name: bare, takes: "none", negated };
  const hits = [...PUSH_LONG_OPTIONS.keys()].filter((option) => option.startsWith(bare));
  if (hits.length !== 1) return null;
  return { name: hits[0], takes: negated ? "none" : PUSH_LONG_OPTIONS.get(hits[0]), negated };
}

const isGitWord = (w) => w === "git" || w.endsWith("/git");

/** `base` plus a directory a `cd` or `-C` names: an absolute one replaces it. */
const joinDir = (base, dir) => (path.isAbsolute(dir) ? dir : path.join(base || ".", dir));

/**
 * @typedef {object} GitPush
 * @property {boolean} dryRun `--dry-run` or a short cluster with `n`
 * @property {string[]} dirs where the push may run, relative to the hook's `cwd`
 *   or absolute: `git -C` applied to every place a preceding `cd` may have left
 * @property {string[]} tips what to vet: refs whose new commits go out (`HEAD`,
 *   a branch, the source of a refspec, `--branches` for `--all`/`--mirror`)
 */

/**
 * Every real `git push` in a shell command string, however it is wrapped.
 * Handles `&&`/`||`/`;`/`|`/`&`/newline chains, subshells, `$(...)`, `bash -c`,
 * `eval`, a prefix such as `sudo` or `env`, and git global options. A `cd` is
 * followed when it names a literal directory, and both places are kept, because
 * the `cd` may have failed or happened in a subshell.
 *
 * @param {string} command
 * @returns {GitPush[]}
 */
export function parseGitPushes(command) {
  if (typeof command !== "string") return [];
  const pushes = [];
  let places = [""];
  for (const words of simpleCommands(command)) {
    if (words[0] === "cd" && words[1] && !/^-|[$~*?`]/.test(words[1])) {
      places = [...new Set([...places, ...places.map((p) => joinDir(p, words[1]))])];
      continue;
    }
    words.forEach((word, at) => {
      if (!isGitWord(word)) return;
      let i = at + 1;
      let dirs = places;
      while (i < words.length && words[i].startsWith("-")) {
        if (words[i] === "-C" && words[i + 1] !== undefined) {
          const dir = words[i + 1];
          dirs = dirs.map((p) => joinDir(p, dir));
          i += 2;
        } else if (GLOBAL_OPTS_WITH_ARG.has(words[i])) {
          i += 2;
        } else {
          i += 1;
        }
      }
      if (words[i] !== "push") return;
      pushes.push({ ...pushArguments(words.slice(i + 1)), dirs });
    });
  }
  return pushes;
}

/**
 * The options and refspecs of one `git push`, reading the arguments the way git
 * does. @returns {{ dryRun: boolean, tips: string[] }}
 */
function pushArguments(args) {
  let dryRun = false;
  let all = false;
  let deleting = false;
  let repoOption = false;
  // An option the guard cannot place: vet every branch rather than ignore it.
  let unknown = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const option = resolveLongOption(equals === -1 ? arg.slice(2) : arg.slice(2, equals));
      if (!option) {
        unknown = true;
        continue;
      }
      const on = !option.negated;
      if (option.name === "dry-run") dryRun = on;
      else if (option.name === "all" || option.name === "branches" || option.name === "mirror") all = on;
      else if (option.name === "delete") deleting = on;
      else if (option.name === "repo") repoOption = on;
      if (option.takes === "required" && equals === -1) i++;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        if (!PUSH_SHORT_OPTIONS.has(arg[j])) unknown = true;
        if (arg[j] === "n") dryRun = true;
        if (arg[j] === "d") deleting = true;
        if (arg[j] === "o") {
          if (j === arg.length - 1) i++;
          break;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  // The first operand is the remote, unless `--repo` named it.
  const refspecs = repoOption ? positional : positional.slice(1);
  return { dryRun, tips: pushTips(refspecs, all, deleting, unknown) };
}

/**
 * The refs whose commits a push sends: the source of each refspec, `HEAD` when
 * none is given, every branch for `--all` and `--mirror`, and also every branch
 * when an option is not one the guard knows (`unknown`). A deletion
 * (`:branch`, `--delete`) sends nothing. A tag sent as a tag is not vetted (an
 * old tag may name history that is already public), but a tag sent to a branch
 * (`refs/tags/v1:refs/heads/y`) puts its commits on that branch, so its source
 * is a tip like any other.
 *
 * @param {string[]} refspecs
 * @param {boolean} all
 * @param {boolean} deleting
 * @param {boolean} [unknown]
 * @returns {string[]}
 */
function pushTips(refspecs, all, deleting, unknown = false) {
  const tips = [];
  if (all) {
    tips.push("--branches");
  } else if (!deleting) {
    if (refspecs.length === 0) tips.push("HEAD");
    for (let i = 0; i < refspecs.length; i++) {
      if (refspecs[i] === "tag") {
        i++; // `git push origin tag v1` is refs/tags/v1:refs/tags/v1
        continue;
      }
      const spec = refspecs[i].replace(/^\+/, "");
      const colon = spec.indexOf(":");
      const src = colon === -1 ? spec : spec.slice(0, colon);
      const dst = colon === -1 ? "" : spec.slice(colon + 1);
      if (src === "" || src.startsWith("-")) continue;
      // A tag goes to a tag only when the source is a plain tag ref name (not
      // `refs/tags/v1^{commit}` or `refs/tags/v1~1`, which name a commit) and the
      // destination is absent or under refs/tags/. Any other destination, a bare
      // short name included (git matches it against the remote's existing refs,
      // which may be a branch), puts the source's commits somewhere that counts.
      if (PLAIN_TAG_REF.test(src) && (dst === "" || dst.startsWith("refs/tags/"))) continue;
      tips.push(src.includes("*") ? "--branches" : src);
    }
  }
  if (unknown) tips.push("--branches");
  return [...new Set(tips)];
}

/**
 * Whether a command pushes at all, kept for callers that only need that:
 * `isPush` when any `git push` is in it, `dryRun` when every one is a dry run.
 *
 * @param {string} command
 * @returns {{ isPush: boolean, dryRun: boolean }}
 */
export function parseGitPush(command) {
  const pushes = parseGitPushes(command);
  return { isPush: pushes.length > 0, dryRun: pushes.length > 0 && pushes.every((p) => p.dryRun) };
}

/**
 * The commits that a push would send: everything reachable from `tips` but
 * not from the branch's upstream or `origin/main` -- both that resolve are
 * excluded together, not just the first. Local `main` is used only as a
 * LAST RESORT, when neither remote ref resolves (e.g. a fresh local-only
 * repo with no `origin`) -- never unioned in alongside them, since `main`
 * can be `HEAD` itself and excluding it unconditionally would erase the
 * very commits being pushed.
 *
 * Falls back to just the tips themselves when nothing resolves at all (a
 * brand-new repo/branch). Already-pushed history is intentionally excluded --
 * we only vet what's new. A tip that does not resolve is left out: a push of
 * it fails on its own.
 *
 * @param {(args: string[]) => string} [runGit]
 * @param {string[]} [tips] refs to vet, `HEAD` by default; `--branches` means every branch
 * @returns {string[]} commit SHAs (newest first), possibly empty
 */
export function outgoingCommits(runGit = defaultRunGit, tips = ["HEAD"]) {
  const resolves = (ref) => {
    try {
      runGit(["rev-parse", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  };

  // A tip names a commit, an annotated tag included: `^{commit}` peels it.
  const peeled = (tip) => (tip === "--branches" ? tip : `${tip}^{commit}`);
  const usable = tips.filter((tip) => tip === "--branches" || (!tip.startsWith("-") && resolves(peeled(tip))));
  if (usable.length === 0) return [];

  const excludeRefs = ["@{upstream}", "origin/main"].filter(resolves);
  if (excludeRefs.length === 0 && !usable.includes("main") && resolves("main")) {
    excludeRefs.push("main");
  }

  try {
    if (excludeRefs.length === 0) {
      const shas = [];
      for (const tip of usable) {
        const out =
          tip === "--branches"
            ? runGit(["for-each-ref", "--format=%(objectname)", "refs/heads/"])
            : runGit(["rev-parse", peeled(tip)]);
        shas.push(...out.split("\n").map((s) => s.trim()).filter(Boolean));
      }
      return [...new Set(shas)];
    }
    const out = runGit(["rev-list", ...usable.map(peeled), "--not", ...excludeRefs]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The `%G?` signature code for a single commit.
 *
 * @param {string} sha
 * @param {(args: string[]) => string} [runGit]
 * @returns {string}
 */
function commitSignatureCode(sha, runGit = defaultRunGit) {
  return runGit(["show", "--no-patch", "--format=%G?", sha]).trim();
}

/**
 * Filter a list of commit SHAs down to those whose signature is missing or
 * invalid (i.e. `%G?` is not in {@link VALID_SIGNATURE_CODES}). A commit whose
 * code cannot be read is reported as unsigned rather than silently skipped.
 *
 * @param {string[]} shas
 * @param {(args: string[]) => string} [runGit]
 * @returns {{ sha: string, code: string }[]}
 */
export function unsignedCommits(shas, runGit = defaultRunGit) {
  const bad = [];
  for (const sha of shas) {
    let code;
    try {
      code = commitSignatureCode(sha, runGit);
    } catch {
      code = "E";
    }
    if (!VALID_SIGNATURE_CODES.has(code)) bad.push({ sha, code });
  }
  return bad;
}

/**
 * Whether this machine's git is configured to sign commits at all
 * (`commit.gpgsign`/`commit.gpgSign` = true, checked at any config scope).
 * `guard-git-push-signed.mjs` uses this as its opt-in switch: a project that
 * hasn't set up commit signing gets no enforcement (nothing to enforce would
 * otherwise block every single push), and enabling signing locally turns the
 * guard on with no other configuration step.
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {boolean}
 */
export function signingEnabled(runGit = defaultRunGit) {
  try {
    return runGit(["config", "--get", "commit.gpgsign"]).trim() === "true";
  } catch {
    return false;
  }
}
