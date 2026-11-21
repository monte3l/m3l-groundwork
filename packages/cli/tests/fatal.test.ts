// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `handleFatal` is `bin/m3l-groundwork.mjs`'s own top-level catch handler,
 * extracted so it can be unit-tested: it decides the process exit code
 * (2 for a usage error, 1 otherwise) and prints `formatErrorChain(error)`
 * via `io.print`, falling back up to three times on a channel the caller
 * can't make throw the same way (`io.printRaw`) -- first the same formatted
 * chain (so the cause chain survives even when `print` is what failed),
 * then the raw stack, then a fixed placeholder -- so a failure inside the
 * error-reporting path itself (a `print` that paints colour and can throw)
 * can never make the CLI crash uncaught or exit without a code. `print` is
 * called at most once. See `src/format-error.ts`.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { formatErrorChain } from "../src/format-error.js";
import { handleFatal } from "../src/fatal.js";

interface FatalIo {
  setExitCode(code: number): void;
  print(text: string): void;
  printRaw(text: string): void;
}

/** A simple io double recording every `print`/`printRaw` call, with an exit-code getter. */
function makeIo(): {
  io: FatalIo;
  prints: string[];
  rawPrints: string[];
  getExitCode: () => number | undefined;
} {
  const prints: string[] = [];
  const rawPrints: string[] = [];
  let exitCode: number | undefined;
  return {
    io: {
      setExitCode: (code: number) => {
        exitCode = code;
      },
      print: (text: string) => {
        prints.push(text);
      },
      printRaw: (text: string) => {
        rawPrints.push(text);
      },
    },
    prints,
    rawPrints,
    getExitCode: () => exitCode,
  };
}

