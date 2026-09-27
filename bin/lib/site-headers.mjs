// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pure, zero-dependency builders for the docs site's Cloudflare Workers
 * static-assets `_headers` file: a CSP `script-src` hash for the one inline
 * script (`hashInlineScript`), the external `<img>` hosts the CSP's
 * `img-src` must allow (`externalImageHosts`), and the file text itself
 * (`buildHeadersFile`) -- a fixed two-rule-block shape (`/*` security
 * headers, then an immutable cache rule for the vendored fonts). Cloudflare
 * caps a `_headers` line at 2000 characters and a file at 100 rules; the
 * fixed shape can never reach the rule cap, but a long `img-src` list can
 * reach the line cap, so that one is checked and fails loudly with a
 * `HeadersLimitError` rather than shipping a file Cloudflare truncates.
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

const IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const ABSOLUTE_HTTP_RE = /^https?:\/\//i;

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
 * without a `src` are ignored.
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
 * @throws {HeadersLimitError} if any line exceeds Cloudflare's 2000-character limit
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
  for (const [index, line] of lines.entries()) {
    if (line.length > MAX_LINE_LENGTH) {
      throw new HeadersLimitError(
        `_headers line ${String(index + 1)} is ${String(line.length)} characters, ` +
          `over Cloudflare's ${String(MAX_LINE_LENGTH)}-character limit per line`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
