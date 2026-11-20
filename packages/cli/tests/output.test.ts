// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `createOut` routes the CLI's status lines: human mode writes each line to
 * the same stream, with the same trailing newline, as console.log /
 * console.error would (info and success to stdout, warn to stderr); json mode
 * keeps stdout clean by sending everything to stderr. Colour decisions reuse term.ts's `paint`.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createOut, type Out } from "../src/output.js";
import { paint } from "../src/term.js";

interface FakeStream {
  isTTY: boolean;
  write: ReturnType<typeof vi.fn>;
}

function fakeStream(isTTY: boolean): FakeStream {
  return { isTTY, write: vi.fn(() => true) };
}

function asStream(stream: FakeStream): NodeJS.WriteStream {
  return stream as unknown as NodeJS.WriteStream;
}

function written(stream: FakeStream): string {
  return stream.write.mock.calls.map((call) => String(call[0])).join("");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Out type", () => {
  it("exposes info, warn and success taking a string", () => {
    expectTypeOf<Out>().toHaveProperty("info");
    expectTypeOf<Out["info"]>().toEqualTypeOf<(msg: string) => void>();
    expectTypeOf<Out["warn"]>().toEqualTypeOf<(msg: string) => void>();
    expectTypeOf<Out["success"]>().toEqualTypeOf<(msg: string) => void>();
  });
});

describe("createOut (human mode)", () => {
  it("writes info to console.log and nothing to console.error", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    createOut({ json: false }).info("hello");

    expect(log).toHaveBeenCalledExactlyOnceWith("hello");
    expect(error).not.toHaveBeenCalled();
  });

  it("writes success to console.log, painted with the success role", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("FORCE_COLOR", undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createOut({ json: false }).success("done");

    // NO_COLOR forces plain text, identical to paint() under the same env.
    expect(log).toHaveBeenCalledExactlyOnceWith(
      paint(process.stdout, "success", "done"),
    );
  });

  it("writes success in colour to console.log when FORCE_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createOut({ json: false }).success("done");

    const call = log.mock.calls[0]?.[0] as string;
    expect(call).toBe(paint(process.stdout, "success", "done"));
    expect(call).toContain("\u001b[");
    expect(call).toContain("done");
  });

  it("writes warn to console.error (stderr), not console.log", () => {
    vi.stubEnv("NO_COLOR", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    createOut({ json: false }).warn("careful");

    expect(error).toHaveBeenCalledExactlyOnceWith("careful");
    expect(log).not.toHaveBeenCalled();
  });

  it("paints warn with the warning role using the stderr stream's colour support", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    const stdout = fakeStream(false);
    const stderr = fakeStream(true);

    createOut({
      json: false,
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }).warn("careful");

    expect(written(stderr)).toBe(`${paint(stderr, "warning", "careful")}\n`);
    expect(written(stderr)).toContain("\u001b[");
    expect(written(stdout)).toBe("");
  });

  it("writes to injected streams, newline-terminated, when given", () => {
    vi.stubEnv("NO_COLOR", "1");
    const stdout = fakeStream(true);
    const stderr = fakeStream(true);
    const out = createOut({
      json: false,
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    });

    out.info("a");
    out.success("b");
    out.warn("c");

    expect(written(stdout)).toBe("a\nb\n");
    expect(written(stderr)).toBe("c\n");
  });
});

describe("createOut (json mode)", () => {
  it("writes nothing to stdout or the console for info, success and warn", () => {
    vi.stubEnv("NO_COLOR", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = fakeStream(true);
    const stderr = fakeStream(true);
    const out = createOut({
      json: true,
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    });

    out.info("a");
    out.success("b");
    out.warn("c");

    expect(written(stdout)).toBe("");
    expect(log).not.toHaveBeenCalled();
    expect(written(stderr)).toBe("a\nb\nc\n");
  });

  it("paints success and warn using the stderr stream's colour support, not stdout's", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    const stdout = fakeStream(true);
    const colourStderr = fakeStream(true);
    createOut({
      json: true,
      stdout: asStream(stdout),
      stderr: asStream(colourStderr),
    }).success("ok");
    expect(written(colourStderr)).toBe(
      `${paint(colourStderr, "success", "ok")}\n`,
    );
    expect(written(colourStderr)).toContain("\u001b[");

    const plainStderr = fakeStream(false);
    const out = createOut({
      json: true,
      stdout: asStream(stdout),
      stderr: asStream(plainStderr),
    });
    out.success("ok");
    out.warn("hmm");
    expect(written(plainStderr)).toBe("ok\nhmm\n");
  });

  it("routes every line through console.error when no stderr is injected, never process.stderr.write", () => {
    vi.stubEnv("NO_COLOR", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const out = createOut({ json: true });

    out.info("a");
    out.success("b");
    out.warn("c");
    out.notice("d");

    expect(consoleError.mock.calls).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("honours NO_COLOR over a TTY stderr", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);
    const stderr = fakeStream(true);

    createOut({ json: true, stderr: asStream(stderr) }).warn("x");

    expect(written(stderr)).toBe("x\n");
  });

  it("honours FORCE_COLOR over a non-TTY stderr", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const stderr = fakeStream(false);

    createOut({ json: true, stderr: asStream(stderr) }).warn("x");

    expect(written(stderr)).toContain("\u001b[");
    expect(written(stderr)).toContain("x");
  });
});

describe("Out.notice (the warning-painted line)", () => {
  it("is part of the Out type", () => {
    expectTypeOf<Out["notice"]>().toEqualTypeOf<(msg: string) => void>();
  });

  it("human mode: console.log of the stdout-painted warning line, bytes identical to today", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    createOut({ json: false }).notice("over cap");

    expect(log).toHaveBeenCalledExactlyOnceWith(
      paint(process.stdout, "warning", "over cap"),
    );
    expect(log.mock.calls[0]?.[0]).toContain("\u001b[");
    expect(error).not.toHaveBeenCalled();
  });

  it("human mode: writes to an injected stdout, painted for stdout's colour support, never stderr", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    const stdout = fakeStream(true);
    const stderr = fakeStream(false);

    createOut({
      json: false,
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }).notice("n");

    expect(written(stdout)).toBe(`${paint(stdout, "warning", "n")}\n`);
    expect(written(stdout)).toContain("\u001b[");
    expect(written(stderr)).toBe("");
  });

  it("json mode: goes to stderr painted for stderr's colour support, nothing to stdout or console.log", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = fakeStream(true);
    const stderr = fakeStream(false);

    createOut({
      json: true,
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }).notice("n");

    expect(written(stderr)).toBe("n\n");
    expect(written(stdout)).toBe("");
    expect(log).not.toHaveBeenCalled();

    const colourStderr = fakeStream(true);
    createOut({
      json: true,
      stdout: asStream(fakeStream(false)),
      stderr: asStream(colourStderr),
    }).notice("n");
    expect(written(colourStderr)).toBe(
      `${paint(colourStderr, "warning", "n")}\n`,
    );
    expect(written(colourStderr)).toContain("\u001b[");
  });
});
