// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A tolerant reader for JSON-with-comments (JSONC) -- `tsconfig.json` and
 * friends use `//`/`/* *\/` comments and trailing commas that `JSON.parse`
 * rejects outright. This strips comments and trailing commas (respecting
 * string literals, so a `//` inside a string is left alone) and delegates
 * to `JSON.parse`. It is not a full JSON5 parser -- no unquoted keys, no
 * single-quoted strings -- tsconfig-shaped input is the only intended use.
 */
import { readFileSync, statSync } from "node:fs";
import {
  errnoCode,
  isAbsentError,
  readFailure,
  unresolvableCode,
} from "./survey/internal/read-guard.js";

/**
 * The outcome of reading/parsing JSONC. A failure says which step failed:
 * `"read"` (the file is missing, unreadable, unresolvable or not a regular
 * file) or `"parse"` (its text is not JSONC) -- so a caller never reports an
 * unreadable file as unparseable.
 */
export type JsoncReadResult =
  | { ok: true; value: unknown }
  | { ok: false; stage: "read" | "parse"; error: string };

/** Matches exactly the whitespace class `\s` covers, so a trailing comma is recognized across the same gaps as before. */
const WHITESPACE = /\s/;

/**
 * Strips `//` and block comments and trailing commas from JSONC source. A
 * trailing comma is removed in the same pass that tracks string literals, so
 * a `,}` or `,]` inside a string (value or key) is never touched.
 */
export function stripJsoncNoise(content: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  // Index in `result` of the last comma emitted outside a string with only
  // whitespace (or stripped comments) after it; -1 when there is none.
  let pendingComma = -1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next ?? "";
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      pendingComma = -1;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if ((ch === "}" || ch === "]") && pendingComma !== -1) {
      result = result.slice(0, pendingComma) + result.slice(pendingComma + 1);
    }
    if (ch === ",") {
      pendingComma = result.length;
    } else if (ch !== undefined && !WHITESPACE.test(ch)) {
      pendingComma = -1;
    }

    result += ch;
  }

  return result;
}

/**
 * Strips `//` and block comments from JavaScript/TypeScript source, leaving
 * single-quoted, double-quoted and template-literal strings alone. Unlike {@link stripJsoncNoise}
 * it keeps trailing commas -- they are valid JS syntax, and removing them is
 * a JSON-only cleanup.
 *
 * A character scanner, not a parser: a regex literal containing a quote
 * (`/["']/`) or `//` can be misread as opening a string or a comment, and a
 * `${...}` expression inside a template literal containing its own backtick
 * or quote can close the outer template early. Neither shape appears in this
 * project's actual `eslint.config.js`/`vitest.config.ts`/`verify-steps.mjs`
 * files.
 *
 * @example
 * ```ts
 * import { stripJsComments } from "./jsonc.js";
 * stripJsComments("const g = ['**' + '/*.js']; // note");
 * // => "const g = ['**' + '/*.js']; "
 * ```
 */
export function stripJsComments(content: string): string {
  let result = "";
  let quote: string | undefined;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote !== undefined) {
      result += ch;
      if (ch === "\\") {
        result += next ?? "";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    result += ch;
  }

  return result;
}

/** Parses JSONC source text, returning a structured result rather than throwing. */
export function parseJsonc(content: string): JsoncReadResult {
  try {
    return { ok: true, value: JSON.parse(stripJsoncNoise(content)) };
  } catch (error) {
    return {
      ok: false,
      stage: "parse",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reads and parses a JSONC file. A missing (`ENOENT`/`ENOTDIR`), unreadable
 * (`EACCES`/`EPERM`), unresolvable (a symlink loop's `ELOOP`), not a regular
 * file (a directory's `EISDIR`) or unparseable file is reported, not thrown
 * -- each is a property of the file. The existence check is a real `stat`, never `existsSync`, so a file
 * under a directory this process cannot search is reported with its errno
 * rather than as absent. Any other failure, on the check or the read
 * (`EIO`, `EMFILE`, ...), throws an `Error` naming the path, with the
 * original failure as `cause`.
 *
 * @example
 * ```ts
 * const read = readJsoncFile("/path/to/project/tsconfig.json");
 * if (!read.ok) console.log(read.error);
 * ```
 */
export function readJsoncFile(path: string): JsoncReadResult {
  let content: string;
  try {
    statSync(path);
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isAbsentError(error)) {
      return { ok: false, stage: "read", error: `${path} does not exist` };
    }
    if (errnoCode(error) === "EISDIR") {
      return {
        ok: false,
        stage: "read",
        error: `${path} is not a regular file`,
      };
    }
    const code = unresolvableCode(error);
    if (code === undefined) throw readFailure(path, error);
    return {
      ok: false,
      stage: "read",
      error: `${path} is unreadable (${code})`,
    };
  }
  return parseJsonc(content);
}
