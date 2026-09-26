// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers bin/lib/design-tokens.mjs -- a zero-dependency DTCG resolver, plain
 * ESM under bin/ outside every tsconfig, loaded by URL (see
 * eval-lib.test.ts for the same pattern). Exercises merge/resolve/format
 * behavior against small synthetic fixtures, then differentially checks the
 * resolver's output for the REAL vendored design/source/dtcg files against
 * design/source/tokens.json, m3l-design's own flattened parity oracle.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

type JsonRecord = Record<string, unknown>;
interface DimensionValue {
  value: number;
  unit: string;
}
interface ColorValue {
  colorSpace: string;
  components: number[];
  hex: string;
  alpha?: number;
}
interface ShadowLayer {
  offsetX: DimensionValue;
  offsetY: DimensionValue;
  blur: DimensionValue;
  spread: DimensionValue;
  color: ColorValue;
}
interface FlatToken {
  name: string;
  value: string;
}
interface DesignSystem {
  resolver: JsonRecord;
  primitives: JsonRecord;
  semantic: JsonRecord;
  components: JsonRecord;
  themes: { light: JsonRecord; dark: JsonRecord };
  motion: { default: JsonRecord; reduced: JsonRecord };
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// eval-lib.test.ts for the same pattern).
interface TypeTreatmentStyle {
  value: Record<string, unknown>;
  ext: Record<string, unknown>;
  letterSpacingEm: number;
}
interface TypeTreatment {
  styles: Map<string, TypeTreatmentStyle>;
  letterSpacing: Map<string, number>;
  wordSpacing: number;
  fontStyle: string;
  fontVariantNumeric: string;
  fontVariantLigatures: string;
  textAlign: string;
  lineHeight: unknown;
  emphasisWeight: unknown;
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "design-tokens.mjs")).href
)) as {
  DesignTokenError: new (
    message?: string,
    options?: { cause?: unknown },
  ) => Error;
  mergeTokenTrees: (...trees: JsonRecord[]) => JsonRecord;
  resolveTree: (tree: JsonRecord) => JsonRecord;
  requireLeafValue: (tree: JsonRecord, dottedPath: string) => unknown;
  loadDesignSystem: (dtcgDir: string) => Promise<DesignSystem>;
  resolveTheme: (
    system: DesignSystem,
    themeId: string,
    motionId: string,
  ) => JsonRecord;
  formatColor: (value: ColorValue) => string;
  formatDimension: (value: DimensionValue) => string;
  formatEasing: (value: number[]) => string;
  formatShadow: (value: ShadowLayer[]) => string;
  isColorValue: (value: unknown) => boolean;
  flattenFamily: (
    tree: JsonRecord,
    familyKey: string,
    cssPrefix: string,
    format: (value: never) => string,
  ) => FlatToken[];
  flattenColors: (tree: JsonRecord) => FlatToken[];
  deriveTypeTreatment: (tree: JsonRecord) => TypeTreatment;
  STYLE_NAMES: string[];
  MONO_STYLES: Set<string>;
};

describe("DesignTokenError", () => {
  it("sets its own name and forwards a cause via the options object", () => {
    const cause = new Error("underlying");
    const error = new lib.DesignTokenError("boom", { cause });
    expect(error.name).toBe("DesignTokenError");
    expect(error.cause).toBe(cause);
  });
});

describe("mergeTokenTrees", () => {
  it("replaces a leaf at the same path with the later tree's leaf", () => {
    const a = { color: { accent: { $value: "#111111" } } };
    const b = { color: { accent: { $value: "#222222" } } };
    expect(lib.mergeTokenTrees(a, b)).toEqual({
      color: { accent: { $value: "#222222" } },
    });
  });

  it("extends a group with new keys from a later tree, keeping the earlier tree's existing keys", () => {
    const a = { color: { accent: { $value: "#111111" } } };
    const b = { color: { danger: { $value: "#ff0000" } } };
    expect(lib.mergeTokenTrees(a, b)).toEqual({
      color: {
        accent: { $value: "#111111" },
        danger: { $value: "#ff0000" },
      },
    });
  });

  it("drops a top-level $ key (e.g. $schema) from the merged result", () => {
    const a = { $schema: "x", color: { accent: { $value: "#111111" } } };
    const merged = lib.mergeTokenTrees(a);
    expect(Object.hasOwn(merged, "$schema")).toBe(false);
    expect(merged).toEqual({ color: { accent: { $value: "#111111" } } });
  });

  it("drops a later tree's group-level $type marker when merging it into a group the earlier tree already defines", () => {
    const a = { color: { accent: { $value: "#111111" } } };
    const b = { color: { $type: "color", danger: { $value: "#ff0000" } } };
    const merged = lib.mergeTokenTrees(a, b);
    expect(Object.hasOwn(merged["color"] as JsonRecord, "$type")).toBe(false);
    expect(merged).toEqual({
      color: {
        accent: { $value: "#111111" },
        danger: { $value: "#ff0000" },
      },
    });
  });

  it("returns an empty tree when merging zero trees", () => {
    expect(lib.mergeTokenTrees()).toEqual({});
  });

  it("returns a single tree's own top-level keys (minus $-prefixed ones) unchanged", () => {
    const a = { $description: "d", color: { accent: { $value: "#111111" } } };
    expect(lib.mergeTokenTrees(a)).toEqual({
      color: { accent: { $value: "#111111" } },
    });
  });
});

