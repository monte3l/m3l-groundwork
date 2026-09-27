// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for bin/lib/site-headers.mjs -- see SECURITY.md's
 * "Dynamic analysis" section. site-headers.test.ts keeps the example-based
 * cases; this file fuzzes `hashInlineScript` against an independent
 * `node:crypto` computation of the exact same algorithm (a full differential
 * check, not a smoke test), fuzzes `externalImageHosts` over synthetic
 * hostname sets (sorted, de-duplicated, case-insensitive), and fuzzes
 * `buildHeadersFile` over small random host lists to pin its fixed
 * two-rule-block shape.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface BuildHeadersOptions {
  scriptHash: string;
  imageHosts: string[];
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// site-headers.test.ts / design-tokens.property.test.ts for the same
// pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "site-headers.mjs")).href
)) as {
  HeadersLimitError: new (message?: string) => Error;
  hashInlineScript: (scriptSource: string) => string;
  externalImageHosts: (htmlPages: string[]) => string[];
  buildHeadersFile: (options: BuildHeadersOptions) => string;
};

describe("hashInlineScript: differential check against node:crypto", () => {
  it("always equals sha256- + base64(SHA-256(utf8 bytes)) computed independently", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (source) => {
        const expected =
          "sha256-" +
          createHash("sha256").update(source, "utf8").digest("base64");
        expect(lib.hashInlineScript(source)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

// A small, label-shaped alphabet (see design-tokens.property.test.ts's
// keyArb and markdown.property.test.ts's MARKDOWN_CHARS for the same
// convention) -- a fully random Unicode generator would almost never
// produce anything shaped like a real hostname label.
const labelArb = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
const hostArb = fc
  .array(labelArb, { minLength: 1, maxLength: 3 })
  .map((labels) => labels.join(".") + ".example.com");

describe("externalImageHosts: sortedness, de-duplication, subset relationship", () => {
  it("returns the sorted, de-duplicated set of hosts fed in via <img src>, losing none and inventing none", () => {
    fc.assert(
      fc.property(fc.array(hostArb, { maxLength: 10 }), (hosts) => {
        const pages = hosts.map((host) => `<img src="https://${host}/x.png">`);
        const result = lib.externalImageHosts(pages);

        const expectedUnique = [...new Set(hosts)].sort();
        expect(result).toEqual(expectedUnique);

        // Sorted.
        const sorted = [...result].sort();
        expect(result).toEqual(sorted);

        // De-duplicated.
        expect(new Set(result).size).toBe(result.length);
      }),
      { numRuns: 200 },
    );
  });

  it("returns an empty array when no host is fed in at all", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constant('<p class="body">no images</p>')),
        (pages) => {
          expect(lib.externalImageHosts(pages)).toEqual([]);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("externalImageHosts: case-insensitive host and scheme handling", () => {
  it("returns the same lowercase host regardless of casing in the host or the scheme", () => {
    fc.assert(
      fc.property(
        hostArb,
        fc.boolean(),
        fc.boolean(),
        (host, upperHost, upperScheme) => {
          const hostPart = upperHost ? host.toUpperCase() : host;
          const scheme = upperScheme ? "HTTPS" : "https";
          const page = `<img src="${scheme}://${hostPart}/x.png">`;
          expect(lib.externalImageHosts([page])).toEqual([host]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("buildHeadersFile: fixed two-rule-block shape", () => {
  const smallHostsArb = fc.array(hostArb, { maxLength: 5 });

  it("always has exactly one blank line separating exactly two non-empty rule blocks", () => {
    fc.assert(
      fc.property(smallHostsArb, (imageHosts) => {
        const output = lib.buildHeadersFile({
          scriptHash: "sha256-fixedTestHash==",
          imageHosts,
        });
        const blocks = output.split("\n\n");
        expect(blocks).toHaveLength(2);
        for (const block of blocks) {
          expect(block.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("always starts with '/*' and always contains the fonts rule path as a standalone line", () => {
    fc.assert(
      fc.property(smallHostsArb, (imageHosts) => {
        const output = lib.buildHeadersFile({
          scriptHash: "sha256-fixedTestHash==",
          imageHosts,
        });
        expect(output.startsWith("/*")).toBe(true);
        expect(output.split("\n")).toContain("/assets/source/fonts/*");
      }),
      { numRuns: 100 },
    );
  });

  it("always ends with exactly one trailing newline and never contains \\r", () => {
    fc.assert(
      fc.property(smallHostsArb, (imageHosts) => {
        const output = lib.buildHeadersFile({
          scriptHash: "sha256-fixedTestHash==",
          imageHosts,
        });
        expect(output.endsWith("\n")).toBe(true);
        expect(output.endsWith("\n\n")).toBe(false);
        expect(output).not.toContain("\r");
      }),
      { numRuns: 100 },
    );
  });

  it("never throws for a small, realistic set of image hosts", () => {
    fc.assert(
      fc.property(smallHostsArb, (imageHosts) => {
        expect(() =>
          lib.buildHeadersFile({
            scriptHash: "sha256-fixedTestHash==",
            imageHosts,
          }),
        ).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
