// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Pure helpers behind `source/docs-kit/check-live.mjs`: reading the generated
 * Cloudflare `_headers` file back into rules (`parseHeadersFile`,
 * `expectedHeadersFor`), comparing a live response's headers with them
 * (`diffHeaders`), mapping a built file to its public URL (`pageUrlPath`),
 * locating the first differing line of two page bodies (`firstDifference`),
 * and comparing the manifest's description, homepage and keywords with the
 * GitHub repo's (`diffMetadata`). None of them does I/O, so each is tested
 * without a network.
 */

/** Thrown when a `_headers` file cannot be read back into rules. */
export class HeadersParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "HeadersParseError";
  }
}

/** Longest line text kept in a difference report. */
const MAX_LINE_TEXT = 120;

/**
 * Parses a Cloudflare `_headers` file into `{ pattern, headers }` blocks. A
 * block starts at a non-indented line (the URL pattern); each indented
 * `Name: value` line after it is a header, split on the first `: `. Blank
 * lines are ignored. Throws with the 1-based line number when an indented
 * line comes before any pattern or has no `: ` separator.
 *
 * @param {string} text
 * @returns {Array<{ pattern: string, headers: Array<[string, string]> }>}
 */
export function parseHeadersFile(text) {
  const blocks = [];
  let current = null;
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const lineNumber = index + 1;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      if (pattern.split("*").length > 2) {
        throw new HeadersParseError(
          `_headers line ${lineNumber}: pattern "${pattern}" has more than one splat, which this check cannot match`,
        );
      }
      if (pattern.includes(":")) {
        throw new HeadersParseError(
          `_headers line ${lineNumber}: pattern "${pattern}" uses a placeholder or host, which this check cannot match`,
        );
      }
      current = { pattern, headers: [] };
      blocks.push(current);
      return;
    }
    if (current === null) {
      throw new HeadersParseError(
        `_headers line ${lineNumber}: header found before any URL pattern`,
      );
    }
    if (line.trim().startsWith("!")) {
      throw new HeadersParseError(
        `_headers line ${lineNumber}: "${line.trim()}" detaches a header, which this check cannot evaluate`,
      );
    }
    const separator = line.indexOf(": ");
    if (separator === -1) {
      throw new HeadersParseError(
        `_headers line ${lineNumber}: header has no ": " separator`,
      );
    }
    const value = line.slice(separator + 2).trim();
    if (value.includes(":splat")) {
      throw new HeadersParseError(
        `_headers line ${lineNumber}: a value uses :splat, which this check cannot evaluate`,
      );
    }
    current.headers.push([line.slice(0, separator).trim(), value]);
  });
  return blocks;
}

/**
 * Whether a `_headers` pattern covers a URL path. A pattern with no `*`
 * matches only the identical path; the single `*` `parseHeadersFile` allows
 * matches any run of characters (including none and `/`), so the path must
 * start with the text before it and end with the text after it.
 */
function patternMatches(pattern, urlPath) {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === urlPath;
  const before = pattern.slice(0, star);
  const after = pattern.slice(star + 1);
  return (
    urlPath.length >= before.length + after.length &&
    urlPath.startsWith(before) &&
    urlPath.endsWith(after)
  );
}

/**
 * The headers Cloudflare would add to `urlPath`: every matching block merged
 * in file order, names lower-cased. A header set by more than one matching
 * block has its values joined with `, `, as Cloudflare documents.
 *
 * @param {Array<{ pattern: string, headers: Array<[string, string]> }>} blocks
 * @param {string} urlPath
 * @returns {Record<string, string>}
 */
export function expectedHeadersFor(blocks, urlPath) {
  /** @type {Record<string, string>} */
  const expected = {};
  for (const block of blocks) {
    if (!patternMatches(block.pattern, urlPath)) continue;
    for (const [name, value] of block.headers) {
      const key = name.toLowerCase();
      expected[key] = key in expected ? `${expected[key]}, ${value}` : value;
    }
  }
  return expected;
}

/**
 * One message per expected header the response lacks or carries with a
 * different value (exact string equality). Extra response headers are
 * ignored, since Cloudflare adds some of its own.
 *
 * @param {Record<string, string>} expected
 * @param {{ get(name: string): string | null }} actual
 * @returns {string[]}
 */
export function diffHeaders(expected, actual) {
  const problems = [];
  for (const [name, value] of Object.entries(expected)) {
    const got = actual.get(name);
    if (got === null) {
      problems.push(`${name} is missing (expected "${value}")`);
    } else if (got !== value) {
      problems.push(`${name} expected "${value}", got "${got}"`);
    }
  }
  return problems;
}

/**
 * The public URL path of a file in the built site: `index.html` is `/`,
 * another `.html` page loses its extension (the host redirects the
 * `.html` form), and anything else keeps its path.
 *
 * @param {string} outPath
 * @returns {string}
 */
export function pageUrlPath(outPath) {
  let urlPath = "/" + outPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (urlPath.endsWith(".html")) {
    urlPath = urlPath.slice(0, -".html".length);
    if (urlPath === "/index") urlPath = "/";
  }
  return urlPath;
}

function clip(text) {
  return text.length > MAX_LINE_TEXT
    ? text.slice(0, MAX_LINE_TEXT) + "..."
    : text;
}

/**
 * The first line where two texts differ, or null when they are identical.
 * A text that is a prefix of the other differs at the first line past its
 * end, and a trailing newline alone counts as a difference.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {null | { line: number, expected: string, actual: string }}
 */
export function firstDifference(expected, actual) {
  if (expected === actual) return null;
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    // A missing line (undefined) differs from an empty one, so a trailing
    // newline on one side only is reported at the line it adds.
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: clip(expectedLines[index] ?? ""),
        actual: clip(actualLines[index] ?? ""),
      };
    }
  }
  return null;
}

/**
 * Compares the manifest's `description`, `homepage` and `keywords` with the
 * GitHub repo's `description`, `homepage` and `topics`. Keywords and topics
 * compare as sets. An empty, null or missing homepage or description equal
 * each other.
 *
 * @param {{ description?: string, homepage?: string, keywords?: string[] }} pkg
 * @param {{ description?: string | null, homepage?: string | null, topics?: string[] }} repo
 * @returns {string[]}
 */
export function diffMetadata(pkg, repo, manifest = "package.json") {
  const problems = [];
  for (const field of ["description", "homepage"]) {
    const left = pkg[field] ?? "";
    const right = repo[field] ?? "";
    if (left !== right) {
      problems.push(
        `${field}: ${manifest} has "${left}", GitHub has "${right}"`,
      );
    }
  }
  // A manifest without `keywords` (a plugin.json, say) opts out of the topic comparison.
  if (!Array.isArray(pkg.keywords)) return problems;
  const keywords = new Set(pkg.keywords);
  const topics = new Set(repo.topics ?? []);
  const onlyKeywords = [...keywords].filter((entry) => !topics.has(entry));
  const onlyTopics = [...topics].filter((entry) => !keywords.has(entry));
  if (onlyKeywords.length > 0 || onlyTopics.length > 0) {
    problems.push(
      `keywords: only in ${manifest}: [${onlyKeywords.join(", ")}]; only in GitHub topics: [${onlyTopics.join(", ")}]`,
    );
  }
  return problems;
}
