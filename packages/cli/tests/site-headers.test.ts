// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers bin/lib/site-headers.mjs -- pure functions that build and validate
 * the Cloudflare Workers static-assets `_headers` file for the docs site,
 * plain ESM under bin/ outside every tsconfig, loaded by URL (see
 * design-tokens.test.ts / markdown.test.ts for the same pattern). Exercises
 * `hashInlineScript` (a CSP script-src hash, checked against Node's own
 * `node:crypto` computing the identical algorithm independently),
 * `externalImageHosts` (scraping `<img src>` hosts out of rendered HTML
 * fragments shaped after the real README badges), and `buildHeadersFile`
 * (the exact, whitespace-sensitive `_headers` file text) against small
 * synthetic fixtures.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface BuildHeadersOptions {
  scriptHash: string;
  imageHosts: string[];
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// design-tokens.test.ts / markdown.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "site-headers.mjs")).href
)) as {
  HeadersLimitError: new (
    message?: string,
    options?: { cause?: unknown },
  ) => Error;
  hashInlineScript: (scriptSource: string) => string;
  externalImageHosts: (htmlPages: string[]) => string[];
  buildHeadersFile: (options: BuildHeadersOptions) => string;
};

/**
 * Builds the exact expected `_headers` file text for a given scriptHash
 * (already including its own "sha256-" prefix) and an ordered list of bare
 * image hostnames -- mirrors the contract's fixed two-rule-block shape byte
 * for byte, so a divergence here is a genuine format regression, not a
 * loose approximation.
 */
function expectedHeadersFile(scriptHash: string, imageHosts: string[]): string {
  const imgSrc = [
    "'self'",
    ...imageHosts.map((host) => `https://${host}`),
  ].join(" ");
  const cspLine =
    `Content-Security-Policy: default-src 'none'; script-src '${scriptHash}'; ` +
    `style-src 'self'; font-src 'self'; img-src ${imgSrc}; base-uri 'none'; ` +
    `form-action 'none'; frame-ancestors 'none'`;
  const lines = [
    "/*",
    `  ${cspLine}`,
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: interest-cohort=(), camera=(), microphone=(), geolocation=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "",
    "/assets/source/fonts/*",
    "  Cache-Control: public, max-age=31536000, immutable",
  ];
  return lines.join("\n") + "\n";
}

describe("HeadersLimitError", () => {
  it("is a named Error subclass", () => {
    const error = new lib.HeadersLimitError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HeadersLimitError");
    expect(error.message).toBe("boom");
  });
});

describe("hashInlineScript", () => {
  it("matches an independently computed sha256(base64) hash of the same UTF-8 bytes", () => {
    const source = "console.log('site-headers test fixture');";
    const expected =
      "sha256-" + createHash("sha256").update(source, "utf8").digest("base64");
    expect(lib.hashInlineScript(source)).toBe(expected);
  });

  it("is deterministic: the same input twice produces identical output", () => {
    const source = "const x = 1;";
    expect(lib.hashInlineScript(source)).toBe(lib.hashInlineScript(source));
  });

  it("produces different output for different inputs", () => {
    expect(lib.hashInlineScript("const x = 1;")).not.toBe(
      lib.hashInlineScript("const x = 2;"),
    );
  });

  it('always starts with the literal prefix "sha256-" and contains no whitespace', () => {
    const hash = lib.hashInlineScript("document.title = 'hi';");
    expect(hash.startsWith("sha256-")).toBe(true);
    expect(/\s/.test(hash)).toBe(false);
  });

  it("throws for an empty string", () => {
    expect(() => lib.hashInlineScript("")).toThrow(Error);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an array", ["not", "a", "string"]],
  ])("throws for %s (not a string)", (_label, value) => {
    expect(() => lib.hashInlineScript(value as unknown as string)).toThrow(
      Error,
    );
  });
});

describe("externalImageHosts", () => {
  it("extracts a bare hostname from a realistic README-badge-shaped fragment", () => {
    const page =
      '<p class="body"><a class="m3l-link" href="https://api.securityscorecards.dev/projects/github.com/monte3l/m3l-groundwork">' +
      '<img src="https://api.securityscorecards.dev/projects/github.com/monte3l/m3l-groundwork/badge" alt="OpenSSF Scorecard"></a></p>';
    expect(lib.externalImageHosts([page])).toEqual([
      "api.securityscorecards.dev",
    ]);
  });

  it("handles a single-quoted src attribute the same as a double-quoted one", () => {
    const page = "<img src='https://badge.socket.dev/x.svg' alt='Socket'>";
    expect(lib.externalImageHosts([page])).toEqual(["badge.socket.dev"]);
  });

  it("ignores an <img> with a relative src (no scheme)", () => {
    expect(lib.externalImageHosts(['<img src="./foo.png" alt="a">'])).toEqual(
      [],
    );
    expect(lib.externalImageHosts(['<img src="/foo.png" alt="a">'])).toEqual(
      [],
    );
  });

  it("extracts an http:// (not just https://) image host as a bare hostname", () => {
    expect(
      lib.externalImageHosts(['<img src="http://example.com/x.png">']),
    ).toEqual(["example.com"]);
  });

  it("de-duplicates the same host appearing in multiple <img> tags on one page", () => {
    const page =
      '<img src="https://badge.socket.dev/a.svg">' +
      '<img src="https://badge.socket.dev/b.svg">';
    expect(lib.externalImageHosts([page])).toEqual(["badge.socket.dev"]);
  });

  it("de-duplicates the same host appearing across multiple pages in the input array", () => {
    const pageOne = '<img src="https://badge.socket.dev/a.svg">';
    const pageTwo = '<img src="https://badge.socket.dev/b.svg">';
    expect(lib.externalImageHosts([pageOne, pageTwo])).toEqual([
      "badge.socket.dev",
    ]);
  });

  it("sorts two different hosts alphabetically", () => {
    const page =
      '<img src="https://z-example.dev/a.svg">' +
      '<img src="https://a-example.dev/b.svg">';
    expect(lib.externalImageHosts([page])).toEqual([
      "a-example.dev",
      "z-example.dev",
    ]);
  });

  it("returns an empty array for input with no <img> tags at all", () => {
    expect(
      lib.externalImageHosts(['<p class="body">No images here.</p>']),
    ).toEqual([]);
  });

  it("returns an empty array for an empty input array", () => {
    expect(lib.externalImageHosts([])).toEqual([]);
  });

  it("ignores an <img> tag with no src attribute at all", () => {
    expect(lib.externalImageHosts(['<img alt="no src here">'])).toEqual([]);
  });

  it("lowercases a mixed-case hostname and scheme", () => {
    expect(
      lib.externalImageHosts(['<img src="HTTPS://Badge.Socket.DEV/x.png">']),
    ).toEqual(["badge.socket.dev"]);
  });
});

