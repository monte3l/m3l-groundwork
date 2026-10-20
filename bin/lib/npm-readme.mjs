// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pure transform behind `bin/build-npm-readme.mjs`: turns the root README.md
 * (what GitHub shows) into the README `@monte3l/groundwork`'s npm page shows.
 * npm resolves a relative link against the package's own `repository.directory`
 * (`packages/cli`), so every repo-relative target is rewritten to an absolute
 * `github.com/.../blob/main/<path>` URL; fenced code, code spans, absolute
 * URLs and in-page anchors are left untouched.
 */

export const NPM_README_BANNER = `<!--
  GENERATED from the root README.md -- do not hand-edit.
  Run \`node bin/build-npm-readme.mjs\` to regenerate; \`--check\` (the
  \`npm-readme\` verify step) fails on drift.
-->
`;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// `](target)` or `](target "title")`; a target holds no whitespace or `)`.
const LINK_RE = /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;
// Forms the rewriter does not handle. They throw rather than ship a silently
// broken relative link to npm, the way the docs kit's renderer throws on markdown
// it cannot render.
const UNSUPPORTED = [
  [/^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/, "a reference-style link definition"],
  [
    /\b(?:href|src)\s*=\s*(?!["']?(?:https?:|#|mailto:|\/\/))/i,
    "a relative HTML href/src",
  ],
  [/\]\(\s*</, "an angle-bracket link target"],
  [/\]\([^)\s]+\s+(?:'|\()/, "a link title that is not double-quoted"],
];

/** Turns a `git+https://host/org/repo.git` repository URL into its web base. */
export function repoWebUrl(repositoryUrl) {
  return repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** Rewrites one link target, or returns it unchanged when it is not repo-relative. */
function rewriteTarget(target, base) {
  if (
    target.startsWith("#") ||
    target.startsWith("//") ||
    SCHEME_RE.test(target)
  ) {
    return target;
  }
  if (target.startsWith("../")) {
    throw new Error(`npm README: unsupported parent-relative link ${target}`);
  }
  return `${base}/blob/main/${target.replace(/^(\.\/)+/, "").replace(/^\/+/, "")}`;
}

/** Rewrites the links in one line of prose, skipping inline code spans. */
function rewriteLine(line, base) {
  for (const [re, what] of UNSUPPORTED) {
    if (re.test(line)) {
      throw new Error(`npm README: unsupported ${what} in: ${line.trim()}`);
    }
  }
  // Split on code spans (`...`, matched by backtick-run length) and only
  // rewrite the text between them.
  const parts = [];
  let rest = line;
  while (rest.length > 0) {
    const open = rest.match(/`+/);
    if (!open) {
      parts.push([false, rest]);
      break;
    }
    const start = open.index;
    const ticks = open[0];
    const close = rest.indexOf(ticks, start + ticks.length);
    if (close === -1) {
      parts.push([false, rest]);
      break;
    }
    if (start > 0) parts.push([false, rest.slice(0, start)]);
    parts.push([true, rest.slice(start, close + ticks.length)]);
    rest = rest.slice(close + ticks.length);
  }
  return parts
    .map(([isCode, text]) =>
      isCode
        ? text
        : text.replace(
            LINK_RE,
            (_m, target, title) => `](${rewriteTarget(target, base)}${title})`,
          ),
    )
    .join("");
}

/**
 * Builds the npm README from the root README's text. `repositoryUrl` is
 * `packages/cli/package.json`'s `repository.url`.
 */
export function buildNpmReadme(rootReadme, repositoryUrl) {
  const base = repoWebUrl(repositoryUrl);
  let fence = null;
  const body = rootReadme
    .split("\n")
    .map((line) => {
      const m = FENCE_RE.exec(line);
      if (fence === null) {
        if (m) fence = m[1];
        return m ? line : rewriteLine(line, base);
      }
      // A closing fence is the same character, at least as long as the opener.
      if (
        m &&
        m[1][0] === fence[0] &&
        m[1].length >= fence.length &&
        /^ {0,3}[`~]+\s*$/.test(line)
      ) {
        fence = null;
      }
      return line;
    })
    .join("\n");
  return `${NPM_README_BANNER}\n${body}`;
}
