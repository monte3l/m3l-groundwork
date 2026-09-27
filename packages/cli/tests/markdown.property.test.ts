// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for bin/lib/markdown.mjs -- see SECURITY.md's
 * "Dynamic analysis" section. markdown.test.ts keeps the example-based
 * cases; this file fuzzes strings drawn from markdown's own special-
 * character alphabet (rather than fully random Unicode, which is too
 * unlikely to hit interesting parser branches) to exercise the property
 * that matters most for a hand-rolled recursive-descent renderer: it never
 * crashes with an unrelated TypeError/RangeError -- both an infinite-
 * recursion "Maximum call stack size exceeded" and an "Invalid string
 * length" error were real bugs this exact kind of fuzzing caught during
 * development, before being fixed.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface Heading {
  level: number;
  text: string;
  slug: string;
}

interface RenderResult {
  html: string;
  headings: Heading[];
  italics: string[];
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// design-tokens.property.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "markdown.mjs")).href
)) as {
  MarkdownError: new (message?: string) => Error;
  slugifyHeading: (text: string) => string;
  renderMarkdown: (source: string) => RenderResult;
};

// fast-check v4 has no built-in `fc.stringOf`; this repo's own convention
// (see design-tokens.property.test.ts's `keyArb`) builds a small, targeted
// alphabet instead of `fc.string()`'s full Unicode domain, which almost
// never lands on the specific combinations (an unterminated fence, an
// unbalanced bracket, a deeply nested list marker) that actually exercise
// this parser's recursive branches.
const MARKDOWN_CHARS = [
  "`",
  "*",
  "_",
  "[",
  "]",
  "(",
  ")",
  "#",
  ">",
  "-",
  "!",
  "^",
  "|",
  ":",
  "~",
  " ",
  "\n",
  "a",
  "b",
  "1",
  ".",
];

const markdownStringArb = fc
  .array(fc.constantFrom(...MARKDOWN_CHARS), { maxLength: 60 })
  .map((chars) => chars.join(""));

describe("renderMarkdown: never crashes on arbitrary markdown-shaped input", () => {
  it("never throws anything other than a MarkdownError (itself an Error)", () => {
    fc.assert(
      fc.property(markdownStringArb, (source) => {
        let thrown: unknown;
        try {
          lib.renderMarkdown(source);
        } catch (error) {
          thrown = error;
        }
        if (thrown !== undefined) {
          expect(thrown).toBeInstanceOf(Error);
          expect(thrown).toBeInstanceOf(lib.MarkdownError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("always returns an html string, a headings array and an italics array when it doesn't throw", () => {
    fc.assert(
      fc.property(markdownStringArb, (source) => {
        let result: RenderResult | undefined;
        try {
          result = lib.renderMarkdown(source);
        } catch (error) {
          expect(error).toBeInstanceOf(lib.MarkdownError);
          return;
        }
        expect(typeof result.html).toBe("string");
        expect(Array.isArray(result.headings)).toBe(true);
        expect(Array.isArray(result.italics)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("slugifyHeading: total, whitespace-free for any input", () => {
  it("never throws for arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        expect(() => lib.slugifyHeading(text)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("never contains a whitespace character in its output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        const slug = lib.slugifyHeading(text);
        expect(/\s/.test(slug)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("never throws and never produces whitespace for the markdown-shaped alphabet either", () => {
    fc.assert(
      fc.property(markdownStringArb, (text) => {
        let slug: string | undefined;
        expect(() => {
          slug = lib.slugifyHeading(text);
        }).not.toThrow();
        expect(/\s/.test(slug ?? "")).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
