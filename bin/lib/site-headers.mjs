// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pure, zero-dependency builders for the docs site's Cloudflare Workers
 * static-assets `_headers` file: a CSP `script-src` hash for the one inline
 * script (`hashInlineScript`), the external `<img>` hosts the CSP's
 * `img-src` must allow (`externalImageHosts`), and the file text itself
 * (`buildHeadersFile`) -- a fixed two-rule-block shape (`/*` security
 * headers, then an immutable cache rule for the vendored fonts). Cloudflare
 * caps a `_headers` line at 2000 characters and a file at 100 rules.
 * `assertHeadersLimits` checks both on the finished text and fails loudly
 * with a `HeadersLimitError` rather than shipping a file Cloudflare
 * truncates. A long `img-src` list can reach the line cap; the fixed shape
 * always yields 2 rule blocks, so the rule cap is checked as a guard against
 * a future change to that shape rather than something today's output can hit.
 */
import { createHash } from "node:crypto";

/** Thrown when a generated `_headers` file would exceed a Cloudflare limit. */
export class HeadersLimitError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "HeadersLimitError";
  }
}

// Cloudflare's documented per-line limit for a `_headers` file.
const MAX_LINE_LENGTH = 2000;

// Cloudflare's documented per-file rule limit for a `_headers` file.
const MAX_RULE_BLOCKS = 100;

const IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const ABSOLUTE_HTTP_RE = /^https?:\/\//i;

/**
 * Known HTTP redirect targets for specific badge-image hosts whose badge
 * endpoint 302s to a different origin than the one written in markdown
 * source (verified by hand with `curl -I`; this module stays offline/pure
 * -- no network call from a required CI gate -- so a redirect target that
 * changes on the provider's side has to be updated here by hand too: if a
 * badge silently stops rendering after that, check this map first).
 * Keyed by the literal host found in an <img> src; each value is every
 * additional host the browser will actually load the image from.
 */
const KNOWN_BADGE_REDIRECT_TARGETS = {
  "api.securityscorecards.dev": ["img.shields.io"],
};

/**
 * Computes the CSP source expression for an inline script:
 * `"sha256-" + base64(SHA-256(UTF-8 bytes))`.
 *
 * @param {string} scriptSource the exact inline script text, byte for byte
 * @returns {string} e.g. `"sha256-abc...="`, ready to quote in `script-src`
 * @throws {Error} if `scriptSource` is not a non-empty string
 *
 * @example
 * ```js
 * import { hashInlineScript } from "./bin/lib/site-headers.mjs";
 * hashInlineScript("document.title = 'hi';"); // "sha256-..."
 * ```
 */
export function hashInlineScript(scriptSource) {
  if (typeof scriptSource !== "string" || scriptSource.length === 0) {
    throw new Error(
      `hashInlineScript: expected a non-empty string, got ${
        typeof scriptSource === "string"
          ? "an empty string"
          : typeof scriptSource
      }`,
    );
  }
  return (
    "sha256-" +
    createHash("sha256").update(scriptSource, "utf8").digest("base64")
  );
}

/**
 * Collects every distinct host an absolute `http(s)://` `<img src>` points
 * at across the given rendered HTML pages. Relative srcs and `<img>` tags
 * without a `src` are ignored. A host listed in
 * `KNOWN_BADGE_REDIRECT_TARGETS` also contributes the hosts its badge
 * endpoint redirects to.
 *
 * @param {string[]} htmlPages rendered HTML (fragments or whole pages)
 * @returns {string[]} sorted, de-duplicated, lowercased bare hostnames
 * @throws {Error} if an absolute image URL cannot be parsed
 *
 * @example
 * ```js
 * import { externalImageHosts } from "./bin/lib/site-headers.mjs";
 * externalImageHosts(['<img src="https://badge.socket.dev/x.svg">']);
 * // ["badge.socket.dev"]
 * ```
 */
