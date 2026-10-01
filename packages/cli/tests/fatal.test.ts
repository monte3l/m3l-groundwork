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

  it("types as documented: (error, io, isUsageError) => void, with io carrying print AND printRaw", () => {
    expectTypeOf(handleFatal).toEqualTypeOf<
      (
        error: unknown,
        io: {
          setExitCode(code: number): void;
          print(text: string): void;
          printRaw(text: string): void;
        },
        isUsageError: (error: unknown) => boolean,
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
