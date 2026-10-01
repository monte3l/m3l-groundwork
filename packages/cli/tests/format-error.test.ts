// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `formatErrorChain` renders an unknown thrown value and its full `cause`
 * chain as a human-readable multi-line string -- what
 * `bin/m3l-groundwork.mjs` prints to stderr instead of a bare
 * `error.message`, which silently drops every chained cause. See
 * `src/format-error.ts`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { formatErrorChain } from "../src/format-error.js";

describe("formatErrorChain", () => {
  it("types as (error: unknown) => string", () => {
    expectTypeOf(formatErrorChain).toEqualTypeOf<(error: unknown) => string>();
  });

  it("renders a bare Error's message as the single line, with no cause", () => {
    const error = new Error("top-level failure");
    expect(formatErrorChain(error)).toBe("top-level failure");
  });

  it("renders String(error) for a non-Error thrown value", () => {
    expect(formatErrorChain("boom")).toBe("boom");
    expect(formatErrorChain(42)).toBe("42");
  });

  it("renders a two-level cause chain, each depth indented two more spaces", () => {
    const root = new Error("root cause");
    const middle = new Error("middle failure", { cause: root });
    const top = new Error("top failure", { cause: middle });

    expect(formatErrorChain(top)).toBe(
      [
        "top failure",
        "  caused by: middle failure",
        "    caused by: root cause",
      ].join("\n"),
    );
  });

  it("renders a non-Error cause with String(), not JSON.stringify or [object Object]", () => {
    const top = new Error("top failure", { cause: "a raw string cause" });
    expect(formatErrorChain(top)).toBe(
      ["top failure", "  caused by: a raw string cause"].join("\n"),
    );
  });

  it("terminates on a cause cycle rather than recursing forever", () => {
    const a = new Error("error A");
    const b = new Error("error B", { cause: a });
    a.cause = b;

    let result = "";
    expect(() => {
      result = formatErrorChain(a);
    }).not.toThrow();
    // Each message appears exactly once -- the cycle is detected and the
    // chain stops before repeating error A a second time.
    expect(
      result.split("\n").filter((line) => line.includes("error A")).length,
    ).toBe(1);
    expect(
      result.split("\n").filter((line) => line.includes("error B")).length,
    ).toBe(1);
  });

  it("lists every AggregateError.errors entry as its own 'caused by:' line", () => {
    const inner1 = new Error("inner failure one");
    const inner2 = new Error("inner failure two");
    const agg = new AggregateError([inner1, inner2], "aggregate failure");

    const result = formatErrorChain(agg);
    const lines = result.split("\n");
    expect(lines[0]).toBe("aggregate failure");
    expect(lines).toContain("  caused by: inner failure one");
    expect(lines).toContain("  caused by: inner failure two");
  });

  it("does not throw when an AggregateError's errors property was reassigned to a non-array", () => {
    const agg = new AggregateError([], "aggregate failure");
    // Simulates a caller/collaborator that doesn't honor the errors: Error[]
    // contract -- formatErrorChain must stay defensive about it rather than
    // assume the type.
    (agg as unknown as { errors: unknown }).errors = { not: "an array" };

    let result = "";
    expect(() => {
      result = formatErrorChain(agg);
    }).not.toThrow();
    expect(result).toBe("aggregate failure");
  });

  describe("dedupes a cause whose message is already contained in its parent's", () => {
    it("omits the 'caused by:' line when the cause's message is a substring of the parent's", () => {
      const dupCause = new Error("disk full");
      const top = new Error("write failed: disk full", { cause: dupCause });

      const result = formatErrorChain(top);

      expect(result).toBe("write failed: disk full");
      expect(result).not.toContain("caused by:");
    });

    it("still prints a cause whose message is NOT a substring of its parent's", () => {
      const distinctCause = new Error("ENOSPC");
      const top = new Error("write failed", { cause: distinctCause });

      const result = formatErrorChain(top);

      expect(result).toBe(["write failed", "  caused by: ENOSPC"].join("\n"));
    });
  });

  it("truncates a cause chain deeper than 32 links, ending with a line containing '...', rather than growing unbounded", () => {
    let current = new Error("link 0");
    const chainLength = 40;
    for (let i = 1; i < chainLength; i++) {
      current = new Error(`link ${i}`, { cause: current });
    }

    let result = "";
    expect(() => {
      result = formatErrorChain(current);
    }).not.toThrow();

    const lines = result.split("\n");
    // Well short of 1 (top line) + 40 links -- the chain was cut off.
    expect(lines.length).toBeLessThan(chainLength);
    expect(lines.at(-1)).toContain("...");
  });

  describe("falls back to a placeholder instead of throwing on an unprintable value", () => {
    const unprintableCases: [string, unknown][] = [
      ["a null-prototype object", Object.create(null) as unknown],
      [
        "an object whose Symbol.toPrimitive throws",
        {
          [Symbol.toPrimitive]() {
            throw new Error("cannot stringify");
          },
        },
      ],
    ];

    it.each(unprintableCases)(
      "as the top-level thrown value (%s)",
      (_l, value) => {
        let result = "";
        expect(() => {
          result = formatErrorChain(value);
        }).not.toThrow();
        expect(result).toBe("[unprintable value]");
      },
    );

    it.each(unprintableCases)("as a chained cause (%s)", (_l, value) => {
      const top = new Error("top failure", { cause: value });
      let result = "";
      expect(() => {
        result = formatErrorChain(top);
      }).not.toThrow();
      expect(result).toBe(
        ["top failure", "  caused by: [unprintable value]"].join("\n"),
      );
    });
  });
});