describe("handleFatal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("types as documented: (error, io, isUsageError, debug?) => void, with io carrying print AND printRaw", () => {
    expectTypeOf(handleFatal).toEqualTypeOf<
      (
        error: unknown,
        io: {
          setExitCode(code: number): void;
          print(text: string): void;
          printRaw(text: string): void;
        },
        isUsageError: (error: unknown) => boolean,
        debug?: boolean,
      ) => void
    >();
  });

  it("sets exit code 2 and prints the real formatErrorChain output via print when isUsageError returns true", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("bad arguments");

    handleFatal(error, io, () => true);

    expect(getExitCode()).toBe(2);
    expect(prints).toEqual([formatErrorChain(error)]);
  });

  it("sets exit code 1 and prints the real formatErrorChain output via print when isUsageError returns false", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("boom", { cause: new Error("root cause") });

    handleFatal(error, io, () => false);

    expect(getExitCode()).toBe(1);
    expect(prints).toEqual([formatErrorChain(error)]);
  });

  it("sets exit code 1 when isUsageError itself throws, and still prints the formatted chain via print", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("boom");

    expect(() => {
      handleFatal(error, io, () => {
        throw new Error("classifier boom");
      });
    }).not.toThrow();

    expect(getExitCode()).toBe(1);
    expect(prints).toEqual([formatErrorChain(error)]);
  });

  it("sets the exit code before printing anything, on print or printRaw", () => {
    const calls: string[] = [];
    const io: FatalIo = {
      setExitCode: (code) => {
        calls.push(`setExitCode:${String(code)}`);
      },
      print: (text) => {
        calls.push(`print:${String(text.length)}`);
      },
      printRaw: (text) => {
        calls.push(`printRaw:${String(text.length)}`);
      },
    };

    handleFatal(new Error("x"), io, () => false);

    expect(calls[0]).toBe("setExitCode:1");
    const firstPrintIndex = calls.findIndex((c) => c.startsWith("print"));
    expect(firstPrintIndex).toBeGreaterThan(0);
  });

  it("falls back to printRaw(formatErrorChain(error)) -- never print again -- when the primary print throws, preserving the full cause chain", () => {
    const error = new Error("boom with stack", {
      cause: new Error("root cause"),
    });
    let printCallCount = 0;
    const rawPrints: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawPrints.push(text);
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawPrints).toEqual([formatErrorChain(error)]);
    // The cause chain survives onto the raw channel -- not just the top
    // message, which `String(error.stack ?? error)` alone would carry.
    expect(rawPrints[0]).toContain("boom with stack");
    expect(rawPrints[0]).toContain("root cause");
  });

  it("falls back to printRaw(String(error.stack ?? error)) when BOTH print and the first printRaw(formatErrorChain) attempt throw", () => {
    const error = new Error("boom with stack");
    let printCallCount = 0;
    const rawAttempts: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawAttempts.push(text);
        if (rawAttempts.length === 1) {
          throw new Error("first printRaw boom");
        }
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawAttempts).toEqual([
      formatErrorChain(error),
      String(error.stack ?? error),
    ]);
  });

  it("falls back to String(error) (no .stack) via printRaw when the thrown value isn't an Error and the primary print throws", () => {
    const rawPrints: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawPrints.push(text);
      },
    };

    handleFatal("a raw string failure", io, () => false);

    expect(rawPrints).toEqual(["a raw string failure"]);
  });

  it("falls back to rawText's non-object arm -- String(value) -- when the thrown value isn't an object and BOTH print and the first printRaw(formatErrorChain) attempt throw", () => {
    const value = "a raw string failure";
    let printCallCount = 0;
    const rawAttempts: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawAttempts.push(text);
        if (rawAttempts.length === 1) {
          throw new Error("first printRaw boom");
        }
      },
    };

    expect(() => {
      handleFatal(value, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawAttempts).toEqual([formatErrorChain(value), String(value)]);
  });

  it("falls back to rawText's String(error) arm when an Error's own 'stack' was deleted, and BOTH print and the first printRaw(formatErrorChain) attempt throw", () => {
    const error = new Error("boom with no stack");
    delete error.stack;
    let printCallCount = 0;
    const rawAttempts: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawAttempts.push(text);
        if (rawAttempts.length === 1) {
          throw new Error("first printRaw boom");
        }
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawAttempts).toEqual([formatErrorChain(error), String(error)]);
  });

  it("attempts printRaw('[unprintable error]') when print AND both earlier printRaw attempts (formatErrorChain, then the raw stack) throw", () => {
    const error = new Error("boom");
    let printCallCount = 0;
    const rawAttempts: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawAttempts.push(text);
        if (rawAttempts.length <= 2) {
          throw new Error(
            `printRaw attempt ${String(rawAttempts.length)} boom`,
          );
        }
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawAttempts).toEqual([
      formatErrorChain(error),
      String(error.stack ?? error),
      "[unprintable error]",
    ]);
  });

  it("passes a non-blank report to io.print for an Error with an empty message", () => {
    const { io, prints } = makeIo();

    handleFatal(new Error(), io, () => false);

    expect(prints).toHaveLength(1);
    expect(prints[0]?.trim()).not.toBe("");
  });

  it("escapes a raw ESC character found in error.stack before it reaches the raw-stack printRaw fallback", () => {
    const error = new Error("boom with stack");
    error.stack =
      "Error: boom with stack\n    at somewhere\u001b[31m (colorized)\u001b[0m";
    let printCallCount = 0;
    const rawAttempts: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawAttempts.push(text);
        if (rawAttempts.length === 1) {
          throw new Error("first printRaw boom");
        }
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawAttempts).toHaveLength(2);
    const fallbackText = rawAttempts[1] ?? "";
    expect(fallbackText).toContain("\\x1b");
    expect(fallbackText.includes("\u001b")).toBe(false);
  });

  it("escapes a raw ESC character found in String(error) (no stack) before it reaches the raw-stack printRaw fallback", () => {
    const error = new Error(
      "boom with \u001b[31mcolor\u001b[0m in the message",
    );
    delete error.stack;
    let printCallCount = 0;
    const rawAttempts: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        printCallCount += 1;
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawAttempts.push(text);
        if (rawAttempts.length === 1) {
          throw new Error("first printRaw boom");
        }
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(printCallCount).toBe(1);
    expect(rawAttempts).toHaveLength(2);
    const fallbackText = rawAttempts[1] ?? "";
    expect(fallbackText).toContain("\\x1b");
    expect(fallbackText.includes("\u001b")).toBe(false);
  });

  it("never throws even when print and printRaw both always throw, and the exit code was still set beforehand", () => {
    let exitCode: number | undefined;
    const io: FatalIo = {
      setExitCode: (code) => {
        exitCode = code;
      },
      print: () => {
        throw new Error("print always throws");
      },
      printRaw: () => {
        throw new Error("printRaw always throws");
      },
    };

    expect(() => {
      handleFatal(new Error("boom"), io, () => true);
    }).not.toThrow();

    expect(exitCode).toBe(2);
  });
});

/**
 * `handleFatal`'s top line gets a `${name}: ` prefix for a non-usage `Error`
 * whose `name` is a readable, non-blank string -- `TypeError:
 * Cannot read properties of null`, matching what Node itself prints for an
 * uncaught error, rather than the bare message `formatErrorChain` alone
 * would render. A usage error's output, and any `caused by:` line, are
 * untouched by this.
 */
