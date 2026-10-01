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
});
