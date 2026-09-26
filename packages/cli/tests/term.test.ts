// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers packages/cli/src/term.ts -- a zero-dependency terminal-color
 * helper layered over the generated palette.ts. Pure functions throughout
 * (no I/O), so these are plain example-based unit tests: color-support
 * detection (NO_COLOR/FORCE_COLOR precedence), hex-to-SGR conversion (both
 * truecolor and nearest-16 quantization), theme resolution from
 * COLORFGBG, and the paint() orchestration that ties them together.
 */
import { describe, expect, it } from "vitest";
import { PALETTE } from "../src/palette.js";
import {
  nearest16Sgr,
  paint,
  type PaletteRole,
  resolveThemeId,
  supportsColor,
  truecolorSgr,
} from "../src/term.js";

const ALL_ROLES: PaletteRole[] = [
  "success",
  "info",
  "warning",
  "danger",
  "accent",
  "secondary",
];

describe("supportsColor", () => {
  it("returns false when NO_COLOR is set, even to an empty string", () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
  });

  it("returns false when NO_COLOR is set to a non-empty value", () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  });

  it("NO_COLOR wins over FORCE_COLOR when both are set", () => {
    expect(
      supportsColor({ isTTY: false }, { NO_COLOR: "1", FORCE_COLOR: "1" }),
    ).toBe(false);
  });

  it("returns true when FORCE_COLOR is set to a non-'0' value, even on a non-TTY stream", () => {
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  });

  it("returns false when FORCE_COLOR is explicitly '0'", () => {
    expect(supportsColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(false);
  });

  it("falls back to stream.isTTY when neither NO_COLOR nor FORCE_COLOR is set", () => {
    expect(supportsColor({ isTTY: true }, {})).toBe(true);
    expect(supportsColor({ isTTY: false }, {})).toBe(false);
  });

  it("treats a missing isTTY (undefined) as not-a-TTY", () => {
    expect(supportsColor({}, {})).toBe(false);
  });
});

describe("truecolorSgr", () => {
  it("converts a #rrggbb hex string into a 24-bit SGR foreground escape", () => {
    expect(truecolorSgr("#086d31")).toBe("\x1b[38;2;8;109;49m");
  });

  it("converts black and white boundary values correctly", () => {
    expect(truecolorSgr("#000000")).toBe("\x1b[38;2;0;0;0m");
    expect(truecolorSgr("#ffffff")).toBe("\x1b[38;2;255;255;255m");
  });

  it.each([
    ["missing #", "086d31"],
    ["3-digit shorthand", "#0d3"],
    ["alpha suffix", "#086d31ff"],
    ["non-hex characters", "#zzzzzz"],
    ["wrong length", "#0000"],
    ["empty string", ""],
  ])("throws for a malformed hex string (%s)", (_label, value) => {
    expect(() => truecolorSgr(value)).toThrow(Error);
  });
});

describe("nearest16Sgr", () => {
  it.each([
    ["#000000", 30],
    ["#cd0000", 31],
    ["#00cd00", 32],
    ["#cdcd00", 33],
    ["#0000ee", 34],
    ["#cd00cd", 35],
    ["#00cdcd", 36],
    ["#e5e5e5", 37],
    ["#7f7f7f", 90],
    ["#ff0000", 91],
    ["#00ff00", 92],
    ["#ffff00", 93],
    ["#5c5cff", 94],
    ["#ff00ff", 95],
    ["#00ffff", 96],
    ["#ffffff", 97],
  ])("resolves an exact match %s to code %i", (hex, code) => {
    expect(nearest16Sgr(hex)).toBe(`\x1b[${String(code)}m`);
  });

  it("resolves a color much closer to black than white to a dark code (30 or 90)", () => {
    const sgr = nearest16Sgr("#050505");
    expect(sgr === "\x1b[30m" || sgr === "\x1b[90m").toBe(true);
  });

  it("resolves a color much closer to white than black to a light code (37 or 97)", () => {
    const sgr = nearest16Sgr("#fafafa");
    expect(sgr === "\x1b[37m" || sgr === "\x1b[97m").toBe(true);
  });

  it.each([
    ["missing #", "cd0000"],
    ["3-digit shorthand", "#f00"],
    ["alpha suffix", "#cd0000ff"],
    ["non-hex characters", "#gggggg"],
    ["wrong length", "#cd00"],
  ])("throws for a malformed hex string (%s)", (_label, value) => {
    expect(() => nearest16Sgr(value)).toThrow(Error);
  });
});

