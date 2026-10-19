// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * The gates `build.mjs --check` adds on top of link, anchor and `_headers`
 * validation. Each is a function from plain inputs to a list of problem
 * strings, so each is tested without a repository on disk (the two that read
 * the disk take the repository root and nothing else).
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Converts a glob (`**`, `*`, `?`) over POSIX paths to a RegExp. `**` crosses
 * directories, `*` and `?` do not.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Every tracked `*.md` file is either a page or deliberately excluded, and
 * neither list may name something that no longer exists.
 *
 * @param {{ tracked: string[], pages: Array<{src: string}>, exclude: Array<{glob: string, reason: string}> }} input
 * @returns {string[]}
 */
export function pageCoverageProblems({ tracked, pages, exclude }) {
  const problems = [];
  const markdown = tracked.filter((file) => file.endsWith(".md"));
  const pageSrcs = new Set(pages.map((page) => page.src));
  const matchers = exclude.map((entry) => ({ entry, re: globToRegExp(entry.glob) }));
  for (const file of markdown) {
    if (pageSrcs.has(file)) continue;
    if (matchers.some(({ re }) => re.test(file))) continue;
    problems.push(`${file}: tracked Markdown is neither a page nor excluded (add it to "pages" or "exclude" in docs.config.mjs)`);
  }
  const trackedSet = new Set(tracked);
  for (const src of pageSrcs) {
    if (!trackedSet.has(src)) problems.push(`pages: "${src}" is not a tracked file`);
  }
  for (const { entry, re } of matchers) {
    if (!markdown.some((file) => re.test(file))) {
      problems.push(`exclude: "${entry.glob}" matches no tracked Markdown file (remove the stale entry)`);
    }
  }
  for (const src of pageSrcs) {
    const hit = matchers.find(({ re }) => re.test(src));
    if (hit) problems.push(`pages: "${src}" is also matched by exclude "${hit.entry.glob}"`);
  }
  return problems;
}

/**
 * Parses a `SHA256SUMS` file (`<hex>  <path>` per line, as `sha256sum` writes).
 *
 * @param {string} text
 * @returns {Map<string, string>} path to lowercase hex digest
 */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS: cannot parse line "${line.slice(0, 80)}"`);
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

async function listFiles(dir, rel = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, next)));
    else out.push(next);
  }
  return out;
}

/**
 * Verifies `SHA256SUMS` in `designDir` byte for byte, and that no file under
 * `source/` is missing from it. This is the in-process equivalent of
 * `sha256sum -c`, so the docs gate does not depend on the host's coreutils.
 *
 * @param {string} designDirAbs
 * @returns {Promise<string[]>}
 */
export async function shaSumsProblems(designDirAbs) {
  const problems = [];
  let sums;
  try {
    sums = parseSums(await readFile(path.join(designDirAbs, "SHA256SUMS"), "utf8"));
  } catch (error) {
    return [`design: cannot read SHA256SUMS: ${error.message}`];
  }
  for (const [file, digest] of sums) {
    let bytes;
    try {
      bytes = await readFile(path.join(designDirAbs, file));
    } catch {
      problems.push(`design: SHA256SUMS lists ${file}, which does not exist`);
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      problems.push(`design: ${file} does not match SHA256SUMS (hand-edited? re-sync with sync-design.sh)`);
    }
  }
  let onDisk;
  try {
    onDisk = await listFiles(designDirAbs, "source");
  } catch {
    problems.push("design: source/ is missing");
    return problems;
  }
  for (const file of onDisk) {
    if (!sums.has(file)) problems.push(`design: ${file} is not listed in SHA256SUMS`);
  }
  return problems;
}

/**
 * The adoption marker must record the vendored tier. m3l-design itself is
 * the one allowed exception: `Version adopted` plus `Tier: source`, and only
 * when its design directory is the repository root.
 *
 * @param {{ marker: string, text: string | null, isSourceRepo: boolean }} input
 * @returns {string[]}
 */
export function markerProblems({ marker, text, isSourceRepo }) {
  if (text === null) return [`${marker}: missing (a docs site needs the vendored tier marker)`];
  if (/^- \*\*Version copied:\*\* `v\d+\.\d+\.\d+`/m.test(text)) return [];
  if (
    isSourceRepo &&
    /^- \*\*Version adopted:\*\* `v\d+\.\d+\.\d+`/m.test(text) &&
    /^- \*\*Tier:\*\* source\b/m.test(text)
  ) {
    return [];
  }
  return [`${marker}: a docs site needs "- **Version copied:** \`vX.Y.Z\`" (vendored tier)`];
}

const CSS_LITERALS = [
  [/#[0-9a-fA-F]{3,8}\b/, "a hex colour"],
  [/\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb|color)\(/, "a colour function"],
  [/(?<![\w-])-?\d*\.?\d+(?:px|rem|em|ch|vh|vw|vmin|vmax|pt)\b/, "a length literal"],
];

/**
 * A local stylesheet may spend only `var(--token)` values and bundle classes:
 * no colour, length or font literal of its own. Comments and the prelude of
 * `@media`/`@container`/`@supports` rules (which cannot take `var()`) are
 * ignored.
 *
 * @param {string} name file name for the message
 * @param {string} css
 * @returns {string[]}
 */
export function localCssProblems(name, css) {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@(?:media|container|supports)[^{]*\{/g, "{");
  const problems = [];
  stripped.split("\n").forEach((line, index) => {
    for (const [re, what] of CSS_LITERALS) {
      if (re.test(line)) {
        problems.push(`${name}:${index + 1}: ${what} in "${line.trim()}" (use a var(--…) token from tokens.css)`);
      }
    }
  });
  return problems;
}

/**
 * More than two GitHub alerts in a row is noise: the Markdown rules cap it at
 * two. Alerts count as a run while only blank lines separate them.
 *
 * @param {string} src file name for the message
 * @param {string} markdown
 * @returns {string[]}
 */
export function alertRunProblems(src, markdown) {
  const problems = [];
  let run = 0;
  let inAlert = false;
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/.test(line)) {
      run += 1;
      inAlert = true;
      if (run === 3) problems.push(`${src}: more than two GitHub alerts in a row`);
    } else if (/^>/.test(line) && inAlert) {
      // alert body
    } else if (line.trim() === "") {
      inAlert = false;
    } else {
      run = 0;
      inAlert = false;
    }
  }
  return problems;
}

/**
 * @param {{ homepage?: string } | null} manifest
 * @param {string} manifestPath
 * @param {string} siteUrl
 * @returns {string[]}
 */
export function homepageProblems(manifest, manifestPath, siteUrl) {
  if (manifest === null) return [`${manifestPath}: cannot be read`];
  const homepage = (manifest.homepage ?? "").replace(/\/+$/, "");
  return homepage === siteUrl ? [] : [`${manifestPath}: homepage is "${manifest.homepage ?? ""}", the site is ${siteUrl}`];
}