describe("handleFatal: name-prefixed top line for a non-usage Error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes the top line with '<name>: ' for a non-usage TypeError", () => {
    const { io, prints } = makeIo();
    const error = new TypeError("Cannot read properties of null");

    handleFatal(error, io, () => false);

    expect(prints[0]).toBe("TypeError: Cannot read properties of null");
  });

  it("does not prefix when the top message is blank -- the name is already the whole line, so it must not become 'TypeError: TypeError'", () => {
    const { io, prints } = makeIo();

    handleFatal(new TypeError(""), io, () => false);

    expect(prints[0]).toBe("TypeError");
  });

  it("does not prefix a non-Error thrown value", () => {
    const { io, prints } = makeIo();

    handleFatal("a raw string failure", io, () => false);

    expect(prints[0]).toBe("a raw string failure");
  });

  it("never prefixes a usage error: output is byte-for-byte formatErrorChain's text, exit code 2", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new TypeError("bad arguments");

    handleFatal(error, io, () => true);

    expect(getExitCode()).toBe(2);
    expect(prints).toEqual([formatErrorChain(error)]);
  });

  it("control-escapes the name itself the same way a message is escaped", () => {
    const { io, prints } = makeIo();
    const error = new Error("boom");
    error.name = "Bad\u001bName";

    handleFatal(error, io, () => false);

    expect(prints[0]).toBe("Bad\\x1bName: boom");
  });

  it("does not throw, and still reports, when the name getter itself throws", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("boom");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("name getter boom");
      },
      configurable: true,
    });

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(getExitCode()).toBe(1);
    expect(prints[0]).toBeTruthy();
  });

  it("does not throw when the classifier itself throws (counts as non-usage), and still name-prefixes the report", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new TypeError("boom");

    expect(() => {
      handleFatal(error, io, () => {
        throw new Error("classifier boom");
      });
    }).not.toThrow();

    expect(getExitCode()).toBe(1);
    expect(prints[0]).toBe("TypeError: boom");
  });

  it("never prefixes a 'caused by:' line with the top error's name", () => {
    const { io, prints } = makeIo();
    const error = new TypeError("top failure", {
      cause: new Error("root cause"),
    });

    handleFatal(error, io, () => false);

    expect(prints[0]).toBe(
      ["TypeError: top failure", "  caused by: root cause"].join("\n"),
    );
  });
});

/**
 * `handleFatal`'s optional 4th `debug` parameter (default `false`) appends
 * the top error's own `stack` after the rendered chain, escaped and line-
 * normalized the same way `formatErrorChain` escapes a message, and capped
 * so a pathologically deep stack can't flood stderr. It never applies to a
 * usage error (a bad invocation has no useful stack to show), and it never
 * duplicates the message a V8 stack's own leading `Name: message` header
 * line already carries -- only the `    at ` frames are appended.
 */
