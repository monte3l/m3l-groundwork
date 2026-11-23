#!/usr/bin/env node
/**
 * PreToolUse blocking (Write|Edit|NotebookEdit): refuse to write a real secret to disk.
 *
 * CLAUDE.md's Security section requires that no secret or token ever land in
 * source, tests, or fixtures. A CI secret-scanning step is the backstop;
 * this hook is the earlier, write-time block so a credential never reaches
 * the working tree -- where it would linger in git reflog/objects even
 * after a fix.
 *
 * Two independent triggers, both hard-block (exit 2):
 *   1. Path: a dotenv file (`.env`, `.env.local`, ...) -- these are
 *      gitignored secret stores and should never be authored by the agent.
 *      Template variants (`.env.example`/`.sample`/`.template`/`.dist`) are
 *      allowed.
 *   2. Content: a known secret-key assignment carrying a *real* value, or a
 *      recognised high-entropy token/private-key literal. References and
 *      placeholders (`${{ secrets.X }}`, `process.env.X`, `<your-token>`, ...)
 *      are NOT flagged -- the point is to catch values, not names.
 *
 * Detection is deliberately conservative: prefix-anchored token shapes and
 * placeholder exclusion keep false positives off legitimate config/docs
 * (e.g. `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in a workflow).
 */
import process from "node:process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Env-var-name prefixes/exact names whose assigned *value* is a secret we
 * must never persist. Project-specific keys can be appended here.
 */
export const SECRET_KEYS = [
  "NPM_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
];

// High-signal literal shapes -- a match is almost certainly a real credential.
const TOKEN_LITERALS = [
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/, // GitHub token: personal, OAuth, user-to-server, server-to-server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained PAT
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm automation token
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, // PEM private key
];

/**
 * A value is a placeholder/reference, not a real secret, when it defers to an
 * env var or CI secret, or is an obvious dummy. Such values must not be flagged.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholderValue(value) {
  const v = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (v.length === 0) return true;
  if (/^[.…]+$/.test(v)) return true; // "..." or an ellipsis: text that elides the value
  // A value that is only a reference to a variable: `${X}`, `$X`, `${{ secrets.X }}`.
  // A lookup call or index is judged by `afterReference`; matching a prefix here
  // would let a real token that merely starts like one through.
  if (/^(?:\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|\$\{\{[^}]*\}\})$/.test(v)) return true;
  if (/^<.*>$/.test(v)) return true; // <your-token>
  // A dummy is a marker word set off from the rest by a delimiter (or the whole
  // value), such as `your_token_here` or `example-token`. A marker buried inside
  // a longer alphanumeric run (`s3cr3tfakeA1b2...`) is not one.
  if (
    /(?:^|[^A-Za-z0-9])(?:example|placeholder|changeme|your|dummy|fake|redacted|x{3,})(?:[^A-Za-z0-9]|$)/i.test(
      v,
    )
  )
    return true;
  // Too short / low-entropy to be a real token.
  return v.length < 16;
}

/**
 * The value an assignment gives: a quoted string up to its closing quote, else
 * the run up to a space, comma, semicolon or closing bracket. What follows on the
 * line (a comment, the rest of a JSON object, a sentence) is not the value.
 *
 * @param {string} rest the text after the `=` or `:`
 * @returns {string}
 */
function firstValue(rest) {
  const text = rest.trim();
  const quoted = /^(["'`])(.*?)\1/.exec(text);
  if (quoted) return quoted[2];
  // A `${...}` or `$(...)` is one unit, so `${X}<token>` and `$(cmd)<token>` are
  // read to their end, not to the brace or the space. A backtick ends the value:
  // it closes a code span in prose.
  return /^(?:\$\{+[^}]*\}+|\$\([^)]*\)|[^\s,;)\]}`])*/.exec(text)?.[0] ?? "";
}

/**
 * A variable name that reads as a name and not as a value: `NPM_TOKEN`, `npm_config_x`,
 * or a short word. A mixed-case run of letters and digits is a token, not a name.
 */
const isEnvName = (name) =>
  /^[A-Z][A-Z0-9_]*$/.test(name) ||
  (/^[a-z][a-z0-9_]*$/.test(name) && (name.length < 16 || name.includes("_")));

/**
 * The text of a bracketed reference up to and including its `closer` (what is
 * inside may hold a default, so it is read), and what follows it. `quote` is the
 * quote the value opened with, if any: the same quote right after the closer
 * closes the value and is not part of what follows. Returns null when the
 * reference never closes.
 *
 * @param {string} text the text after the opening token
 * @param {string} closer
 * @param {string} quote
 * @returns {{ scan: string, suffix: string } | null}
 */
function through(text, closer, quote) {
  const end = text.indexOf(closer);
  if (end === -1) return null;
  let suffix = text.slice(end + closer.length);
  if (quote !== "" && suffix.startsWith(quote)) suffix = suffix.slice(1);
  return { scan: text.slice(0, end + closer.length), suffix };
}

/**
 * What a reference may be followed by: nothing, a space or a delimiter, or a code
 * span's closing backtick in prose. More value stuck to it (`${X}<token>`,
 * `${X}"<token>"`, `$(cmd)'<token>'`) makes the whole a value, not a lookup.
 */
const endsReference = (suffix) =>
  suffix === "" ||
  /^[\s,;)\]}]/.test(suffix) ||
  (suffix[0] === "`" && (suffix.length === 1 || /[\s:.,;)\]}]/.test(suffix[1])));

