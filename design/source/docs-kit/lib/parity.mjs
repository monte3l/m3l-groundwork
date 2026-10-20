// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Helpers for a project's own doc-versus-code parity module. A parity module
 * is listed in `docs.config.mjs` `parity` and default-exports
 * `async ({ root, config }) => string[]` (one message per drift, empty when
 * documentation and code agree). `build.mjs --check` imports each, runs it
 * and merges the messages into its own report, so the whole gate is one exit
 * code. Nothing here reads the disk or prints.
 */

/**
 * Text under the heading whose text equals `heading`, up to the next heading
 * of the same or a higher level. Headings inside fenced code are ignored.
 *
 * @param {string} markdown
 * @param {string} heading
 * @returns {string | null} null when the heading does not exist
 */
export function section(markdown, heading) {
  const lines = markdown.split("\n");
  let level = 0;
  let fence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (level === 0) {
      if (match && match[2] === heading) level = match[1].length;
      continue;
    }
    if (match && match[1].length <= level) break;
    out.push(line);
  }
  return level === 0 ? null : out.join("\n");
}

/**
 * Cells of one column of the first pipe table in `markdown`, header excluded.
 *
 * @param {string} markdown
 * @param {number | string} column index, or the header text
 * @returns {string[]}
 */
export function tableColumn(markdown, column) {
  const rows = [];
  let started = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*\|/.test(line)) {
      started = true;
      rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    } else if (started) break;
  }
  if (rows.length < 2) return [];
  const index = typeof column === "number" ? column : rows[0].indexOf(column);
  if (index < 0) return [];
  return rows.slice(2).map((row) => row[index] ?? "");
}

/**
 * Contents of every inline code span in `text`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

/**
 * Two sets that must be equal, reported as what each side lacks.
 *
 * @param {string} label what is being compared, for the message
 * @param {Iterable<string>} docs the documented values
 * @param {Iterable<string>} code the values the code defines
 * @returns {string[]}
 */
export function assertSameSet(label, docs, code) {
  const d = new Set(docs);
  const c = new Set(code);
  const problems = [];
  const missingInDocs = [...c].filter((value) => !d.has(value));
  const missingInCode = [...d].filter((value) => !c.has(value));
  if (missingInDocs.length > 0) problems.push(`${label}: in code, not in the docs: ${missingInDocs.join(", ")}`);
  if (missingInCode.length > 0) problems.push(`${label}: in the docs, not in code: ${missingInCode.join(", ")}`);
  return problems;
}

/**
 * Two single values that must be equal.
 *
 * @param {string} label
 * @param {unknown} docs
 * @param {unknown} code
 * @returns {string[]}
 */
export function assertSame(label, docs, code) {
  return String(docs) === String(code) ? [] : [`${label}: docs say ${JSON.stringify(docs)}, code says ${JSON.stringify(code)}`];
}