describe("handleFatal: debug stack trace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not print the stack when debug is false (the default, no 4th argument)", () => {
    const { io, prints } = makeIo();
    const error = new Error("boom");
    error.stack = "Error: boom\n    at frameOne\n    at frameTwo";

    handleFatal(error, io, () => false);

    expect(prints[0]).toBe(formatErrorChain(error));
    expect(prints[0]).not.toContain("frameOne");
  });

  it("does not print the stack when debug is explicitly false", () => {
    const { io, prints } = makeIo();
    const error = new Error("boom");
    error.stack = "Error: boom\n    at frameOne";

    handleFatal(error, io, () => false, false);

    expect(prints[0]).toBe(formatErrorChain(error));
  });

  it("appends the stack's frames after the chain when debug is true and the error is not a usage error", () => {
    const { io, prints } = makeIo();
    const error = new Error("boom with stack");
    error.stack = "Error: boom with stack\n    at frameOne\n    at frameTwo";

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    expect(text.startsWith(formatErrorChain(error))).toBe(true);
    expect(text).toContain("    at frameOne");
    expect(text.endsWith("    at frameTwo")).toBe(true);
  });

  it("does not duplicate the message when the stack's own 'Name: message' header line echoes it -- only the frames are appended", () => {
    const error = new Error("Cannot read properties of null");
    error.stack = [
      "Error: Cannot read properties of null",
      "    at frameOne",
      "    at frameTwo",
    ].join("\n");
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    const occurrences = text.split("Cannot read properties of null").length - 1;
    expect(occurrences).toBe(1);
    expect(text).toContain("    at frameOne");
    expect(text.endsWith("    at frameTwo")).toBe(true);
  });

  it("does not reappear a message line that itself looks like a stack frame as part of the appended frames -- the header is stripped by position, not by re-matching 'at '", () => {
    const error = new TypeError("failed\n  at step 3\nmore");
    error.stack = `${error.name}: ${error.message}\n    at fn (file.js:1:1)\n    at other (file.js:2:2)`;
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    const occurrences = text.split("at step 3").length - 1;
    expect(occurrences).toBe(1);
    expect(text).toContain("    at fn (file.js:1:1)");
    expect(text).toContain("    at other (file.js:2:2)");
  });

  it("never prints a stack for a usage error, even with debug true", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("bad arguments");
    error.stack = "Error: bad arguments\n    at frameOne";

    handleFatal(error, io, () => true, true);

    expect(getExitCode()).toBe(2);
    expect(prints).toEqual([formatErrorChain(error)]);
    expect(prints[0]).not.toContain("frameOne");
  });

  it("truncates a 200-frame stack to at most 51 printed stack lines, keeping the earliest frames", () => {
    const error = new Error("boom");
    const frames = Array.from(
      { length: 200 },
      (_unused, i) => `    at frame${String(i)}`,
    );
    error.stack = ["Error: boom", ...frames].join("\n");
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    const chainText = formatErrorChain(error);
    const stackPortion = text.slice(chainText.length);
    const stackLines = stackPortion.split("\n").filter((line) => line !== "");

    expect(stackLines.length).toBeLessThanOrEqual(51);
    expect(stackPortion).toContain("frame0");
    expect(stackPortion).toContain("frame1");
    expect(stackPortion).toMatch(/\.\.\. and \d+ more/);
  });

  it("escapes a control character found in the stack the same way a message is escaped", () => {
    const error = new Error("boom");
    error.stack =
      "Error: boom\n    at somewhere\u001b[31m (colorized)\u001b[0m";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    expect(text).toContain("\\x1b");
    expect(text.includes("\u001b")).toBe(false);
  });

  it("appends nothing, without throwing, when the stack is missing", () => {
    const error = new Error("boom");
    delete error.stack;
    const { io, prints } = makeIo();

    expect(() => {
      handleFatal(error, io, () => false, true);
    }).not.toThrow();

    expect(prints[0]).toBe(formatErrorChain(error));
  });

  it("appends nothing, without throwing, when the stack was reassigned to a non-string", () => {
    const error = new Error("boom");
    (error as unknown as { stack: unknown }).stack = 42;
    const { io, prints } = makeIo();

    expect(() => {
      handleFatal(error, io, () => false, true);
    }).not.toThrow();

    expect(prints[0]).toBe(formatErrorChain(error));
  });

  it("does not throw when the stack getter itself throws", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack getter boom");
      },
      configurable: true,
    });
    const { io, prints, getExitCode } = makeIo();

    expect(() => {
      handleFatal(error, io, () => false, true);
    }).not.toThrow();

    expect(getExitCode()).toBe(1);
    expect(prints[0]).toBeTruthy();
  });

  it("carries the same name-prefixed, stack-appended text to the printRaw fallback when print throws", () => {
    const error = new Error("boom with stack");
    error.stack = "Error: boom with stack\n    at frameOne";
    const rawPrints: string[] = [];
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: () => {
        throw new Error("primary print boom");
      },
      printRaw: (text) => {
        rawPrints.push(text);
      },
    };

    handleFatal(error, io, () => false, true);

    expect(rawPrints).toHaveLength(1);
    expect(rawPrints[0]).toContain("at frameOne");
    expect(rawPrints[0]).toContain("boom with stack");
  });
});

/**
 * `withoutHeader` (`src/format-error.ts`) drops V8's `Name: message` header
 * from a `stack` by position: when the stack starts with exactly the lines
 * `stackHeader(error)` computes, those leading lines are dropped; otherwise
 * it falls back to dropping every line before the first `    at ` frame
 * line, or keeps the stack whole when there is no frame line either.
 * `stackHeader` itself returns `undefined` -- forcing the frame-line
 * fallback -- whenever `name` or `message` cannot be read as a string.
 */