/**
 * The literals after a default operator (`|| "x"`, `?? 'x'`, `or "x"`, `| "x"`),
 * however many are chained: what a default looks like once the reference ended.
 */
function defaultLiterals(tail) {
  const found = [];
  let rest = tail;
  for (let m; (m = /^\s*(?:\|\||\?\?|\bor\b|\|)\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(rest)); ) {
    found.push(m[2]);
    rest = rest.slice(m[0].length);
  }
  return found;
}

/**
 * What follows a lookup of the environment on an object or a function: an index
 * (`["X"]`), a call (`("X"`, `.get("X"`, `.fetch("X"`) or a plain `.NAME` property
 * whose name reads as a name. Returns the text after the variable name, where a
 * default would be, or null when it is none of those (so the value is not a
 * lookup at all).
 */
function afterAccess(text, call) {
  // More value glued to an index or a property (`.get-<token>`, `["X"]-<token>`) is not a lookup.
  const ended = (rest) => (rest === "" || /^[\s"'`),;}\]|&?:]/.test(rest) ? rest : null);
  let m;
  if (!call && (m = /^\[\s*(["'])(?:(?!\1).)*\1\s*\]/.exec(text))) return ended(text.slice(m[0].length));
  if (!call && (m = /^\[[^\]"']*\]/.exec(text))) return ended(text.slice(m[0].length));
  if ((m = /^(?:\.(?:get|fetch))?\s*\(\s*(?:(["'])(?:(?!\1).)*\1)?/.exec(text))) return text.slice(m[0].length);
  if (!call && (m = /^\.([A-Za-z_]\w*)(?![\w(])/.exec(text)) && isEnvName(m[1])) return ended(text.slice(m[0].length));
  return null;
}

/**
 * A reference to the environment or a CI secret at the start of `text`:
 *  - null when the value does not start with one (`ENV-<token>`, `getenv-<token>`,
 *    `env.<token>` and `os.environ<token>` are values, not references: the head must
 *    be followed by what a lookup is followed by);
 *  - `{ scan, suffix, after }` when it is one: `scan` is read for any quoted literal (a
 *    default inside the reference), `suffix` is what follows it on the line, and
 *    `after` is everything after the head, which is read for any run that looks
 *    like a secret;
 *  - "unclosed" when a bracketed reference never closes.
 *
 * @param {string} text
 * @param {string} quote the quote the value opened with, or ""
 * @returns {{ scan: string, suffix: string, after: string } | "unclosed" | null}
 */
function afterReference(text, quote) {
  let m;
  const bracket = (opening, closer) => {
    const closed = through(text.slice(opening), closer, quote);
    return closed === null ? "unclosed" : { ...closed, after: text.slice(opening) };
  };
  const plain = (from, scan = text.slice(from)) => ({ scan, suffix: "", after: text.slice(from) });
  if (text.startsWith("${{")) return bracket(3, "}}");
  if ((m = /^\$\{[A-Za-z_]\w*(?=[}:])/.exec(text))) return bracket(m[0].length, "}");
  if (text.startsWith("$(")) return bracket(2, ")");
  if ((m = /^\$[A-Za-z_]\w*(?=$|[\s"'`),;}\]])/.exec(text))) return plain(m[0].length);
  if ((m = /^(?:secrets|env)\.([A-Za-z_][\w-]*)(?![\w.-])/.exec(text))) return isEnvName(m[1]) ? plain(m[0].length) : null;
  if ((m = /^(?:process\.env|os\.environ|ENV)(?=[[.])/.exec(text))) {
    const scan = afterAccess(text.slice(m[0].length), false);
    return scan === null ? null : plain(m[0].length, scan);
  }
  if ((m = /^(?:os\.getenv|System\.getenv|getenv)(?=\s*\()/.exec(text))) {
    const scan = afterAccess(text.slice(m[0].length), true);
    return scan === null ? null : plain(m[0].length, scan);
  }
  return null;
}

/**
 * A hyphenated identifier made of lowercase words, the way a repository or a package is named
 * (`m3l-output-governor`, `claude-code-plugin`, `m3l-s3-bucket-name`). Every part starts with a letter and is
 * either a plain word (letters only) or a short part that mixes in a digit (`m3l`, `v2`, `s3`: at most four
 * characters), at most two of those, and at least one part is a plain word of three letters or more. A
 * letters-only part of eight or more letters that are all hex digits (`deadbeef`) is not a word. A token is
 * not one: it has a long part that mixes letters and digits (`key-a1b2c3d4e5f6g7h8i9j0`), or groups of them
 * (`ab12-cd34-ef56-gh78`), or a part that starts with a digit (a UUID).
 */
function isHyphenatedName(run) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/.test(run)) return false;
  const parts = run.split("-");
  let mixed = 0;
  for (const part of parts) {
    if (/^[a-z]+$/.test(part)) {
      if (part.length >= 8 && /^[a-f]+$/.test(part)) return false;
    } else if (part.length > 4) {
      return false;
    } else {
      mixed++;
    }
  }
  return mixed <= 2 && parts.some((part) => /^[a-z]{3,}$/.test(part));
}

// Prefixes of credentials that are tokens whatever else they look like. `key-` is taken only when a digit
// follows directly, that is in the part right after the hyphen, so names such as `key-value-store-v2` and
// `key-manager-v2-prod` are not tokens.
const TOKEN_PREFIX = /^(?:gh[pousr]_|github_pat_|npm_|AKIA|ASIA|sk-|sk_|rk_|xox[abprs]-|glpat-|AIza|ya29\.|key-(?=[A-Za-z0-9]*\d))/;

/**
 * Whether a run of characters looks like a secret by the same rules as a plain value
 * (16 or more characters, not a placeholder), narrowed so that text around a reference
 * is not mistaken for one: a token prefix is enough, anything else needs letters and
 * digits, and a path, a URL, or a NAME_LIKE_THIS identifier is not one.
 *
 * @param {string} run
 * @returns {boolean}
 */
function looksLikeSecretRun(run) {
  if (run.length < 16 || !/^[A-Za-z0-9_\-+/=.~]+$/.test(run)) return false;
  if (TOKEN_PREFIX.test(run)) return !isPlaceholderValue(run);
  if (/^(?:[~.]?\/|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/|$))/.test(run)) return false; // a path or a URL
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(run) || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(run)) return false; // a name
  if (isHyphenatedName(run)) return false; // a repository or package name
  if (!/[A-Za-z]/.test(run) || !/\d/.test(run)) return false;
  return !isPlaceholderValue(run);
}

/**
 * Whether anything in `text`, whatever the structure around it (a literal, a list
 * element, a concatenation, a second argument, a value behind an operator), is a run
 * that looks like a secret once quotes, operators and delimiters are taken away.
 */
function remainderHasSecret(text) {
  return text.split(/[\s"'`,;()[\]{}|&?:<>=!$@#%^*\\]+/).some(looksLikeSecretRun);
}

/** The first value of `rest` and what follows it. */
function valueAndTail(rest) {
  const text = rest.trim();
  const quoted = /^(["'`])(.*?)\1/.exec(text);
  if (quoted) return { value: quoted[2], tail: text.slice(quoted[0].length) };
  const value = firstValue(text);
  return { value, tail: text.slice(value.length) };
}

/**
 * Whether the text after `KEY =` carries a literal secret. A value that is a
 * lookup (`os.environ[...]`, `getenv(...)`, `process.env.X`, `${X}`, `${{ secrets.X }}`)
 * is a placeholder only for the lookup itself: a default is a literal
 * (`os.environ.get("X", "<token>")`, `process.env.X ?? '<token>'`, `${X:-<token>}`,
 * `${X} || "<token>"`), so every quoted string inside the reference, a shell default
 * word and the literals after a default operator are read. A reference with more value
 * stuck to it (`${X}"<token>"`) is that value. Any other value is its first token, and
 * the literals after a default operator that follows it. Whatever the first value is, a
 * placeholder included, the rest of the line is read for a run that looks like a secret.
 *
 * Not read: a second assignment on the line whose value is short or has no digit, and a
 * secret built by concatenation.
 *
 * @param {string} rest the text after the `=` or `:`
 * @returns {boolean}
 */
function valueIsSecret(rest) {
  const text = rest.trim();
  const quote = /^["'`]/.exec(text)?.[0] ?? "";
  const ref = afterReference(text.slice(quote.length), quote);
  if (ref === "unclosed" || ref === null) {
    const { value, tail } = valueAndTail(rest);
    if (!isPlaceholderValue(value) || defaultLiterals(tail).some((literal) => !isPlaceholderValue(literal))) return true;
    // The first value is a placeholder, a reference somewhere in the value (`["${X}", "<token>"]`) or
    // not (`changeme <token>`): no structure is trusted, so the whole of the line is read for a run that
    // looks like a secret.
    return remainderHasSecret(text);
  }
  const shellDefault = /^:?[-=+?]([^}]*)\}/.exec(ref.scan);
  if (shellDefault && !isPlaceholderValue(shellDefault[1])) return true;
  for (const literal of ref.scan.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)) {
    if (!isPlaceholderValue(literal[2])) return true;
  }
  if (!endsReference(ref.suffix)) {
    // More value stuck to the reference: judge the glued run, quotes removed.
    const run = ref.suffix.split(/\s/)[0].replace(/["'`]/g, "").replace(/[,;)\]}]+$/, "");
    if (!isPlaceholderValue(run)) return true;
  }
  if (defaultLiterals(ref.suffix).some((literal) => !isPlaceholderValue(literal))) return true;
  // Whatever else follows the reference, in any shape: no structure is trusted.
  return remainderHasSecret(ref.after);
}

/**
 * True when the basename is a real dotenv file (not a committed template).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEnvFilePath(filePath) {
  const base = path.basename(filePath);
  if (!/^\.env(\.|$)/.test(base)) return false;
  return !/\.(example|sample|template|dist)$/.test(base);
}

/**
 * Scan `content` for secret-key assignments carrying a real value or for a
 * recognised token/private-key literal. Returns a human-readable reason per
 * match (empty array when clean).
 *
 * @param {string} content
 * @returns {string[]}
 */
export function findSecrets(content) {
  const hits = [];

  for (const key of SECRET_KEYS) {
    // KEY = value, KEY: value or KEY => value (env, yaml, toml, ruby, ...), with
    // the key itself optionally quoted ("KEY": "v", 'KEY' = 'v'), in any case. A
    // key in backticks (prose such as `GITHUB_TOKEN`: the pull request) is text
    // about the key, not an assignment.
    const re = new RegExp(`\\b${key}\\b["']?\\s*(?:=>|[:=])\\s*(.+)`, "gi");
    for (const m of content.matchAll(re)) {
      if (valueIsSecret(m[1]))
        hits.push(`${key} assigned a literal value`);
    }
  }

  for (const re of TOKEN_LITERALS) {
    if (re.test(content))
      hits.push(`recognised token/key literal (${re.source})`);
  }

  return hits;
}

/**
 * Combined verdict for a write. Returns the block reasons (empty when allowed).
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function isSecretWrite(filePath, content) {
  const reasons = [];
  if (isEnvFilePath(filePath)) {
    reasons.push(`writing a dotenv secret file (${path.basename(filePath)})`);
  }
  reasons.push(...findSecrets(content ?? ""));
  return reasons;
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

// Main execution -- only run when invoked directly, not when imported for testing.
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
  if (typeof input !== "object" || input === null) {
    process.stderr.write("[guard-secret-writes] could not read the hook payload; blocking.\n");
    process.exit(2);
  }

  // A notebook edit names its file `notebook_path` and carries `new_source`.
  const ti = input.tool_input ?? {};
  const filePath = ti.file_path ?? ti.notebook_path ?? "";
  if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

  // Content by field presence (Write -> content, Edit -> new_string, NotebookEdit
  // -> new_source), matching the sibling-hook convention so the guard stays live
  // if tool_name is absent.
  const content =
    typeof ti.content === "string"
      ? ti.content
      : typeof ti.new_string === "string"
        ? ti.new_string
        : typeof ti.new_source === "string"
          ? ti.new_source
          : "";

  const reasons = isSecretWrite(filePath, content);
  if (reasons.length === 0) process.exit(0);

  process.stderr.write(`\
[guard-secret-writes] Blocked write to ${filePath}:
${reasons.map((r) => `  - ${r}`).join("\n")}

Secrets and tokens must never be written to the working tree -- they persist in
git objects/reflog even after removal. Use a CI secret or an env var reference
instead of a literal value, and keep real dotenv files out of the repo (.env*
is gitignored; author .env.example with placeholders).
`);
  process.exit(2);
}
