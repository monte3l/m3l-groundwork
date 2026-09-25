// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for tokens.ts's `applyTokens` -- see
 * SECURITY.md's "Dynamic analysis" section. tokens.test.ts keeps the
 * example-based cases; this file adds fuzzed invariants over the full
 * token-table/content domain alongside it.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { applyTokens } from "../src/tokens.js";

const tokenKeyArb = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/);

/**
 * A token table whose values contain no `__KEY__`-shaped substring for any
 * key already in the table. `applyTokens` is a sequential, non-recursive
 * string-replace: a later key's value re-introducing an EARLIER key's
 * placeholder text is never revisited (that key's turn has already passed),
 * so both "every placeholder gone" and "idempotent" only hold under this
 * precondition -- a real, documented limitation of a plain string-replace,
 * not a bug to fix (see tokens.ts's own module doc).
 */
const tokenTableArb = fc
  .dictionary(tokenKeyArb, fc.string(), { minKeys: 1, maxKeys: 6 })
  .filter((tokens) => {
    const keys = Object.keys(tokens);
    return Object.values(tokens).every(
      (value) => !keys.some((key) => value.includes(`__${key}__`)),
    );
  });

/** `__KEY__` for every key in `tokens`, in table order, plus arbitrary filler. */
function buildContent(tokens: Record<string, string>, filler: string): string {
  return `${Object.keys(tokens)
    .map((key) => `__${key}__`)
    .join("")}${filler}`;
}

describe("applyTokens", () => {
  it("leaves no __KEY__ occurrence for any key in the table", () => {
    fc.assert(
      fc.property(tokenTableArb, fc.string(), (tokens, filler) => {
        const content = buildContent(tokens, filler);
        const result = applyTokens(content, tokens);
        for (const key of Object.keys(tokens)) {
          expect(result.includes(`__${key}__`)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("is idempotent when no token value re-introduces a __KEY__-shaped placeholder for a key in the same table", () => {
    fc.assert(
      fc.property(tokenTableArb, fc.string(), (tokens, filler) => {
        const content = buildContent(tokens, filler);
        const once = applyTokens(content, tokens);
        const twice = applyTokens(once, tokens);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });
});
