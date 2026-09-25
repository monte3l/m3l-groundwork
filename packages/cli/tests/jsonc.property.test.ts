// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for jsonc.ts, exercising the full input domain
 * rather than hand-picked examples -- see SECURITY.md's "Dynamic analysis"
 * section. jsonc.test.ts keeps the example-based cases; this file adds
 * fuzzed round-trip and never-throws invariants alongside it.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { parseJsonc, stripJsComments, stripJsoncNoise } from "../src/jsonc.js";

/**
 * `fc.jsonValue()` can produce `-0`, which `JSON.stringify` also turns into
 * the text `"0"` -- so parsing it back gives `+0`, and `toEqual` (unlike
 * `JSON.stringify`-based equality) distinguishes `-0` from `+0`. That is a
 * limitation of the round-trip through `JSON.stringify`, not a defect in
 * `parseJsonc`, so values containing a `-0` anywhere are filtered out rather
 * than asserted on.
 */
function containsNegativeZero(value: unknown): boolean {
  if (typeof value === "number") return Object.is(value, -0);
  if (Array.isArray(value)) return value.some(containsNegativeZero);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNegativeZero);
  }
  return false;
}

const roundTrippableJsonValue = fc
  .jsonValue({ maxDepth: 3 })
  .filter((value) => !containsNegativeZero(value));

/** True for a non-null object with at least one own key, or a non-empty array -- the shapes {@link toJsoncVariant} has a `{`/`[` ... `}`/`]` structure to anchor comment/comma insertion on. */
function isNonEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
}

const nonEmptyContainerJsonValue =
  roundTrippableJsonValue.filter(isNonEmptyContainer);

/**
 * Deterministically turns a pretty-printed JSON string for a non-empty
 * top-level container into a real JSONC variant, inserting only at safe,
 * structural anchors -- immediately after the first `{`/`[` and immediately
 * before the last matching `}`/`]` -- never at a random byte offset that
 * could land inside a string literal:
 * - a `//` line comment on its own line, right after the opening bracket;
 * - a trailing comma right after the last member, before the closing
 *   bracket;
 * - a `/* *\/` block comment on its own line, right before the closing
 *   bracket.
 */
function toJsoncVariant(prettyJson: string): string {
  const openChar = prettyJson.charAt(0);
  const withLineComment = `${openChar}\n  // generated line comment\n${prettyJson.slice(1)}`;

  const closeIdx = withLineComment.length - 1;
  const beforeClose = withLineComment.slice(0, closeIdx);
  const lastNewlineIdx = beforeClose.lastIndexOf("\n");
  const withTrailingComma =
    beforeClose.slice(0, lastNewlineIdx) +
    "," +
    beforeClose.slice(lastNewlineIdx) +
    withLineComment.slice(closeIdx);

  const closeIdx2 = withTrailingComma.length - 1;
  return (
    withTrailingComma.slice(0, closeIdx2) +
    "/* generated block comment */\n" +
    withTrailingComma.slice(closeIdx2)
  );
}

describe("parseJsonc", () => {
  it("round-trips any JSON-serializable value through JSON.stringify -> parseJsonc", () => {
    fc.assert(
      fc.property(roundTrippableJsonValue, (value) => {
        const result = parseJsonc(JSON.stringify(value));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual(value);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Regression: found by the round-trip property above shrinking to
  // `{"":{"":[",]"]}}` -- the trailing-comma cleanup once ran as a blind
  // regex over the whole text and corrupted a `,]`/`,}` inside a string.
  it("does not corrupt a string value containing a comma immediately followed by } or ]", () => {
    const value = { "": { "": [",]"] } };
    const result = parseJsonc(JSON.stringify(value));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(value);
    }
  });

  it("never throws on arbitrary string input, always returning a structured JsoncReadResult", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let result: ReturnType<typeof parseJsonc> | undefined;
        expect(() => {
          result = parseJsonc(input);
        }).not.toThrow();
        expect(result).toBeDefined();
        if (result === undefined) return;
        if (result.ok) {
          expect(Object.hasOwn(result, "value")).toBe(true);
        } else {
          expect(typeof result.error).toBe("string");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("round-trips a real JSONC variant (comments + trailing comma) of any non-empty JSON container", () => {
    fc.assert(
      fc.property(nonEmptyContainerJsonValue, (value) => {
        const prettyJson = JSON.stringify(value, null, 2);
        const jsoncSource = toJsoncVariant(prettyJson);

        const result = parseJsonc(jsoncSource);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual(value);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("stripJsoncNoise", () => {
  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => stripJsoncNoise(input)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(typeof stripJsoncNoise(input)).toBe("string");
      }),
      { numRuns: 200 },
    );
  });
});

describe("stripJsComments", () => {
  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => stripJsComments(input)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(typeof stripJsComments(input)).toBe("string");
      }),
      { numRuns: 200 },
    );
  });
});