describe("handleFatal: debug stack trace -- header/frame-fallback edge cases", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops only the lines before the first '    at ' frame when the stack's leading line does not match the computed 'Name: message' header", () => {
    const error = new Error("boom");
    error.stack =
      "Weird header line that doesn't match\n    at frameOne\n    at frameTwo";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    expect(text).not.toContain("Weird header line");
    expect(text).toContain("    at frameOne");
    expect(text).toContain("    at frameTwo");
  });

  it("keeps the whole stack when it neither starts with the computed header nor contains any '    at ' frame line", () => {
    const error = new Error("boom");
    error.stack =
      "Completely custom stack with no frames at all\nsecond custom line";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    expect(text).toContain("Completely custom stack with no frames at all");
    expect(text).toContain("second custom line");
  });

  it("falls back to the frame-line cutoff (stackHeader unreadable) when the name getter itself throws, with no frame line to find either -- the stack is kept whole", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("name getter boom");
      },
      configurable: true,
    });
    error.stack = "Error: boom\nsecond custom line";
    const { io, prints, getExitCode } = makeIo();

    expect(() => {
      handleFatal(error, io, () => false, true);
    }).not.toThrow();

    expect(getExitCode()).toBe(1);
    const text = prints[0] ?? "";
    // stackHeader could not be computed (name getter throws), so the
    // position-based header match never fires; with no frame line either,
    // the stack is kept whole -- "Error: boom" survives as its own line.
    expect(text).toContain("Error: boom\nsecond custom line");
  });

  it("falls back to the frame-line cutoff (stackHeader unreadable) when the message getter itself throws, with no frame line to find either -- the stack is kept whole", () => {
    const error = new Error("original message");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("message getter boom");
      },
      configurable: true,
    });
    error.stack = "SomeCustomStackText\nAnotherLine";
    const { io, prints, getExitCode } = makeIo();

    expect(() => {
      handleFatal(error, io, () => false, true);
    }).not.toThrow();

    expect(getExitCode()).toBe(1);
    const text = prints[0] ?? "";
    expect(text).toContain("SomeCustomStackText\nAnotherLine");
  });

  it("computes the header as 'Error: <message>' (falls back to the generic name) when 'name' was reassigned to undefined", () => {
    const error = new Error("boom");
    (error as unknown as { name: unknown }).name = undefined;
    error.stack = "Error: boom\n    at frameOne";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    // The header ("Error: boom") was matched and stripped by position, so
    // it appears exactly once -- as the chain's own top line -- not a
    // second time as a leftover stack line.
    expect(text.split("Error: boom")).toHaveLength(1);
    expect(text).toContain("    at frameOne");
  });

  it("computes the header as just the name (no ': message') when 'message' was reassigned to undefined", () => {
    const error = new Error("boom");
    (error as unknown as { message: unknown }).message = undefined;
    error.stack = "Error\n    at frameOne";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    const lines = text.split("\n");
    // The bare "Error" header line was matched and stripped by position: it
    // never appears as its own standalone stack line.
    expect(lines).not.toContain("Error");
    expect(text).toContain("    at frameOne");
  });

  it("treats a non-string 'name' as unreadable, forcing the frame-line fallback -- the stack is kept whole when there is no frame line", () => {
    const error = new Error("boom");
    (error as unknown as { name: unknown }).name = 123;
    error.stack = "123: boom\nSecondLine";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    // stackHeader returns undefined for a non-string name, so the
    // position-based match never fires and (with no frame line) the whole
    // stack, including its literal leading line, survives.
    expect(text).toContain("123: boom\nSecondLine");
  });

  it("treats a non-string 'message' as unreadable, forcing the frame-line fallback -- the stack is kept whole when there is no frame line", () => {
    const error = new Error("boom");
    (error as unknown as { message: unknown }).message = 456;
    error.stack = "456: Error\nSecondLine";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    expect(text).toContain("456: Error\nSecondLine");
  });

  it("computes the header as the bare message (ignoring name entirely) when 'name' is the empty string", () => {
    const error = new Error("boom");
    error.name = "";
    error.stack = "boom\n    at frameOne";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    // "boom" is the computed header (name === ""), matched and stripped by
    // position -- it appears exactly once, as the chain's own top line, not
    // duplicated as a leftover stack line.
    expect(text.split("boom")).toHaveLength(2);
    expect(text).toContain("    at frameOne");
  });

  it("drops trailing empty stack lines rather than printing blank continuation lines", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at frameOne\n\n\n";
    const { io, prints } = makeIo();

    handleFatal(error, io, () => false, true);

    const text = prints[0] ?? "";
    expect(text.endsWith("    at frameOne")).toBe(true);
    expect(text.split("\n").at(-1)).toBe("    at frameOne");
  });

  it("prints no stack at all when the thrown value is not an Error, even with debug true", () => {
    const { io, prints } = makeIo();

    handleFatal("a raw string failure", io, () => false, true);

    expect(prints).toEqual([formatErrorChain("a raw string failure")]);
    expect(prints[0]).not.toContain("    at ");
  });
});
