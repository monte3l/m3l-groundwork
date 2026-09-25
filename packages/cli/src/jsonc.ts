/**
 * A tolerant reader for JSON-with-comments (JSONC) -- `tsconfig.json` and
 * friends use `//`/`/* *\/` comments and trailing commas that `JSON.parse`
 * rejects outright. This strips comments and trailing commas (respecting
 * string literals, so a `//` inside a string is left alone) and delegates
 * to `JSON.parse`. It is not a full JSON5 parser -- no unquoted keys, no
 * single-quoted strings -- tsconfig-shaped input is the only intended use.
 */
import { existsSync, readFileSync } from "node:fs";

export type JsoncReadResult =
  { ok: true; value: unknown } | { ok: false; error: string };

/** Strips `//` and block comments and trailing commas from JSONC source. */
export function stripJsoncNoise(content: string): string {
  let result = "";
  let inString = false;
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

  return result.replace(/,(\s*[}\]])/g, "$1");
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Reads and parses a JSONC file. A missing file is reported, not thrown. */
export function readJsoncFile(path: string): JsoncReadResult {
  if (!existsSync(path)) {
    return { ok: false, error: `${path} does not exist` };
  }
  return parseJsonc(readFileSync(path, "utf8"));
}
