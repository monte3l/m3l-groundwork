// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `handleFatal` is `bin/m3l-groundwork.mjs`'s own top-level catch handler,
 * extracted so it can be unit-tested: it decides the process exit code
 * (2 for a usage error, 1 otherwise) and prints `formatErrorChain(error)`,
 * falling back twice -- to the raw stack, then to a fixed placeholder --
 * so a failure inside the error-reporting path itself can never make the
 * CLI crash uncaught or exit without a code. See `src/format-error.ts`.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { formatErrorChain } from "../src/format-error.js";
import { handleFatal } from "../src/fatal.js";

interface FatalIo {
  setExitCode(code: number): void;
  print(text: string): void;
}

/** A simple io double recording every `print` call, with an exit-code getter. */
function makeIo(): {
  io: FatalIo;
  prints: string[];
  getExitCode: () => number | undefined;
} {
  const prints: string[] = [];
  let exitCode: number | undefined;
  return {
    io: {
      setExitCode: (code: number) => {
        exitCode = code;
      },
      print: (text: string) => {
        prints.push(text);
      },
    },
    prints,
    getExitCode: () => exitCode,
  };
}

describe("handleFatal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("types as documented: (error, io, isUsageError) => void", () => {
    expectTypeOf(handleFatal).toEqualTypeOf<
      (
        error: unknown,
        io: { setExitCode(code: number): void; print(text: string): void },
        isUsageError: (error: unknown) => boolean,
      ) => void
    >();
  });

  it("sets exit code 2 and prints the real formatErrorChain output when isUsageError returns true", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("bad arguments");

    handleFatal(error, io, () => true);

    expect(getExitCode()).toBe(2);
    expect(prints).toEqual([formatErrorChain(error)]);
  });

  it("sets exit code 1 and prints the real formatErrorChain output when isUsageError returns false", () => {
    const { io, prints, getExitCode } = makeIo();
    const error = new Error("boom", { cause: new Error("root cause") });

    handleFatal(error, io, () => false);

    expect(getExitCode()).toBe(1);
    expect(prints).toEqual([formatErrorChain(error)]);
  });

  it("sets exit code 1 when isUsageError itself throws, and still prints the formatted chain", () => {
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

  it("sets the exit code before printing anything", () => {
    const calls: string[] = [];
    const io: FatalIo = {
      setExitCode: (code) => {
        calls.push(`setExitCode:${String(code)}`);
      },
      print: (text) => {
        calls.push(`print:${String(text.length)}`);
      },
    };

    handleFatal(new Error("x"), io, () => false);

    expect(calls[0]).toBe("setExitCode:1");
    const firstPrintIndex = calls.findIndex((c) => c.startsWith("print"));
    expect(firstPrintIndex).toBeGreaterThan(0);
  });

  it("never throws, and falls back to the error's own stack when the primary print throws", () => {
    const calls: string[] = [];
    let attempt = 0;
    const error = new Error("boom with stack");
    const io: FatalIo = {
      setExitCode: (code) => {
        calls.push(`setExitCode:${String(code)}`);
      },
      print: (text) => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("primary print boom");
        }
        calls.push(text);
      },
    };

    expect(() => {
      handleFatal(error, io, () => false);
    }).not.toThrow();

    expect(calls).toContain(String(error.stack ?? error));
  });

  it("falls back to String(error) (no .stack) when the thrown value isn't an Error and the primary print throws", () => {
    const printed: string[] = [];
    let attempt = 0;
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: (text) => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("primary print boom");
        }
        printed.push(text);
      },
    };

    handleFatal("a raw string failure", io, () => false);

    expect(printed).toEqual(["a raw string failure"]);
  });

  it("prints '[unprintable error]' as the last resort when both the primary print and the stack-based fallback print throw", () => {
    const printed: string[] = [];
    let attempt = 0;
    const io: FatalIo = {
      setExitCode: () => {
        // not under test here
      },
      print: (text) => {
        attempt += 1;
        if (attempt < 3) {
          throw new Error(`print boom ${String(attempt)}`);
        }
        printed.push(text);
      },
    };

    handleFatal(new Error("boom"), io, () => false);

    expect(printed).toEqual(["[unprintable error]"]);
  });

  it("never throws even when every print call throws, and the exit code was still set beforehand", () => {
    let exitCode: number | undefined;
    const io: FatalIo = {
      setExitCode: (code) => {
        exitCode = code;
      },
      print: () => {
        throw new Error("print always throws");
      },
    };

    expect(() => {
      handleFatal(new Error("boom"), io, () => true);
    }).not.toThrow();

    expect(exitCode).toBe(2);
  });
});
