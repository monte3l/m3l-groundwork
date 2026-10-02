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
import { escapeControls, formatErrorChain } from "../src/format-error.js";

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

  it("counts a suppressed link toward the 32-deep cap: a chain of 40 identical-message causes (every link suppressed) terminates without a stack overflow and ends with a '...' line", () => {
    const longMessage =
      "same message repeated at every link, long enough to clear the 8-char floor";
    let current = new Error(longMessage);
    const chainLength = 40;
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

  describe("never throws on a Proxy-wrapped or revoked Error value, rendering [unprintable value] instead", () => {
    it("handles a Proxy of an Error whose getPrototypeOf trap throws, as the top-level thrown value", () => {
      const target = new Error("proxied failure");
      const proxy = new Proxy(target, {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap boom");
        },
      });

      let result = "";
      expect(() => {
        result = formatErrorChain(proxy);
      }).not.toThrow();
      expect(result).toBe("[unprintable value]");
    });

    it("handles a Proxy of an Error whose getPrototypeOf trap throws, as a chained cause", () => {
      const target = new Error("proxied failure");
      const proxy = new Proxy(target, {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap boom");
        },
      });
      const top = new Error("top failure", { cause: proxy });

      let result = "";
      expect(() => {
        result = formatErrorChain(top);
      }).not.toThrow();
      expect(result).toBe(
        ["top failure", "  caused by: [unprintable value]"].join("\n"),
      );
    });

    it("handles a revoked Proxy as the top-level thrown value", () => {
      const { proxy, revoke } = Proxy.revocable(
        new Error("will be revoked"),
        {},
      );
      revoke();

      let result = "";
      expect(() => {
        result = formatErrorChain(proxy);
      }).not.toThrow();
      expect(result).toBe("[unprintable value]");
    });

    it("handles a revoked Proxy as a chained cause", () => {
      const { proxy, revoke } = Proxy.revocable(
        new Error("will be revoked"),
        {},
      );
      revoke();
      const top = new Error("top failure", { cause: proxy });

      let result = "";
      expect(() => {
        result = formatErrorChain(top);
      }).not.toThrow();
      expect(result).toBe(
        ["top failure", "  caused by: [unprintable value]"].join("\n"),
      );
    });
  });

  describe("the 'seen' tracker only dedupes objects/functions, and distinguishes a genuine cycle from a shared non-cyclic reference", () => {
    it("prints every member of an AggregateError whose errors array repeats primitive values, each visited independently rather than deduped like an object would be", () => {
      const agg = new AggregateError(
        ["ETIMEDOUT", "ETIMEDOUT", 1, 1],
        "multi-primitive failure",
      );

      const result = formatErrorChain(agg);
      const causedByLines = result
        .split("\n")
        .filter((line) => line.includes("caused by:"));

      expect(causedByLines).toHaveLength(4);
      expect(
        causedByLines.filter((line) => line.includes("ETIMEDOUT")),
      ).toHaveLength(2);
      expect(
        causedByLines.filter((line) => line.trim().endsWith("1")),
      ).toHaveLength(2);
    });

    it("prints a shared Error object reachable from two sibling branches fully once, and 'caused by: (see above)' the second time", () => {
      const shared = new Error("shared failure reused across siblings");
      const agg = new AggregateError(
        [shared, shared],
        "two siblings share one error object",
      );

      const result = formatErrorChain(agg);
      const lines = result.split("\n");

      expect(
        lines.filter((line) =>
          line.includes("shared failure reused across siblings"),
        ),
      ).toHaveLength(1);
      expect(
        lines.filter((line) => line.trim() === "caused by: (see above)"),
      ).toHaveLength(1);
    });

    it("still cuts a genuine cause cycle silently, with no '(see above)' marker", () => {
      const a = new Error("error A");
      const b = new Error("error B", { cause: a });
      a.cause = b;

      const result = formatErrorChain(a);

      expect(result).not.toContain("(see above)");
    });
  });

  describe("multi-line cause messages are indented under their own 'caused by:' line, continuation lines marked with '| '", () => {
    it("indents each continuation line two more spaces than its own 'caused by:' line and prefixes it with '| '", () => {
      const cause = new Error("a\nb\nc");
      const top = new Error("top failure", { cause });

      const result = formatErrorChain(top);

      expect(result).toBe(
        ["top failure", "  caused by: a", "    | b", "    | c"].join("\n"),
      );
    });

    it("keeps a literal 'caused by: fake' substring inside a cause's OWN message distinguishable from a real 'caused by:' line by its deeper indent and the '| ' marker", () => {
      const cause = new Error("header line\ncaused by: fake");
      const top = new Error("top failure", { cause });

      const result = formatErrorChain(top);
      const lines = result.split("\n");

      expect(lines[0]).toBe("top failure");
      expect(lines[1]).toBe("  caused by: header line");
      expect(lines[2]).toBe("    | caused by: fake");
      expect(lines).not.toContain("    caused by: fake");
      expect(lines[2]).not.toBe("  caused by: fake");
    });
  });

  describe("caps the children printed per parent at 32, replacing the rest with one '... and N more' line", () => {
    it("prints 32 of 40 distinct AggregateError members, then a single '... and 8 more' line", () => {
      const errors = Array.from(
        { length: 40 },
        (_unused, i) => new Error(`distinct child message number ${i}xxxxx`),
      );
      const agg = new AggregateError(errors, "forty distinct children");

      const result = formatErrorChain(agg);
      const lines = result.split("\n");
      const childLines = lines.filter((line) =>
        /distinct child message number \d+xxxxx/.test(line),
      );

      expect(childLines).toHaveLength(32);
      expect(lines.some((line) => line.trim() === "... and 8 more")).toBe(true);
    });
  });

  describe("the 'already printed for this parent' truncation branch is shared across siblings", () => {
    it("shares one truncation line across two AggregateError members that both land exactly at the depth cap (same parent, same shared cut)", () => {
      const childA = new Error("leaf A reached past the depth cap");
      const childB = new Error("leaf B reached past the depth cap");
      const agg = new AggregateError(
        [childA, childB],
        "aggregate at the cap boundary",
      );

      let node: Error = agg;
      for (let i = 0; i < 32; i++) {
        node = new Error(`wrap link number ${i} in a long chain`, {
          cause: node,
        });
      }

      const result = formatErrorChain(node);
      const lines = result.split("\n");
      const truncationLines = lines.filter((line) => line.includes("..."));

      expect(truncationLines).toHaveLength(1);
      // Neither leaf's own message is ever read: both are cut before
      // messageOf runs on them.
      expect(result).not.toContain("leaf A");
      expect(result).not.toContain("leaf B");
    });
  });

  describe("a whitespace-only cause message is not suppressed merely because trim() is empty", () => {
    it("still prints a 'caused by:' line for a cause whose message is only spaces", () => {
      const cause = new Error("   ");
      const top = new Error("top failure", { cause });

      const result = formatErrorChain(top);
      const lines = result.split("\n");

      expect(lines.length).toBeGreaterThan(1);
      expect(lines[1]?.startsWith("  caused by:")).toBe(true);
    });
  });

  describe("a cause must never be hidden by the sibling-children cap, and always prints before its siblings", () => {
    /** 40, 32 or 31 distinct `AggregateError` members alongside a `cause` whose message is easy to find in the rendered output. */
    function buildAggregateWithCause(memberCount: number): AggregateError {
      const members = Array.from(
        { length: memberCount },
        (_unused, i) =>
          new Error(
            `member-${String(i).padStart(3, "0")}-distinct-enough-text`,
          ),
      );
      return new AggregateError(members, "big", {
        cause: new Error("THE REAL ROOT CAUSE"),
      });
    }

    it.each([40, 32, 31])(
      "keeps the cause visible and prints it before any sibling member, with %i AggregateError members",
      (memberCount) => {
        const agg = buildAggregateWithCause(memberCount);
        const result = formatErrorChain(agg);
        const lines = result.split("\n");

        expect(result).toContain("THE REAL ROOT CAUSE");

        const causeLineIndex = lines.findIndex((line) =>
          line.includes("THE REAL ROOT CAUSE"),
        );
        const firstMemberLineIndex = lines.findIndex((line) =>
          line.includes("member-"),
        );
        expect(causeLineIndex).toBeGreaterThan(-1);
        expect(firstMemberLineIndex).toBeGreaterThan(-1);
        expect(causeLineIndex).toBeLessThan(firstMemberLineIndex);

        if (memberCount === 31) {
          // 31 members plus the cause fit exactly within the 32-child cap:
          // nothing is left over, so no "... and N more" line should appear.
          expect(result).not.toMatch(/\.\.\. and \d+ more/);
        }
      },
    );
  });

  describe("a top-level multi-line message is indented the same way a cause's own continuation lines are", () => {
    it("indents the top message's continuation lines two more spaces than their own leading spaces, and marks them with '| ' so a literal 'caused by:' inside the top message can't be mistaken for a real cause line", () => {
      const top = new Error("top\n  caused by: FAKE", {
        cause: new Error("real"),
      });

      const result = formatErrorChain(top);
      const lines = result.split("\n");

      expect(lines[0]).toBe("top");
      expect(lines[1]).toBe("  " + "| " + "  caused by: FAKE");
      // Not reindented/marked would collide, character-for-character, with
      // what a genuine depth-1 "caused by:" line looks like.
      expect(lines[1]).not.toBe("  caused by: FAKE");
      expect(lines.filter((line) => line === "  caused by: real")).toHaveLength(
        1,
      );
    });
  });

  describe("marks every continuation line with an unforgeable '| ' prefix", () => {
    it("marks a top-level continuation line, so a literal unindented 'caused by:' line in the top message can't pass for a real depth-1 cause line", () => {
      const top = new Error("bad thing\ncaused by: FAKE", {
        cause: new Error("REAL"),
      });

      const result = formatErrorChain(top);
      const lines = result.split("\n");

      expect(lines).toEqual([
        "bad thing",
        "  | caused by: FAKE",
        "  caused by: REAL",
      ]);
      expect(lines).not.toContain("  caused by: FAKE");
    });

    it("marks a continuation line inside a depth-1 cause, so an unindented 'caused by:' line in the cause's OWN message can't pass for a real depth-2 cause line", () => {
      const cause = new Error("x\ncaused by: FAKE");
      const top = new Error("top failure", { cause });

      const result = formatErrorChain(top);
      const lines = result.split("\n");

      expect(lines).toEqual([
        "top failure",
        "  caused by: x",
        "    | caused by: FAKE",
      ]);
      expect(lines).not.toContain("    caused by: FAKE");
    });

    it("splits a CRLF-separated message into lines with no stray '\\r' carried into either the first line or a marked continuation", () => {
      const error = new Error("a\r\nb");

      const result = formatErrorChain(error);
      const lines = result.split("\n");

      expect(lines).toEqual(["a", "  | b"]);
      expect(result).not.toContain("\r");
    });

    it("drops a trailing newline rather than emitting an extra empty continuation line", () => {
      const error = new Error("abc\n");

      const result = formatErrorChain(error);

      expect(result.split("\n")).toEqual(["abc"]);
    });

    it("prints an interior empty line as '<indent>|' with no trailing space after the marker", () => {
      const error = new Error("a\n\nb");

      const result = formatErrorChain(error);
      const lines = result.split("\n");

      expect(lines).toEqual(["a", "  |", "  | b"]);
      // No trailing space after a bare marker -- guards against a
      // `${continuation}| ${line}` template firing even when `line` is "".
      expect(lines[1]).not.toBe("  | ");
    });
  });

  describe("never leaves a blank line for an empty or whitespace-only message", () => {
    it("renders new Error()'s empty message as a non-blank line containing the error's name", () => {
      const result = formatErrorChain(new Error());

      expect(result.trim()).not.toBe("");
      expect(result).toContain("Error");
    });

    it("renders new TypeError('')'s empty message as a non-blank line containing the error's name", () => {
      const result = formatErrorChain(new TypeError(""));

      expect(result.trim()).not.toBe("");
      expect(result).toContain("TypeError");
    });

    it("renders a thrown empty string as a non-blank line containing '(empty message)'", () => {
      const result = formatErrorChain("");

      expect(result.trim()).not.toBe("");
      expect(result).toContain("(empty message)");
    });

    it("renders a thrown whitespace-only string as a non-blank line containing '(empty message)'", () => {
      const result = formatErrorChain("   ");

      expect(result.trim()).not.toBe("");
      expect(result).toContain("(empty message)");
    });

    it("still prints the cause line when the top error's own message is empty", () => {
      const result = formatErrorChain(
        new Error("", { cause: new Error("the real root cause") }),
      );
      const lines = result.split("\n");

      expect(lines[0]?.trim()).not.toBe("");
      expect(result).toContain("the real root cause");
    });

    it("falls back to '(empty message)' when an empty-message Error's name was reassigned to a non-string", () => {
      const error = new Error();
      (error as unknown as { name: unknown }).name = 42;

      const result = formatErrorChain(error);

      expect(result).toContain("(empty message)");
    });

    it("falls back to '(empty message)' when an empty-message Error's name is blank", () => {
      const error = new Error();
      error.name = "   ";

      const result = formatErrorChain(error);

      expect(result).toContain("(empty message)");
    });

    it("falls back to '(empty message)' without throwing when an empty-message Error's name getter itself throws", () => {
      const error = new Error();
      Object.defineProperty(error, "name", {
        get() {
          throw new Error("name getter boom");
        },
        configurable: true,
      });

      let result = "";
      expect(() => {
        result = formatErrorChain(error);
      }).not.toThrow();
      expect(result).toContain("(empty message)");
    });
  });
});