describe("resolveThemeId", () => {
  it.each([
    ["0;7", "light"],
    ["0;15", "light"],
    ["8;7", "light"],
    ["7;7", "light"],
  ])(
    "returns 'light' when COLORFGBG=%s (last segment is 15 or 7)",
    (colorfgbg, expected) => {
      expect(resolveThemeId({ COLORFGBG: colorfgbg })).toBe(expected);
    },
  );

  it.each([
    ["0;0", "dark"],
    ["15;8", "dark"],
    ["7;0", "dark"],
  ])(
    "returns 'dark' when COLORFGBG=%s (last segment is neither 15 nor 7)",
    (colorfgbg, expected) => {
      expect(resolveThemeId({ COLORFGBG: colorfgbg })).toBe(expected);
    },
  );

  it("returns 'dark' when COLORFGBG is absent", () => {
    expect(resolveThemeId({})).toBe("dark");
  });

  it("returns 'dark' when COLORFGBG is malformed (no separator)", () => {
    expect(resolveThemeId({ COLORFGBG: "garbage" })).toBe("dark");
  });

  it("returns 'dark' for an empty-string COLORFGBG", () => {
    expect(resolveThemeId({ COLORFGBG: "" })).toBe("dark");
  });
});

describe("paint", () => {
  it("returns the text unchanged when the stream is a TTY but NO_COLOR is set", () => {
    expect(paint({ isTTY: true }, "success", "hello", { NO_COLOR: "1" })).toBe(
      "hello",
    );
  });

  it("returns the text unchanged on a non-TTY stream with no color-forcing env", () => {
    expect(paint({ isTTY: false }, "success", "hello", {})).toBe("hello");
  });

  it("colors the text on a non-TTY stream when FORCE_COLOR is set", () => {
    const result = paint({ isTTY: false }, "success", "hello", {
      FORCE_COLOR: "1",
    });
    expect(result).not.toBe("hello");
    expect(result.startsWith("\x1b[")).toBe(true);
    expect(result.endsWith("\x1b[0m")).toBe(true);
    expect(result).toContain("hello");
  });

  it("uses a 24-bit truecolor escape when COLORTERM is 'truecolor'", () => {
    const result = paint({ isTTY: true }, "success", "hello", {
      COLORTERM: "truecolor",
    });
    expect(result.startsWith("\x1b[38;2;")).toBe(true);
  });

  it("uses a 24-bit truecolor escape when COLORTERM is '24bit'", () => {
    const result = paint({ isTTY: true }, "success", "hello", {
      COLORTERM: "24bit",
    });
    expect(result.startsWith("\x1b[38;2;")).toBe(true);
  });

  it.each([[undefined], ["256color"], ["indexed"]])(
    "uses a nearest-16 escape (not truecolor) when COLORTERM is %s",
    (colorterm) => {
      const env: NodeJS.ProcessEnv =
        colorterm === undefined ? {} : { COLORTERM: colorterm };
      const result = paint({ isTTY: true }, "success", "hello", env);
      expect(result.startsWith("\x1b[38;2;")).toBe(false);
      expect(result.startsWith("\x1b[3") || result.startsWith("\x1b[9")).toBe(
        true,
      );
    },
  );

  it("always terminates a colored result with the reset code", () => {
    const result = paint({ isTTY: true }, "danger", "x", {
      COLORTERM: "truecolor",
    });
    expect(result.endsWith("\x1b[0m")).toBe(true);
  });

  it("resolves the light-theme color from PALETTE when COLORFGBG indicates light", () => {
    const result = paint({ isTTY: true }, "success", "hello", {
      COLORTERM: "truecolor",
      COLORFGBG: "0;15",
    });
    expect(result).toBe(truecolorSgrForTest(PALETTE.light.success, "hello"));
  });

  it("resolves the dark-theme color from PALETTE when COLORFGBG indicates dark (or is absent)", () => {
    const result = paint({ isTTY: true }, "success", "hello", {
      COLORTERM: "truecolor",
    });
    expect(result).toBe(truecolorSgrForTest(PALETTE.dark.success, "hello"));
  });

  it.each(ALL_ROLES)(
    "paints role '%s' distinctly for both light and dark themes",
    (role) => {
      const light = paint({ isTTY: true }, role, "x", {
        COLORTERM: "truecolor",
        COLORFGBG: "0;15",
      });
      const dark = paint({ isTTY: true }, role, "x", {
        COLORTERM: "truecolor",
        COLORFGBG: "0;0",
      });
      expect(light).toBe(
        truecolorSgrForTest(paletteColorFor(role, "light"), "x"),
      );
      expect(dark).toBe(
        truecolorSgrForTest(paletteColorFor(role, "dark"), "x"),
      );
    },
  );

  it("defaults env to process.env when the 4th argument is omitted", () => {
    // The primary control surface for these tests is the explicit 4-arg
    // form; this only checks the default parameter accepts the 3-arg call
    // shape without throwing, deferring to the ambient process.env.
    expect(() => paint({ isTTY: false }, "success", "hello")).not.toThrow();
  });
});

/** Local re-implementation of the truecolor escape shape, independent of truecolorSgr, to pin one side of the equality checks above by hand. */
function truecolorSgrForTest(hex: string, text: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m${text}\x1b[0m`;
}

function paletteColorFor(role: PaletteRole, theme: "light" | "dark"): string {
  return PALETTE[theme][role];
}
