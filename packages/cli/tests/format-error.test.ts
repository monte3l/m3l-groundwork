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

  describe("suppression requires a non-empty, sufficiently long, or exactly-equal message", () => {
    it.each([
      ["new Error()", new Error()],
      ["new TypeError('')", new TypeError("")],
    ])(
      "never suppresses a cause with an empty message (%s), even though every string 'includes' the empty string",
      (_l, emptyCause) => {
        const top = new Error("top failure", { cause: emptyCause });
        expect(formatErrorChain(top)).toBe(
          ["top failure", "  caused by: "].join("\n"),
        );
      },
    );

    it("does not suppress a short cause message ('1') that is merely a substring of the parent's ('exit 1') -- suppression needs length >= 8", () => {
      const shortCause = new Error("1");
      const top = new Error("exit 1", { cause: shortCause });
      expect(formatErrorChain(top)).toBe(
        ["exit 1", "  caused by: 1"].join("\n"),
      );
    });

    it("suppresses a cause whose message equals the parent's after trim(), even though it's shorter than the 8-char floor", () => {
      const cause = new Error("abc");
      const top = new Error("  abc  ", { cause });
      const result = formatErrorChain(top);
      expect(result).toBe("  abc  ");
      expect(result).not.toContain("caused by:");
    });

    it("does not suppress a 7-char substring cause -- one short of the 8-char floor", () => {
      const cause = new Error("abcdefg");
      const top = new Error("xxabcdefgxx", { cause });
      expect(formatErrorChain(top)).toContain("caused by: abcdefg");
    });

    it("suppresses an 8-char substring cause -- exactly at the floor", () => {
      const cause = new Error("abcdefgh");
      const top = new Error("xxabcdefghxx", { cause });
      const result = formatErrorChain(top);
      expect(result).not.toContain("caused by:");
    });

    it("still suppresses a long (>= 8 char) substring cause (existing behaviour)", () => {
      const distinctCause = new Error("disk full");
      const top = new Error("write failed: disk full", {
        cause: distinctCause,
      });
      const result = formatErrorChain(top);
      expect(result).toBe("write failed: disk full");
      expect(result).not.toContain("caused by:");
    });
  });

  it("counts a suppressed link toward the 32-deep cap: a chain of 100000 identical-message causes (every link suppressed) terminates without a stack overflow and ends with a '...' line", () => {
    const longMessage =
      "same message repeated at every link, long enough to clear the 8-char floor";
    let current = new Error(longMessage);
    const chainLength = 100_000;
    for (let i = 1; i < chainLength; i++) {
      current = new Error(longMessage, { cause: current });
    }

    let result = "";
    expect(() => {
      result = formatErrorChain(current);
    }).not.toThrow();

    const lines = result.split("\n");
    expect(lines.length).toBeLessThan(chainLength);
    expect(lines.at(-1)).toContain("...");
  });

  describe("stays defensive when reading a value throws instead of propagating the throw", () => {
    it("does not throw when a cause accessor itself throws, and reports it as [unprintable value]", () => {
      const top = new Error("top failure");
      Object.defineProperty(top, "cause", {
        get() {
          throw new Error("cause getter boom");
        },
        configurable: true,
      });

      let result = "";
      expect(() => {
        result = formatErrorChain(top);
      }).not.toThrow();
      expect(result).toContain("[unprintable value]");
    });

    it("does not throw when a cause's message accessor itself throws, and reports it as [unprintable value]", () => {
      const badCause = new Error("original");
      Object.defineProperty(badCause, "message", {
        get() {
          throw new Error("message getter boom");
        },
        configurable: true,
      });
      const top = new Error("top failure", { cause: badCause });

      let result = "";
      expect(() => {
        result = formatErrorChain(top);
      }).not.toThrow();
      expect(result).toContain("[unprintable value]");
    });

    it("does not throw when a cause's message was reassigned to a Symbol, and reports it as [unprintable value]", () => {
      const badCause = new Error("original");
      (badCause as unknown as { message: unknown }).message = Symbol("weird");
      const top = new Error("top failure", { cause: badCause });

      let result = "";
      expect(() => {
        result = formatErrorChain(top);
      }).not.toThrow();
      expect(result).toContain("[unprintable value]");
    });

    it("does not throw when an AggregateError's errors accessor itself throws, and reports it as [unprintable value]", () => {
      const agg = new AggregateError([], "aggregate failure");
      Object.defineProperty(agg, "errors", {
        get() {
          throw new Error("errors getter boom");
        },
        configurable: true,
      });

      let result = "";
      expect(() => {
        result = formatErrorChain(agg);
      }).not.toThrow();
      expect(result).toContain("[unprintable value]");
    });
  });

  describe("attributes the truncation '...' line to the branch that was cut, not to the end of the whole output", () => {
    it("places '...' right after the deep branch's last printed line and before a sibling's own 'caused by:' line", () => {
      let current = new Error("link 0");
      const deepLevels = 40;
      for (let i = 1; i < deepLevels; i++) {
        current = new Error(`link ${i}`, { cause: current });
      }
      const shortError = new Error("a short unrelated sibling error");
      const agg = new AggregateError([current, shortError], "aggregate top");

      const result = formatErrorChain(agg);
      const lines = result.split("\n");

      const truncationIndex = lines.findIndex((line) => line.includes("..."));
      const shortErrorIndex = lines.findIndex((line) =>
        line.includes("a short unrelated sibling error"),
      );
      const linkLineIndexes = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /link \d+/.test(line))
        .map(({ i }) => i);
      const lastLinkLineIndex = Math.max(...linkLineIndexes);

      expect(truncationIndex).toBeGreaterThan(-1);
      // shortError's own "caused by:" line is still printed, not dropped
      // because a sibling branch truncated.
      expect(shortErrorIndex).toBeGreaterThan(-1);
      expect(truncationIndex).toBe(lastLinkLineIndex + 1);
      expect(truncationIndex).toBeLessThan(shortErrorIndex);
    });
  });
});