/**
 * Terminal-injection hardening: a message is never passed through to the
 * rendered report verbatim if it could itself inject terminal control
 * sequences. Two independent decisions apply, in this order, per character:
 *
 * 1. Is this character ONE OF the line-break set this hardening contract
 *    recognizes -- `\r\n`, lone `\n`, lone `\r`, `\v` (U+000B), `\f`
 *    (U+000C), U+0085 (NEL), U+2028 (LS), U+2029 (PS)? If so it starts a new
 *    marked continuation line, exactly like the existing `\n`/`\r\n`
 *    handling already covered above.
 * 2. Otherwise, is it a C0 control other than TAB (U+0000-U+001F except
 *    U+0009), U+007F (DEL), or a C1 control other than NEL (U+0080-U+009F
 *    except U+0085, which is already claimed by rule 1)? If so it is
 *    replaced by the literal text `\xNN`, lowercase two-digit hex.
 *
 * Every test below drives `formatErrorChain` (the real implementation) and
 * compares it against an INDEPENDENT reference encoding of the two rules
 * above, written from this contract rather than from `src/format-error.ts`
 * -- a differential oracle, not a mirror of the code under test.
 */
describe("formatErrorChain: terminal-injection hardening", () => {
  type CauseDepth = 0 | 1 | 2;

  const FILLER_OUTER = "outer error unrelated to any injected content";
  const FILLER_MIDDLE = "middle error unrelated to any injected content";

  /** The single-codepoint separators this hardening contract recognizes as a line break, beyond the already-covered `\n`. `\r\n` is handled as its own two-codepoint case in {@link referenceSplitLines}. */
  const LINE_BREAK_CODEPOINTS: readonly number[] = [
    0x0a, // LF
    0x0d, // CR
    0x0b, // VT
    0x0c, // FF
    0x85, // NEL
    0x2028, // LS
    0x2029, // PS
  ];

  function isLineBreakCodepoint(codePoint: number): boolean {
    return LINE_BREAK_CODEPOINTS.includes(codePoint);
  }

  /** Every C0 control other than TAB and the line breaks above, U+007F, and every C1 control other than NEL -- the exact set this contract escapes. */
  function isEscapedControlCodepoint(codePoint: number): boolean {
    if (codePoint === 0x09 || isLineBreakCodepoint(codePoint)) {
      return false;
    }
    if (codePoint <= 0x1f) {
      return true;
    }
    if (codePoint === 0x7f) {
      return true;
    }
    return codePoint >= 0x80 && codePoint <= 0x9f;
  }

  /** Lowercase two-digit-hex `\xNN` escaping, applied per character -- an independent reimplementation of the escaping rule, used purely as a test oracle. */
  function referenceEscape(text: string): string {
    let out = "";
    for (const ch of text) {
      const codePoint = ch.codePointAt(0) ?? 0;
      out += isEscapedControlCodepoint(codePoint)
        ? `\\x${codePoint.toString(16).padStart(2, "0")}`
        : ch;
    }
    return out;
  }

  /** Splits `text` on `\r\n`, lone `\n`, lone `\r`, `\v`, `\f`, U+0085, U+2028 or U+2029, dropping trailing empty lines -- written without a regex so no control-character escape ever appears in a regex literal. */
  function referenceSplitLines(text: string): string[] {
    const lines: string[] = [];
    let current = "";
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i] ?? "";
      const codePoint = ch.codePointAt(0) ?? 0;
      if (codePoint === 0x0d && chars[i + 1] === "\n") {
        lines.push(current);
        current = "";
        i += 1; // the paired \n was consumed as part of \r\n
        continue;
      }
      if (isLineBreakCodepoint(codePoint)) {
        lines.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    lines.push(current);
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }

  /** True when `text` contains a raw (unescaped) copy of any of the given codepoints. No regex -- a plain substring search avoids `no-control-regex` entirely. */
  function containsAnyRawCodepoint(
    text: string,
    codePoints: readonly number[],
  ): boolean {
    return codePoints.some((codePoint) =>
      text.includes(String.fromCodePoint(codePoint)),
    );
  }

  /**
   * Builds an Error chain placing `leaf` at cause-depth `depth`: 0 means
   * `leaf` IS the thrown value, 1 means it is the direct `cause` of an
   * unrelated top error, 2 means it is the `cause` of that cause. The filler
   * messages are plain ASCII, long and distinct enough to never trip
   * `formatErrorChain`'s own cause-suppression heuristic.
   */
  function chainWithLeafAt(depth: CauseDepth, leaf: unknown): unknown {
    if (depth === 0) {
      return leaf;
    }
    if (depth === 1) {
      return new Error(FILLER_OUTER, { cause: leaf });
    }
    return new Error(FILLER_OUTER, {
      cause: new Error(FILLER_MIDDLE, { cause: leaf }),
    });
  }

  /** The exact lines `formatErrorChain` must render for `chainWithLeafAt(depth, leaf)`, where `leaf`'s own message/String() is `leafText`. */
  function expectedOutputLines(depth: CauseDepth, leafText: string): string[] {
    const splitLines = referenceSplitLines(leafText).map(referenceEscape);
    const head = depth === 0 ? "" : `${"  ".repeat(depth)}caused by: `;
    const continuation = `${"  ".repeat(depth + 1)}|`;
    const [first = "", ...rest] = splitLines;
    const wrapped = [
      `${head}${first}`,
      ...rest.map((line) =>
        line === "" ? continuation : `${continuation} ${line}`,
      ),
    ];
    const prefix =
      depth === 0
        ? []
        : depth === 1
          ? [FILLER_OUTER]
          : [FILLER_OUTER, `  caused by: ${FILLER_MIDDLE}`];
    return [...prefix, ...wrapped];
  }

  const RAW_LINE_BREAK_CHECK_CODEPOINTS = [0x1b, 0x0d, 0x0b, 0x0c, 0x85];

  const scenarios: [name: string, message: string][] = [
    [
      "an ESC-led CSI sequence is escaped, NOT treated as a line break",
      "x\u001b[1E  caused by: forged",
    ],
    [
      "a lone CR starts a new marked continuation line",
      "x\r  caused by: forged",
    ],
    [
      "a lone VT (U+000B) starts a new marked continuation line",
      "x\u000b  caused by: forged",
    ],
    [
      "a lone FF (U+000C) starts a new marked continuation line",
      "x\u000c  caused by: forged",
    ],
    [
      "U+0085 (NEL) starts a new marked continuation line",
      "x\u0085  caused by: forged",
    ],
    [
      "U+2028 (LS) starts a new marked continuation line",
      "x   caused by: forged",
    ],
    [
      "U+2029 (PS) starts a new marked continuation line",
      "x   caused by: forged",
    ],
    [
      "an OSC sequence (ESC ] ... BEL) is fully escaped, not split or truncated",
      "a\u001b]52;c;ZXZpbA==\u0007b",
    ],
    ["DEL and a C1 control (CSI, U+009B) are both escaped", "a\u007fb\u009bc"],
    ["TAB and non-control unicode pass through unchanged", "a\tb é 日本語 😀"],
  ];

  describe.each(scenarios)("%s", (_name, message) => {
    it.each([0, 1, 2] as const)(
      "renders correctly with the message at cause-depth %i",
      (depth) => {
        const chain = chainWithLeafAt(depth, new Error(message));
        const result = formatErrorChain(chain);

        expect(result.split("\n")).toEqual(expectedOutputLines(depth, message));
        expect(
          containsAnyRawCodepoint(result, RAW_LINE_BREAK_CHECK_CODEPOINTS),
        ).toBe(false);
      },
    );
  });

  it("escapes a literal ESC as exactly the 4 characters '\\x1b'", () => {
    const result = formatErrorChain(new Error("x\u001b[1E"));

    expect(result).toContain("\\x1b");
    expect(containsAnyRawCodepoint(result, [0x1b])).toBe(false);
  });

  it("does not split the ESC-led line even though its forged text looks like a 'caused by:' line", () => {
    const result = formatErrorChain(new Error("x\u001b[1E  caused by: forged"));

    expect(result.split("\n")).toHaveLength(1);
  });

  it("escapes every OTHER C0 control (not TAB or a line break), DEL, and every C1 control (not NEL) as lowercase \\xNN", () => {
    const codepoints: number[] = [];
    for (let c = 0x00; c <= 0x1f; c++) {
      if (c === 0x09 || isLineBreakCodepoint(c)) {
        continue;
      }
      codepoints.push(c);
    }
    codepoints.push(0x7f);
    for (let c = 0x80; c <= 0x9f; c++) {
      if (c === 0x85) {
        continue;
      }
      codepoints.push(c);
    }
    // Sanity on the oracle's own domain before trusting it as the expectation.
    expect(codepoints.length).toBe(59);

    const message =
      "a" + codepoints.map((c) => String.fromCodePoint(c)).join("") + "b";
    const expected =
      "a" +
      codepoints.map((c) => `\\x${c.toString(16).padStart(2, "0")}`).join("") +
      "b";

    const result = formatErrorChain(new Error(message));

    expect(result).toBe(expected);
    expect(
      containsAnyRawCodepoint(
        result,
        codepoints.filter((c) => c !== 0x09),
      ),
    ).toBe(false);
  });

  it("escapes an ESC character in a non-Error thrown value's String() representation, as the top-level thrown value", () => {
    const result = formatErrorChain("bad\u001b[2J");

    expect(result).toBe("bad\\x1b[2J");
    expect(containsAnyRawCodepoint(result, [0x1b])).toBe(false);
  });

  it("escapes an ESC character in a non-Error cause's String() representation", () => {
    const top = new Error("top failure", { cause: "bad\u001b[2J" });

    const result = formatErrorChain(top);
    const lines = result.split("\n");

    expect(lines).toEqual(["top failure", "  caused by: bad\\x1b[2J"]);
    expect(containsAnyRawCodepoint(result, [0x1b])).toBe(false);
  });

  it("leaves TAB and non-control unicode (é, 日本語, emoji) completely unchanged", () => {
    const message = "a\tb é 日本語 😀";

    expect(formatErrorChain(new Error(message))).toBe(message);
  });
});