export function externalImageHosts(htmlPages) {
  const hosts = new Set();
  for (const page of htmlPages) {
    for (const match of page.matchAll(IMG_SRC_RE)) {
      const src = match[1] ?? match[2] ?? "";
      if (!ABSOLUTE_HTTP_RE.test(src)) continue;
      let url;
      try {
        url = new URL(src);
      } catch (cause) {
        throw new Error(`externalImageHosts: unparsable image URL ${src}`, {
          cause,
        });
      }
      hosts.add(url.hostname.toLowerCase());
    }
  }
  // Expand known badge redirects so the CSP also allows the origin the
  // browser actually ends up loading from. `Object.hasOwn` (not `in` or a
  // bare index) so a host literally named e.g. `constructor` never picks up
  // an inherited Object.prototype member.
  for (const host of [...hosts]) {
    if (Object.hasOwn(KNOWN_BADGE_REDIRECT_TARGETS, host)) {
      for (const target of KNOWN_BADGE_REDIRECT_TARGETS[host]) {
        hosts.add(target);
      }
    }
  }
  return [...hosts].sort();
}

/**
 * Builds the docs site's `_headers` file text: a `/*` block carrying the
 * CSP and the other security headers, then a `/assets/source/fonts/*`
 * block marking the vendored fonts immutable. Header lines are indented by
 * two spaces, the blocks are separated by one blank line, and the file ends
 * with a single `\n`.
 *
 * @param {{ scriptHash: string, imageHosts: string[] }} options
 *   `scriptHash` is embedded verbatim (it already carries its `sha256-`
 *   prefix, as `hashInlineScript` returns it); `imageHosts` are bare
 *   hostnames, emitted as `https://<host>` in the given order
 * @returns {string} the complete file text
 * @throws {HeadersLimitError} if the text exceeds a Cloudflare limit, as
 *   checked by `assertHeadersLimits` (2000 characters per line, 100 rule
 *   blocks); the fixed shape always yields 2 rule blocks, so in practice
 *   only a long `img-src` line can trigger it
 *
 * @example
 * ```js
 * import {
 *   buildHeadersFile,
 *   externalImageHosts,
 *   hashInlineScript,
 * } from "./bin/lib/site-headers.mjs";
 * const text = buildHeadersFile({
 *   scriptHash: hashInlineScript(inlineScript),
 *   imageHosts: externalImageHosts(renderedPages),
 * });
 * ```
 */
export function buildHeadersFile({ scriptHash, imageHosts }) {
  const imgSrc = [
    "'self'",
    ...imageHosts.map((host) => `https://${host}`),
  ].join(" ");
  const csp =
    `Content-Security-Policy: default-src 'none'; script-src '${scriptHash}'; ` +
    `style-src 'self'; font-src 'self'; img-src ${imgSrc}; base-uri 'none'; ` +
    `form-action 'none'; frame-ancestors 'none'`;
  const lines = [
    "/*",
    `  ${csp}`,
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: interest-cohort=(), camera=(), microphone=(), geolocation=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "",
    "/assets/source/fonts/*",
    "  Cache-Control: public, max-age=31536000, immutable",
  ];
  const text = lines.join("\n") + "\n";
  assertHeadersLimits(text);
  return text;
}

/**
 * Checks a `_headers` file's text against Cloudflare's documented limits:
 * no line over 2000 characters, and no more than 100 rule blocks. A rule
 * block is a non-empty line that does not start with whitespace (its URL
 * pattern); indented header lines and blank lines are not counted.
 *
 * @param {string} text the complete `_headers` file text
 * @returns {undefined}
 * @throws {HeadersLimitError} if any line exceeds 2000 characters, or the
 *   file has more than 100 rule blocks
 *
 * @example
 * ```js
 * import { assertHeadersLimits } from "./bin/lib/site-headers.mjs";
 * assertHeadersLimits("/*\n  X-Content-Type-Options: nosniff\n"); // ok
 * ```
 */
export function assertHeadersLimits(text) {
  let ruleBlocks = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.length > MAX_LINE_LENGTH) {
      throw new HeadersLimitError(
        `_headers line ${String(index + 1)} is ${String(line.length)} characters, ` +
          `over Cloudflare's ${String(MAX_LINE_LENGTH)}-character limit per line`,
      );
    }
    if (line.length > 0 && !/^\s/.test(line)) ruleBlocks += 1;
  }
  if (ruleBlocks > MAX_RULE_BLOCKS) {
    throw new HeadersLimitError(
      `_headers has ${String(ruleBlocks)} rule blocks, ` +
        `over Cloudflare's ${String(MAX_RULE_BLOCKS)}-rule limit per file`,
    );
  }
}
