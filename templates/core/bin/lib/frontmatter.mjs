/**
 * A reader for the YAML subset Claude Code frontmatter actually uses --
 * `SKILL.md`, agent, and rule files. Hand-rolled so the gate has no
 * dependencies. It handles plain, quoted, block (`>-`, `>`, `|`, `|-`), and
 * list scalars. Not supported: nested mappings (recorded as an empty string
 * rather than misparsed), anchors, tags. Every string result is trimmed.
 *
 * Also used by m3l-groundwork's own adopt mode (the tool that generated this
 * project's harness); if you're contributing a change back upstream, keep
 * this file's behavior in sync with its source at
 * `packages/cli/src/harness/frontmatter.ts` there.
 */

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^([>|])(?:[+-]\d?|\d[+-]?)?$/;

function dedent(lines) {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const strip = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(strip));
}

function foldBlockScalar(lines) {
  const paragraphs = [[]];
  for (const line of lines) {
    if (line.trim() === "") {
      paragraphs.push([]);
    } else {
      paragraphs[paragraphs.length - 1]?.push(line.trim());
    }
  }
  return paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(" "))
    .join("\n");
}

/** Unquotes one YAML scalar; an unterminated quote yields `undefined`. */
function unquote(text) {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") {
    return trimmed.replace(/\s+#.*$/, "");
  }
  let out = "";
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote === '"' && ch === "\\") {
      const escaped = trimmed[i + 1];
      out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : (escaped ?? "");
      i++;
    } else if (quote === "'" && ch === "'" && trimmed[i + 1] === "'") {
      out += "'";
      i++;
    } else if (ch === quote) {
      return out;
    } else {
      out += ch ?? "";
    }
  }
  return undefined;
}

function splitFlowList(inner) {
  const items = [];
  let current = "";
  let quote;
  for (const ch of inner) {
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * Parses the `---`-delimited frontmatter at the top of `content`. Returns
 * `{ ok: false, error }` (never throws) when there is no block or it is
 * never closed; lines it cannot interpret land in `problems`.
 * @param {string} content
 */
export function parseFrontmatter(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return {
      ok: false,
      error: "no frontmatter block (the file must start with `---`)",
    };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === "---",
  );
  if (end === -1) {
    return {
      ok: false,
      error: "frontmatter block is never closed with a `---` line",
    };
  }

  const block = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const fields = new Map();
  const problems = [];

  let i = 0;
  while (i < block.length) {
    const line = block[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (match?.[1] === undefined) {
      problems.push(`unparseable frontmatter line: ${line.trim()}`);
      i++;
      continue;
    }
    const key = match[1];
    const rest = (match[2] ?? "").trim();

    const continuation = [];
    let j = i + 1;
    while (j < block.length) {
      const next = block[j] ?? "";
      if (next.trim() === "" || /^\s/.test(next) || /^-(\s|$)/.test(next)) {
        continuation.push(next);
        j++;
      } else {
        break;
      }
    }
    i = j;

    if (fields.has(key)) {
      problems.push(`duplicate frontmatter key: ${key}`);
    }

    const blockScalar = BLOCK_SCALAR.exec(rest);
    if (blockScalar !== null) {
      const dedented = dedent(continuation);
      const text =
        blockScalar[1] === ">"
          ? foldBlockScalar(dedented)
          : dedented.join("\n");
      fields.set(key, text.trim());
      continue;
    }

    if (rest === "") {
      const items = continuation
        .filter((entry) => /^\s*-(\s|$)/.test(entry))
        .map((entry) => unquote(entry.replace(/^\s*-\s*/, "")) ?? "")
        .filter((item) => item !== "");
      fields.set(key, items.length > 0 ? items : "");
      continue;
    }

    const joined = [rest, ...continuation.map((entry) => entry.trim())]
      .filter((part) => part !== "")
      .join(" ");

    if (rest.startsWith("[")) {
      if (!joined.trimEnd().endsWith("]")) {
        problems.push(`unterminated flow list for key: ${key}`);
        fields.set(key, "");
        continue;
      }
      const inner = joined.trim().slice(1, -1);
      fields.set(
        key,
        splitFlowList(inner).map((item) => unquote(item) ?? item),
      );
      continue;
    }

    const scalar = unquote(joined);
    if (scalar === undefined) {
      problems.push(`unterminated quoted string for key: ${key}`);
      fields.set(key, "");
    } else {
      fields.set(key, scalar);
    }
  }

  return { ok: true, fields, body, problems };
}

/** A field as one string -- a list is joined with `, `. `undefined` when absent. */
export function fieldText(fields, key) {
  const value = fields.get(key);
  return Array.isArray(value) ? value.join(", ") : value;
}

/** A field as a list -- a non-empty scalar becomes a one-item list. `undefined` when absent. */
export function fieldList(fields, key) {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return value === "" ? [] : [value];
}