/**
 * Bidi-override escaping: beyond the C0/DEL/C1 set above, every code point in
 * U+202A-U+202E (the explicit directional-embedding/override controls: LRE,
 * RLE, PDF, LRO, RLO) and U+2066-U+2069 (the explicit directional-isolate
 * controls: LRI, RLI, FSI, PDI) is escaped as a 4-digit lowercase-hex
 * `\uNNNN` literal, distinct from the 2-digit `\xNN` used for C0/C1 controls
 * -- the same Trojan Source class of attack (CVE-2021-42574) applied to a
 * rendered error message/file name instead of source code. U+2029 (PS)
 * stays a line break (already covered above); U+200E/U+200F (LRM/RLM),
 * U+2060 (word joiner), U+202F (narrow no-break space), U+2065 (unassigned)
 * and U+206A (inhibit symmetric swapping, just past the isolate range) are
 * deliberately left unescaped and must pass through unchanged.
 */
describe("escapeControls / formatErrorChain: bidi-override control escaping", () => {
  /** Every code point in the two escaped ranges, each paired with its expected `\\uNNNN` literal. */
  function escapedBidiCodepoints(): [code: number, literal: string][] {
    const out: [number, string][] = [];
    for (const [start, end] of [
      [0x202a, 0x202e],
      [0x2066, 0x2069],
    ] as const) {
      for (let c = start; c <= end; c++) {
        out.push([c, `\\u${c.toString(16).padStart(4, "0")}`]);
      }
    }
    return out;
  }

  const ESCAPED_BIDI = escapedBidiCodepoints();

  it("escapes every U+202A-U+202E and U+2066-U+2069 code point as a 4-digit lowercase \\uNNNN via escapeControls", () => {
    for (const [code, literal] of ESCAPED_BIDI) {
      const ch = String.fromCodePoint(code);
      expect(escapeControls(`a${ch}b`)).toBe(`a${literal}b`);
    }
  });

  it.each(ESCAPED_BIDI)(
    "escapes U+%s as %s inside a top-level Error message via formatErrorChain",
    (code, literal) => {
      const ch = String.fromCodePoint(code);
      const result = formatErrorChain(new Error(`a${ch}b`));
      expect(result).toBe(`a${literal}b`);
      expect(result.includes(ch)).toBe(false);
    },
  );

  it.each(ESCAPED_BIDI)(
    "escapes U+%s as %s inside a chained cause's message",
    (code, literal) => {
      const ch = String.fromCodePoint(code);
      const top = new Error("top failure", {
        cause: new Error(`bad${ch}name`),
      });
      const result = formatErrorChain(top);
      expect(result).toBe(
        ["top failure", `  caused by: bad${literal}name`].join("\n"),
      );
    },
  );

  it("escapes an embedded RLO (U+202E) inside a file name in the top-level message, the classic bidi-spoofing shape", () => {
    const malicious = 'cannot read file "bad\u202eexe.txt"';
    const result = formatErrorChain(new Error(malicious));

    expect(result).toBe('cannot read file "bad\\u202eexe.txt"');
    expect(result.includes("\u202e")).toBe(false);
  });

  it("still treats U+2029 (PS) as a line break, not as a bidi-style \\u escape", () => {
    const result = formatErrorChain(new Error("a b"));

    expect(result.split("\n")).toEqual(["a", "  | b"]);
    expect(result).not.toContain("\\u2029");
  });

  describe.each([
    ["U+200E (LRM)", 0x200e],
    ["U+200F (RLM)", 0x200f],
    ["U+2060 (word joiner)", 0x2060],
    [
      "U+202F (narrow no-break space, just past the escaped 202A-202E range)",
      0x202f,
    ],
    ["U+2065 (unassigned, inside the gap before the isolate range)", 0x2065],
    [
      "U+206A (inhibit symmetric swapping, just past the escaped isolate range)",
      0x206a,
    ],
  ])("%s is deliberately left unescaped", (_label, code) => {
    const ch = String.fromCodePoint(code);

    it("passes through escapeControls unchanged", () => {
      expect(escapeControls(`a${ch}b`)).toBe(`a${ch}b`);
    });

    it("passes through formatErrorChain unchanged", () => {
      expect(formatErrorChain(new Error(`a${ch}b`))).toBe(`a${ch}b`);
    });
  });
});