describe("buildHeadersFile", () => {
  it("builds the exact two-rule-block file text with zero image hosts", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: [],
    });
    expect(output).toBe(expectedHeadersFile("sha256-abc123==", []));
  });

  it("embeds the scriptHash verbatim (already including its own sha256- prefix) in the CSP script-src directive", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: [],
    });
    expect(output).toContain("script-src 'sha256-abc123=='");
    // Never doubled, e.g. "sha256-sha256-..." or a stripped-then-re-added form.
    expect(output).not.toContain("sha256-sha256-");
  });

  it("builds the exact file text with one image host", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: ["badge.socket.dev"],
    });
    expect(output).toBe(
      expectedHeadersFile("sha256-abc123==", ["badge.socket.dev"]),
    );
    expect(output).toContain("img-src 'self' https://badge.socket.dev;");
  });

  it("builds the exact file text with multiple image hosts, in the given order", () => {
    const hosts = ["badge.socket.dev", "api.securityscorecards.dev"];
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: hosts,
    });
    expect(output).toBe(expectedHeadersFile("sha256-abc123==", hosts));
    expect(output).toContain(
      "img-src 'self' https://badge.socket.dev https://api.securityscorecards.dev;",
    );
  });

  it("has no trailing space after 'self' in img-src when imageHosts is empty", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: [],
    });
    expect(output).toContain("img-src 'self';");
  });

  it("indents every header line by exactly two spaces", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: ["badge.socket.dev"],
    });
    const headerLines = output
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("/"));
    expect(headerLines.length).toBeGreaterThan(0);
    for (const line of headerLines) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.startsWith("   ")).toBe(false);
    }
  });

  it("separates the two rule blocks with exactly one blank line", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: [],
    });
    const blocks = output.split("\n\n");
    expect(blocks).toHaveLength(2);
  });

  it("emits the two path rules in the documented order: /* first, then the fonts cache rule", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: [],
    });
    const starIndex = output.indexOf("/*");
    const fontsIndex = output.indexOf("/assets/source/fonts/*");
    expect(starIndex).toBeGreaterThanOrEqual(0);
    expect(fontsIndex).toBeGreaterThan(starIndex);
  });

  it("includes the fonts caching rule as a standalone line", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: [],
    });
    expect(output).toContain("/assets/source/fonts/*\n");
    expect(output).toContain(
      "  Cache-Control: public, max-age=31536000, immutable",
    );
  });

  it("ends with a single trailing newline and no trailing whitespace on any line", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: ["badge.socket.dev"],
    });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
    const lines = output.split("\n");
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("never contains a carriage return", () => {
    const output = lib.buildHeadersFile({
      scriptHash: "sha256-abc123==",
      imageHosts: ["badge.socket.dev"],
    });
    expect(output).not.toContain("\r");
  });

  // The 100-rule-block Cloudflare limit is a documented invariant of this
  // function's fixed two-block output shape -- it always emits exactly 2
  // blocks regardless of input, so nothing this function's own test suite
  // can pass ever approaches that limit. What IS testable here is the
  // opposite: normal, realistic input never trips ANY limit check.
  it("never throws HeadersLimitError for normal, realistic input", () => {
    expect(() =>
      lib.buildHeadersFile({
        scriptHash: "sha256-abc123==",
        imageHosts: ["badge.socket.dev", "api.securityscorecards.dev"],
      }),
    ).not.toThrow();
  });

  it("throws HeadersLimitError when the img-src line would exceed 2000 characters", () => {
    const manyHosts = Array.from(
      { length: 400 },
      (_unused, i) => `h${String(i)}.example.com`,
    );
    let thrown: unknown;
    try {
      lib.buildHeadersFile({
        scriptHash: "sha256-abc123==",
        imageHosts: manyHosts,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.HeadersLimitError);
    expect((thrown as Error).message).toMatch(/line|rule/i);
  });
});