describe("resolveTree / alias resolution", () => {
  it("resolves a simple one-hop alias to the target's value", () => {
    const tree = {
      color: {
        base: { $value: "#111111" },
        alias: { $value: "{color.base}" },
      },
    };
    const resolved = lib.resolveTree(tree);
    expect(
      (resolved["color"] as JsonRecord)["alias"] as { $value: unknown },
    ).toEqual({ $value: "#111111" });
  });

  it("resolves a multi-hop alias chain through every hop", () => {
    const tree = {
      a: { $value: "{b}" },
      b: { $value: "{c}" },
      c: { $value: "final-literal" },
    };
    const resolved = lib.resolveTree(tree);
    expect((resolved["a"] as { $value: unknown }).$value).toBe("final-literal");
  });

  it("throws DesignTokenError mentioning a cycle for a self-referencing alias", () => {
    const tree = { a: { $value: "{a}" } };
    let thrown: unknown;
    try {
      lib.resolveTree(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toMatch(/cycle/);
  });

  it("throws DesignTokenError for a two-node mutual alias cycle", () => {
    const tree = { a: { $value: "{b}" }, b: { $value: "{a}" } };
    let thrown: unknown;
    try {
      lib.resolveTree(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toMatch(/cycle/);
  });

  it("throws DesignTokenError mentioning the missing path for an alias with no target", () => {
    const tree = { a: { $value: "{nope.gone}" } };
    let thrown: unknown;
    try {
      lib.resolveTree(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("nope.gone");
  });

  it("resolves every alias field of a composite (typography-shaped) value while leaving literal fields untouched", () => {
    const tree = {
      "font-family": { sans: { $value: ["Test Sans", "sans-serif"] } },
      "font-weight": { bold: { $value: 700 } },
      typography: {
        body: {
          $value: {
            fontFamily: "{font-family.sans}",
            fontSize: { value: 1, unit: "rem" },
            fontWeight: "{font-weight.bold}",
          },
        },
      },
    };
    const resolved = lib.resolveTree(tree);
    const body = (resolved["typography"] as JsonRecord)["body"] as {
      $value: unknown;
    };
    expect(body.$value).toEqual({
      fontFamily: ["Test Sans", "sans-serif"],
      fontSize: { value: 1, unit: "rem" },
      fontWeight: 700,
    });
  });

  it("resolves every item of an array (shadow-shaped) value", () => {
    const tree = {
      color: {
        ink: {
          $value: {
            colorSpace: "srgb",
            components: [0, 0, 0],
            hex: "#000000",
          },
        },
      },
      shadow: {
        layer: {
          $value: [
            {
              offsetX: { value: 0, unit: "px" },
              offsetY: { value: 1, unit: "px" },
              blur: { value: 2, unit: "px" },
              spread: { value: 0, unit: "px" },
              color: "{color.ink}",
            },
            {
              offsetX: { value: 0, unit: "px" },
              offsetY: { value: 2, unit: "px" },
              blur: { value: 4, unit: "px" },
              spread: { value: 0, unit: "px" },
              color: "{color.ink}",
            },
          ],
        },
      },
    };
    const resolved = lib.resolveTree(tree);
    const value = (
      (resolved["shadow"] as JsonRecord)["layer"] as { $value: ShadowLayer[] }
    ).$value;
    expect(value).toHaveLength(2);
    for (const layer of value) {
      expect(layer.color).toEqual({
        colorSpace: "srgb",
        components: [0, 0, 0],
        hex: "#000000",
      });
    }
  });
});

describe("formatColor", () => {
  it("passes an opaque color through as its plain hex", () => {
    expect(
      lib.formatColor({
        colorSpace: "srgb",
        components: [0, 0, 0],
        hex: "#000000",
      }),
    ).toBe("#000000");
  });

  it("keeps a color with alpha exactly 1 as plain hex, not rgba", () => {
    expect(
      lib.formatColor({
        colorSpace: "srgb",
        components: [0, 0, 0],
        hex: "#000000",
        alpha: 1,
      }),
    ).toBe("#000000");
  });

  it("formats a color with alpha < 1 as rgba with a 2-decimal alpha", () => {
    expect(
      lib.formatColor({
        colorSpace: "srgb",
        components: [0, 0, 0],
        hex: "#000000",
        alpha: 0.4,
      }),
    ).toBe("rgba(0, 0, 0, 0.40)");
  });

  it.each([
    ["a dimension-shaped value", { value: 1, unit: "px" }],
    ["a plain number", 5],
    ["null", null],
    [
      "components with non-numeric entries",
      { hex: "#000000", components: ["a", "b", "c"] },
    ],
  ])("throws DesignTokenError for %s", (_label, value) => {
    expect(() => lib.formatColor(value as unknown as ColorValue)).toThrow(
      lib.DesignTokenError,
    );
  });
});

describe("formatDimension", () => {
  it.each([
    ["rem", { value: 0, unit: "rem" }, "0"],
    ["px", { value: 0, unit: "px" }, "0"],
    ["em", { value: 0, unit: "em" }, "0"],
  ])('formats a zero %s length as unitless "0"', (_label, value, expected) => {
    expect(lib.formatDimension(value)).toBe(expected);
  });

  it.each([
    ["ms", { value: 0, unit: "ms" }, "0ms"],
    ["s", { value: 0, unit: "s" }, "0s"],
  ])("keeps the unit on a zero duration (%s)", (_label, value, expected) => {
    expect(lib.formatDimension(value)).toBe(expected);
  });

  it.each([
    [{ value: 1.5, unit: "rem" }, "1.5rem"],
    [{ value: 8, unit: "px" }, "8px"],
    [{ value: 0.5, unit: "em" }, "0.5em"],
    [{ value: 100, unit: "ms" }, "100ms"],
    [{ value: 2, unit: "s" }, "2s"],
  ])("formats a non-zero dimension %o as %s", (value, expected) => {
    expect(lib.formatDimension(value)).toBe(expected);
  });

  it.each([
    ["a plain string", "4px"],
    ["a bare number", 4],
    ["a string-typed value field", { value: "4", unit: "px" }],
    ["null", null],
  ])("throws DesignTokenError for %s", (_label, value) => {
    expect(() =>
      lib.formatDimension(value as unknown as DimensionValue),
    ).toThrow(lib.DesignTokenError);
  });
});

describe("formatEasing", () => {
  it("formats a cubic-bezier array as CSS", () => {
    expect(lib.formatEasing([0.2, 0, 0, 1])).toBe("cubic-bezier(0.2, 0, 0, 1)");
  });

  it.each([
    ["a 3-element array", [0.2, 0, 0]],
    ["a non-array", "not-an-array"],
  ])("throws DesignTokenError for %s", (_label, value) => {
    expect(() => lib.formatEasing(value as unknown as number[])).toThrow(
      lib.DesignTokenError,
    );
  });
});

describe("formatShadow", () => {
  const opaqueLayer: ShadowLayer = {
    offsetX: { value: 0, unit: "px" },
    offsetY: { value: 1, unit: "px" },
    blur: { value: 2, unit: "px" },
    spread: { value: 0, unit: "px" },
    color: {
      colorSpace: "srgb",
      components: [0.07, 0.07, 0.07],
      hex: "#121212",
    },
  };

  it("formats a single layer as offsetX offsetY blur spread color", () => {
    expect(lib.formatShadow([opaqueLayer])).toBe("0 1px 2px 0 #121212");
  });

  it("joins multiple layers with a comma", () => {
    const second: ShadowLayer = {
      offsetX: { value: 0, unit: "px" },
      offsetY: { value: 4, unit: "px" },
      blur: { value: 12, unit: "px" },
      spread: { value: 2, unit: "px" },
      color: {
        colorSpace: "srgb",
        components: [0, 0, 0],
        hex: "#000000",
        alpha: 0.4,
      },
    };
    expect(lib.formatShadow([opaqueLayer, second])).toBe(
      "0 1px 2px 0 #121212, 0 4px 12px 2px rgba(0, 0, 0, 0.40)",
    );
  });

  it("always includes a zero spread rather than omitting it", () => {
    const layer: ShadowLayer = {
      ...opaqueLayer,
      spread: { value: 0, unit: "px" },
    };
    expect(lib.formatShadow([layer])).toContain(" 0 #121212");
  });

  it("throws DesignTokenError for a non-array value", () => {
    expect(() =>
      lib.formatShadow("not-an-array" as unknown as ShadowLayer[]),
    ).toThrow(lib.DesignTokenError);
  });
});

describe("isColorValue", () => {
  it("is true for a color-shaped object (has a string hex)", () => {
    expect(
      lib.isColorValue({
        colorSpace: "srgb",
        components: [0, 0, 0],
        hex: "#000000",
      }),
    ).toBe(true);
  });

  it("is false for a dimension-shaped object", () => {
    expect(lib.isColorValue({ value: 1, unit: "rem" })).toBe(false);
  });

  it.each([[5], ["hello"], [null], [undefined]])(
    "is false for a plain %p",
    (value) => {
      expect(lib.isColorValue(value)).toBe(false);
    },
  );

  it("is false when components has non-numeric entries", () => {
    expect(
      lib.isColorValue({ hex: "#000000", components: ["a", "b", "c"] }),
    ).toBe(false);
  });

  it("is false when components is not exactly length 3", () => {
    expect(lib.isColorValue({ hex: "#000000", components: [1, 2] })).toBe(
      false,
    );
  });
});

describe("requireLeafValue", () => {
  it("returns the leaf's resolved $value for a valid dotted path", () => {
    const tree = { a: { b: { $value: 42 } } };
    expect(lib.requireLeafValue(tree, "a.b")).toBe(42);
  });

  it("throws DesignTokenError naming the exact path when there is no leaf there", () => {
    const tree = { a: { b: { $value: 42 } } };
    let thrown: unknown;
    try {
      lib.requireLeafValue(tree, "nope.gone");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("nope.gone");
  });
});

describe("flattenFamily", () => {
  it("flattens a family into a sorted [{name,value}] list", () => {
    const tree = {
      space: {
        "4": { $value: { value: 1, unit: "rem" } },
        "0": { $value: { value: 0, unit: "rem" } },
        "2": { $value: { value: 0.5, unit: "rem" } },
      },
    };
    expect(
      lib.flattenFamily(tree, "space", "space", lib.formatDimension),
    ).toEqual([
      { name: "space-0", value: "0" },
      { name: "space-2", value: "0.5rem" },
      { name: "space-4", value: "1rem" },
    ]);
  });

  it("names the token just the cssPrefix when the family is itself a single leaf", () => {
    const tree = {
      "paragraph-spacing": { $value: { value: 1.5, unit: "em" } },
    };
    expect(
      lib.flattenFamily(
        tree,
        "paragraph-spacing",
        "paragraph-spacing",
        lib.formatDimension,
      ),
    ).toEqual([{ name: "paragraph-spacing", value: "1.5em" }]);
  });

  it("throws DesignTokenError for a family key that does not exist on the tree", () => {
    const tree = { space: { "0": { $value: { value: 0, unit: "rem" } } } };
    expect(() =>
      lib.flattenFamily(tree, "no-such-family", "x", lib.formatDimension),
    ).toThrow(lib.DesignTokenError);
  });

  it("wraps a formatter's own thrown error, naming the family and the exact leaf path, and keeps the original as its cause", () => {
    // A dimension-shaped family run through the COLOR formatter is
    // guaranteed to fail formatColor's shape check for every leaf.
    const tree = {
      space: {
        "4": { $value: { value: 1, unit: "rem" } },
      },
    };
    let thrown: unknown;
    try {
      lib.flattenFamily(tree, "space", "space", lib.formatColor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("space");
    expect((thrown as Error).message).toContain("4");
    expect((thrown as Error).cause).toBeInstanceOf(lib.DesignTokenError);
  });

  it("throws DesignTokenError when two different nested paths flatten to the same dashed name", () => {
    // "a-b" (a leaf) and "a.b" (a leaf nested under group "a") both dash to
    // "prefix-a-b".
    const tree = {
      family: {
        "a-b": { $value: 1 },
        a: { b: { $value: 2 } },
      },
    };
    expect(() =>
      lib.flattenFamily(tree, "family", "prefix", (v) => String(v)),
    ).toThrow(lib.DesignTokenError);
  });
});

describe("flattenColors", () => {
  it("collects color leaves from the color family and a component-tier group, and excludes a non-color group", () => {
    const tree = {
      color: {
        neutral: {
          "50": {
            $value: {
              colorSpace: "srgb",
              components: [1, 1, 1],
              hex: "#ffffff",
            },
          },
        },
      },
      button: {
        primary: {
          bg: {
            $value: {
              colorSpace: "srgb",
              components: [0.5, 0.1, 0.2],
              hex: "#802030",
            },
          },
        },
      },
      space: {
        "4": { $value: { value: 1, unit: "rem" } },
      },
    };
    const result = lib.flattenColors(tree);
    expect(result).toEqual([
      { name: "button-primary-bg", value: "#802030" },
      { name: "color-neutral-50", value: "#ffffff" },
    ]);
    expect(result.some((t) => t.name.startsWith("space"))).toBe(false);
  });

  it("throws DesignTokenError when two different top-level groups' paths collide once dashed", () => {
    // Group "button-primary" leaf "bg" and group "button" path "primary.bg"
    // both dash to "button-primary-bg".
    const tree = {
      "button-primary": {
        bg: {
          $value: { colorSpace: "srgb", components: [0, 0, 0], hex: "#000000" },
        },
      },
      button: {
        primary: {
          bg: {
            $value: {
              colorSpace: "srgb",
              components: [1, 1, 1],
              hex: "#ffffff",
            },
          },
        },
      },
    };
    expect(() => lib.flattenColors(tree)).toThrow(lib.DesignTokenError);
  });

  it("finds a color leaf inside a group that a former skip-list would have excluded (e.g. a tint alongside shadow's own non-color layers)", () => {
    const tree = {
      shadow: {
        tint: {
          $value: {
            colorSpace: "srgb",
            components: [0.2, 0.2, 0.2],
            hex: "#333333",
          },
        },
        sm: {
          $value: [
            {
              offsetX: { value: 0, unit: "px" },
              offsetY: { value: 1, unit: "px" },
              blur: { value: 2, unit: "px" },
              spread: { value: 0, unit: "px" },
              color: {
                colorSpace: "srgb",
                components: [0, 0, 0],
                hex: "#000000",
              },
            },
          ],
        },
      },
    };
    const result = lib.flattenColors(tree);
    expect(result).toEqual([{ name: "shadow-tint", value: "#333333" }]);
  });
});

describe("deriveTypeTreatment: synthetic negative paths", () => {
  interface StyleSpec {
    fontWeight: number;
    letterSpacingEm: number;
    wordSpacingEm: number;
    fontStyle: string;
    fontVariantNumeric: string;
    fontVariantLigatures: string;
    textAlign: string;
  }

  // Weight assignment mirrors the real brand-book buckets closely enough to
  // exercise every grouping rule: several styles share weight 400/600/700,
  // and both mono styles ("code", "code-strong") land in their own
  // mono-prefixed buckets.
  const WEIGHT_BY_STYLE: Record<string, number> = {
    display: 700,
    "heading-1": 700,
    "heading-2": 600,
    "heading-3": 600,
    "heading-4": 600,
    "body-lg": 400,
    body: 400,
    "body-strong": 600,
    label: 600,
    caption: 400,
    code: 400,
    "code-strong": 700,
  };
  const LETTER_SPACING_BY_BUCKET: Record<string, number> = {
    "400": 0.055,
    "600": 0.08,
    "700": 0.09,
    "mono-400": 0,
    "mono-700": 0.035,
  };

  function bucketFor(name: string): string {
    const weight = WEIGHT_BY_STYLE[name];
    return `${lib.MONO_STYLES.has(name) ? "mono-" : ""}${String(weight)}`;
  }

  function baselineStyleSpec(name: string): StyleSpec {
    return {
      fontWeight: WEIGHT_BY_STYLE[name] as number,
      letterSpacingEm: LETTER_SPACING_BY_BUCKET[bucketFor(name)] as number,
      wordSpacingEm: 0.015,
      fontStyle: "normal",
      fontVariantNumeric: "tabular-nums lining-nums",
      fontVariantLigatures: "none",
      textAlign: "left",
    };
  }

  /**
   * Builds a minimally valid synthetic resolved tree for
   * `deriveTypeTreatment`, covering all 12 required typography styles plus
   * `line-height.base` and `font-weight.bold`. `mutateSpecs` receives the
   * mutable per-style spec map (keyed by style name; setting an entry to
   * `undefined` omits that style from the tree entirely) before the tree is
   * assembled; `mutateTree` then receives the assembled plain tree for any
   * structural mutation a scalar spec field can't express (dropping an
   * `$extensions` object, a `fontWeight` in `$value`). Each negative test
   * below uses exactly one of the two to introduce exactly one deviation.
   */
  function buildTypographyFixture(
    mutateSpecs?: (specs: Map<string, StyleSpec | undefined>) => void,
    mutateTree?: (tree: JsonRecord) => void,
  ): JsonRecord {
    const specs = new Map<string, StyleSpec | undefined>(
      lib.STYLE_NAMES.map((name) => [name, baselineStyleSpec(name)]),
    );
    mutateSpecs?.(specs);

    const typography: JsonRecord = {};
    for (const [name, spec] of specs) {
      if (spec === undefined) continue;
      typography[name] = {
        $value: { fontWeight: spec.fontWeight },
        $extensions: {
          "org.monte3l.m3l-design": {
            letterSpacingEm: spec.letterSpacingEm,
            wordSpacingEm: spec.wordSpacingEm,
            fontStyle: spec.fontStyle,
            fontVariantNumeric: spec.fontVariantNumeric,
            fontVariantLigatures: spec.fontVariantLigatures,
            textAlign: spec.textAlign,
          },
        },
      };
    }

    const tree: JsonRecord = {
      typography,
      "line-height": { base: { $value: 1.5 } },
      "font-weight": { bold: { $value: 700 } },
    };
    mutateTree?.(tree);
    return tree;
  }

  it("builds without throwing (sanity check for the fixture helper itself)", () => {
    expect(() =>
      lib.deriveTypeTreatment(buildTypographyFixture()),
    ).not.toThrow();
  });

  it("throws DesignTokenError mentioning the missing style's name when a required style is absent entirely", () => {
    const tree = buildTypographyFixture((specs) => {
      specs.set("caption", undefined);
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("caption");
  });

  it("throws DesignTokenError when a style's $extensions object (or the org.monte3l.m3l-design key within it) is missing", () => {
    const tree = buildTypographyFixture(undefined, (built) => {
      const typography = built["typography"] as JsonRecord;
      const heading3 = typography["heading-3"] as JsonRecord;
      delete heading3["$extensions"];
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("heading-3");
  });

  it("throws DesignTokenError when a style is missing a resolved numeric fontWeight", () => {
    const tree = buildTypographyFixture(undefined, (built) => {
      const typography = built["typography"] as JsonRecord;
      const bodyLg = typography["body-lg"] as JsonRecord;
      delete (bodyLg["$value"] as JsonRecord)["fontWeight"];
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("body-lg");
  });

  it("throws DesignTokenError mentioning the weight bucket and letterSpacingEm when two same-weight styles disagree", () => {
    // body and caption are both weight 400 (non-mono, bucket "400").
    const tree = buildTypographyFixture((specs) => {
      const caption = specs.get("caption") as StyleSpec;
      specs.set("caption", { ...caption, letterSpacingEm: 0.999 });
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("400");
    expect((thrown as Error).message).toContain("letterSpacingEm");
  });

  it("throws DesignTokenError mentioning wordSpacingEm when two weight-400 sans styles disagree on it", () => {
    const tree = buildTypographyFixture((specs) => {
      const caption = specs.get("caption") as StyleSpec;
      specs.set("caption", { ...caption, wordSpacingEm: 0.2 });
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("wordSpacingEm");
  });

  it("throws DesignTokenError mentioning textAlign when styles disagree on a shared flag", () => {
    const tree = buildTypographyFixture((specs) => {
      const label = specs.get("label") as StyleSpec;
      specs.set("label", { ...label, textAlign: "center" });
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toContain("textAlign");
  });

  it("throws DesignTokenError mentioning weight-400/word-spacing when no weight-400 sans style exists", () => {
    // Move every normally-weight-400 sans style (body-lg, body, caption)
    // into the existing 600 bucket (matching its letterSpacingEm so that
    // check doesn't fire first) -- only "code" is left at weight 400, and
    // it's mono, so bucket "400" itself no longer exists.
    const tree = buildTypographyFixture((specs) => {
      for (const name of ["body-lg", "body", "caption"]) {
        const spec = specs.get(name) as StyleSpec;
        specs.set(name, { ...spec, fontWeight: 600, letterSpacingEm: 0.08 });
      }
    });
    let thrown: unknown;
    try {
      lib.deriveTypeTreatment(tree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.DesignTokenError);
    expect((thrown as Error).message).toMatch(/weight-400/);
    expect((thrown as Error).message).toMatch(/word-spacing/);
  });
});

describe("loadDesignSystem + resolveTheme against the real vendored files", () => {
  const dtcgDir = join(repoRoot, "design", "source", "dtcg");

  it("loads all 8 files and resolves light/default, dark/default, and light/reduced without throwing", async () => {
    const system = await lib.loadDesignSystem(dtcgDir);
    expect(() => lib.resolveTheme(system, "light", "default")).not.toThrow();
    expect(() => lib.resolveTheme(system, "dark", "default")).not.toThrow();
    expect(() => lib.resolveTheme(system, "light", "reduced")).not.toThrow();
  });

  it("throws DesignTokenError for an unrecognized themeId", async () => {
    const system = await lib.loadDesignSystem(dtcgDir);
    expect(() => lib.resolveTheme(system, "sepia", "default")).toThrow(
      lib.DesignTokenError,
    );
  });

  it("throws DesignTokenError for an unrecognized motionId", async () => {
    const system = await lib.loadDesignSystem(dtcgDir);
    expect(() => lib.resolveTheme(system, "light", "nope")).toThrow(
      lib.DesignTokenError,
    );
  });
});

describe("loadDesignSystem: assertResolverShape validation (mutated real files)", () => {
  interface ResolverJson {
    sets: Record<string, unknown>;
    modifiers: {
      theme: { contexts: Record<string, unknown> };
      motion: { contexts: Record<string, unknown> };
    };
    resolutionOrder: Array<{ $ref: string }>;
  }

  const realDtcgDir = join(repoRoot, "design", "source", "dtcg");
  // Every file loadDesignSystem reads besides the resolver itself -- copied
  // back out unchanged so only the resolver manifest under test is mutated.
  const companionFiles = [
    "primitives.tokens.json",
    "semantic.tokens.json",
    "components.tokens.json",
    "theme-light.tokens.json",
    "theme-dark.tokens.json",
    "motion-default.tokens.json",
    "motion-reduced.tokens.json",
  ];

  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function writeMutatedResolverDir(
    mutate: (resolver: ResolverJson) => void,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "design-tokens-resolver-"));
    for (const filename of companionFiles) {
      const text = readFileSync(join(realDtcgDir, filename), "utf8");
      await writeFile(join(dir, filename), text, "utf8");
    }
    const resolverText = readFileSync(
      join(realDtcgDir, "m3l.resolver.json"),
      "utf8",
    );
    const mutated = JSON.parse(resolverText) as ResolverJson;
    mutate(mutated);
    await writeFile(
      join(dir, "m3l.resolver.json"),
      JSON.stringify(mutated, null, 2),
      "utf8",
    );
    return dir;
  }

  it.each([
    [
      "resolutionOrder with two entries swapped",
      (resolver: ResolverJson) => {
        const [first, second, ...rest] = resolver.resolutionOrder;
        resolver.resolutionOrder = [second, first, ...rest].filter(
          (entry): entry is { $ref: string } => entry !== undefined,
        );
      },
    ],
    [
      "a sets key renamed",
      (resolver: ResolverJson) => {
        resolver.sets["componentsRenamed"] = resolver.sets["components"];
        delete resolver.sets["components"];
      },
    ],
    [
      "modifiers.theme.contexts missing dark",
      (resolver: ResolverJson) => {
        delete resolver.modifiers.theme.contexts["dark"];
      },
    ],
    [
      "modifiers.motion.contexts missing reduced",
      (resolver: ResolverJson) => {
        delete resolver.modifiers.motion.contexts["reduced"];
      },
    ],
    [
      "sets.semantic.sources[0].$ref pointing at the wrong file",
      (resolver: ResolverJson) => {
        const semantic = resolver.sets["semantic"] as {
          sources: Array<{ $ref: string }>;
        };
        const [firstSource] = semantic.sources;
        if (!firstSource) {
          throw new Error("test fixture: sets.semantic.sources[0] is missing");
        }
        firstSource.$ref = "WRONG-FILE.json";
      },
    ],
    [
      "modifiers.theme.contexts.dark[0].$ref pointing at the wrong file",
      (resolver: ResolverJson) => {
        const dark = resolver.modifiers.theme.contexts["dark"] as Array<{
          $ref: string;
        }>;
        const [firstDark] = dark;
        if (!firstDark) {
          throw new Error(
            "test fixture: modifiers.theme.contexts.dark[0] is missing",
          );
        }
        firstDark.$ref = "WRONG-FILE.json";
      },
    ],
  ])("throws DesignTokenError for %s", async (_label, mutate) => {
    tempDir = await writeMutatedResolverDir(mutate);
    await expect(lib.loadDesignSystem(tempDir)).rejects.toThrow(
      lib.DesignTokenError,
    );
  });
});

describe("parity oracle: resolved tree vs design/source/tokens.json", () => {
  interface TokensJsonToken {
    name: string;
    value: unknown;
    usage?: string;
  }
  type TokensJson = Record<string, unknown>;

  const dtcgDir = join(repoRoot, "design", "source", "dtcg");
  const tokensJsonPath = join(repoRoot, "design", "source", "tokens.json");
  const tokensJson = JSON.parse(
    readFileSync(tokensJsonPath, "utf8"),
  ) as TokensJson;

  function familyTokens(family: string): TokensJsonToken[] {
    const entry = tokensJson[family] as { tokens?: TokensJsonToken[] };
    const tokens = entry.tokens;
    if (!tokens)
      throw new Error(`tokens.json family "${family}" has no tokens`);
    return tokens;
  }

  /** Selects the theme-specific string when a tokens.json value is theme-split ({light,dark}); otherwise returns the plain string as-is. */
  function themedValue(raw: unknown, theme: "light" | "dark"): string {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      return (raw as Record<string, string>)[theme] as string;
    }
    return raw as string;
  }

  /**
   * Asserts `flattenFamily(tree, treeKey, cssPrefix, format)` matches
   * tokens.json's own flattened `family` list, token by token, for both
   * themes -- a length mismatch or any single value mismatch fails with the
   * offending token's name and both values.
   */
  function assertFamilyParity(
    family: string,
    treeKey: string,
    cssPrefix: string,
    format: (value: never) => string,
    trees: { light: JsonRecord; dark: JsonRecord },
  ): void {
    const expectedTokens = familyTokens(family);
    for (const theme of ["light", "dark"] as const) {
      const tree = trees[theme];
      const actual = lib.flattenFamily(tree, treeKey, cssPrefix, format);
      const actualByName = new Map(actual.map((t) => [t.name, t.value]));
      expect(
        actual.length,
        `family "${family}" (theme ${theme}): expected ${expectedTokens.length} tokens, got ${actual.length}`,
      ).toBe(expectedTokens.length);
      for (const expectedToken of expectedTokens) {
        const expectedValue = themedValue(expectedToken.value, theme);
        const actualValue = actualByName.get(expectedToken.name);
        expect(
          actualValue,
          `family "${family}" token "${expectedToken.name}" (theme ${theme}): expected "${expectedValue}", got "${String(actualValue)}"`,
        ).toBe(expectedValue);
      }
    }
  }

  let light: JsonRecord;
  let dark: JsonRecord;
  let reduced: JsonRecord;

  it("loads and resolves the real system (setup for the parity checks below)", async () => {
    const system = await lib.loadDesignSystem(dtcgDir);
    light = lib.resolveTheme(system, "light", "default");
    dark = lib.resolveTheme(system, "dark", "default");
    reduced = lib.resolveTheme(system, "light", "reduced");
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    expect(reduced).toBeDefined();
  });

  it("matches tokens.json's spacing family", () => {
    assertFamilyParity("spacing", "space", "space", lib.formatDimension, {
      light,
      dark,
    });
  });

  it("matches tokens.json's radius family", () => {
    assertFamilyParity("radius", "radius", "radius", lib.formatDimension, {
      light,
      dark,
    });
  });

  it("matches tokens.json's duration family", () => {
    assertFamilyParity(
      "duration",
      "duration",
      "duration",
      lib.formatDimension,
      {
        light,
        dark,
      },
    );
    // Under reduced motion, every duration resolves to 0ms per
    // design/README.md -- double-checked against the same family.
    const expected = familyTokens("duration");
    const actual = lib.flattenFamily(
      reduced,
      "duration",
      "duration",
      lib.formatDimension,
    );
    expect(actual).toHaveLength(expected.length);
    for (const token of actual) {
      expect(token.value, `reduced duration "${token.name}" is not 0ms`).toBe(
        "0ms",
      );
    }
  });

  it("matches tokens.json's easing family", () => {
    assertFamilyParity("easing", "easing", "easing", lib.formatEasing, {
      light,
      dark,
    });
  });

  it("matches tokens.json's breakpoint family", () => {
    assertFamilyParity(
      "breakpoint",
      "breakpoint",
      "breakpoint",
      lib.formatDimension,
      { light, dark },
    );
  });

  it("matches tokens.json's zIndex family", () => {
    assertFamilyParity("zIndex", "z-index", "z-index", (v) => String(v), {
      light,
      dark,
    });
  });

  it("matches tokens.json's shadow family (theme-split values)", () => {
    assertFamilyParity("shadow", "shadow", "shadow", lib.formatShadow, {
      light,
      dark,
    });
  });

  it("matches tokens.json's borderWidth family, combining border-width and focus-ring", () => {
    const expectedTokens = familyTokens("borderWidth");
    for (const theme of ["light", "dark"] as const) {
      const tree = theme === "light" ? light : dark;
      const actual = [
        ...lib.flattenFamily(
          tree,
          "border-width",
          "border-width",
          lib.formatDimension,
        ),
        ...lib.flattenFamily(
          tree,
          "focus-ring",
          "focus-ring",
          lib.formatDimension,
        ),
      ];
      const actualByName = new Map(actual.map((t) => [t.name, t.value]));
      expect(actual.length).toBe(expectedTokens.length);
      for (const expectedToken of expectedTokens) {
        const expectedValue = themedValue(expectedToken.value, theme);
        const actualValue = actualByName.get(expectedToken.name);
        expect(
          actualValue,
          `borderWidth token "${expectedToken.name}" (theme ${theme}): expected "${expectedValue}", got "${String(actualValue)}"`,
        ).toBe(expectedValue);
      }
    }
  });

  describe("color family (full differential check)", () => {
    const colorTokens = familyTokens("color");
    const byName = new Map(colorTokens.map((t) => [t.name, t.value]));

    /**
     * Resolves m3l-design's own FLAT dashed-name aliases (`{color-neutral-0}`),
     * a different alias syntax/namespace than the DTCG dotted-path aliases
     * the resolver itself handles -- following theme selectors and chained
     * aliases until a plain hex/rgba literal is reached. Throws on a cycle
     * or a reference to a name with no matching token.
     */
    function resolveFlatAliasForTheme(
      value: unknown,
      theme: "light" | "dark",
      seen: Set<string> = new Set(),
    ): string {
      let current: unknown = value;
      for (;;) {
        if (
          current !== null &&
          typeof current === "object" &&
          !Array.isArray(current)
        ) {
          current = (current as Record<string, unknown>)[theme];
          continue;
        }
        if (typeof current !== "string") {
          throw new Error(
            `unexpected non-string flat alias target: ${JSON.stringify(current)}`,
          );
        }
        const match = /^\{([^{}]+)\}$/.exec(current);
        if (!match) return current;
        const name = match[1] as string;
        if (seen.has(name)) {
          throw new Error(`flat alias cycle detected at "${name}"`);
        }
        seen.add(name);
        const next = byName.get(name);
        if (next === undefined) {
          throw new Error(
            `flat alias "${name}" has no matching token in tokens.json`,
          );
        }
        current = next;
      }
    }

    it.each(["light", "dark"] as const)(
      "matches every one of tokens.json's ~138 color tokens for %s",
      (theme) => {
        const tree = theme === "light" ? light : dark;
        const actual = lib.flattenColors(tree);
        const actualByName = new Map(actual.map((t) => [t.name, t.value]));
        expect(
          actual.length,
          `color token count mismatch for theme ${theme}: resolved tree has ${actual.length}, tokens.json has ${colorTokens.length}`,
        ).toBe(colorTokens.length);
        for (const token of colorTokens) {
          const expected = resolveFlatAliasForTheme(token.value, theme);
          const got = actualByName.get(token.name);
          expect(
            got,
            `color token "${token.name}" is missing from the resolved tree (theme ${theme})`,
          ).toBeDefined();
          expect(
            got,
            `color token "${token.name}" (theme ${theme}): expected "${expected}", got "${String(got)}"`,
          ).toBe(expected);
        }
      },
    );
  });

  describe("deriveTypeTreatment (real vendored data, reusing the already-resolved light/default tree)", () => {
    it("derives exact per-weight-bucket letter-spacing, shared word-spacing, and shared style flags", () => {
      const result = lib.deriveTypeTreatment(light);
      expect(Object.fromEntries(result.letterSpacing)).toEqual({
        "400": 0.055,
        "600": 0.08,
        "700": 0.09,
        "mono-400": 0,
        "mono-700": 0.035,
      });
      expect(result.wordSpacing).toBe(0.015);
      expect(result.fontStyle).toBe("normal");
      expect(result.fontVariantNumeric).toBe("tabular-nums lining-nums");
      expect(result.fontVariantLigatures).toBe("none");
      expect(result.textAlign).toBe("left");
      expect(result.lineHeight).toBe(1.5);
      expect(result.emphasisWeight).toBe(700);
    });

    it.each([
      ["body", 0.055],
      ["heading-1", 0.09],
      ["code-strong", 0.035],
    ])(
      'attaches the correct letterSpacingEm to styles.get("%s")',
      (name, expected) => {
        const result = lib.deriveTypeTreatment(light);
        expect(result.styles.get(name)?.letterSpacingEm).toBe(expected);
      },
    );
  });
});
