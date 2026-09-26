// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for bin/lib/design-tokens.mjs -- see SECURITY.md's
 * "Dynamic analysis" section. design-tokens.test.ts keeps the example-based
 * cases; this file fuzzes small synthetic alias graphs and tree shapes
 * (never the real vendored files) to exercise the resolver's full domain:
 * never throwing anything other than DesignTokenError/Error, a consistent
 * zero-vs-non-zero dimension format, and unique flattened names.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

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
interface FlatToken {
  name: string;
  value: string;
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// eval-lib.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "design-tokens.mjs")).href
)) as {
  DesignTokenError: new (message?: string) => Error;
  resolveTree: (tree: JsonRecord) => JsonRecord;
  formatColor: (value: ColorValue) => string;
  formatDimension: (value: DimensionValue) => string;
  formatEasing: (value: number[]) => string;
  flattenFamily: (
    tree: JsonRecord,
    familyKey: string,
    cssPrefix: string,
    format: (value: never) => string,
  ) => FlatToken[];
};

describe("resolveTree: alias-graph fuzzing", () => {
  const nodeCount = 6;

  // Each node either is a literal leaf (index maps to `null`) or aliases
  // another node by index -- a random function of out-degree exactly 1 per
  // node, so any cycle is fully determined by the array itself.
  const graphArb = fc.array(
    fc.option(fc.integer({ min: 0, max: nodeCount - 1 }), { nil: null }),
    { minLength: nodeCount, maxLength: nodeCount },
  );

  function hasCycle(targets: (number | null)[]): boolean {
    for (let start = 0; start < targets.length; start++) {
      const seen = new Set<number>();
      let cur: number | null = start;
      while (cur !== null) {
        if (seen.has(cur)) return true;
        seen.add(cur);
        cur = targets[cur] ?? null;
      }
    }
    return false;
  }

  function buildTree(targets: (number | null)[]): JsonRecord {
    const tree: JsonRecord = {};
    targets.forEach((target, i) => {
      tree[`node${i}`] = {
        $value: target === null ? `literal-${i}` : `{node${target}}`,
      };
    });
    return tree;
  }

  it("resolves any acyclic alias graph without throwing, and throws DesignTokenError on any induced cycle", () => {
    fc.assert(
      fc.property(graphArb, (targets) => {
        const tree = buildTree(targets);
        if (hasCycle(targets)) {
          expect(() => lib.resolveTree(tree)).toThrow(lib.DesignTokenError);
        } else {
          expect(() => lib.resolveTree(tree)).not.toThrow();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never throws anything other than a DesignTokenError (itself an Error) for this whole malformed-alias-graph domain", () => {
    fc.assert(
      fc.property(graphArb, (targets) => {
        const tree = buildTree(targets);
        try {
          lib.resolveTree(tree);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error).toBeInstanceOf(lib.DesignTokenError);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("formatDimension: zero/unit consistency", () => {
  const unitArb = fc.constantFrom("px", "rem", "em", "ms");
  const dimensionArb = fc.record({
    value: fc.double({
      noNaN: true,
      noDefaultInfinity: true,
      min: -1000,
      max: 1000,
    }),
    unit: unitArb,
  });

  it("formats zero as unitless unless the unit is ms, and always keeps the unit for a non-zero value", () => {
    fc.assert(
      fc.property(dimensionArb, (dimension) => {
        const formatted = lib.formatDimension(dimension);
        if (dimension.value === 0) {
          expect(formatted).toBe(dimension.unit === "ms" ? "0ms" : "0");
          return;
        }
        expect(formatted).not.toBe("0");
        expect(formatted).not.toBe("0ms");
        expect(formatted.endsWith(dimension.unit)).toBe(true);
        const numericPart = formatted.slice(
          0,
          formatted.length - dimension.unit.length,
        );
        expect(Number(numericPart)).toBe(dimension.value);
      }),
      { numRuns: 200 },
    );
  });
});

describe("formatColor / formatEasing: malformed-shape fuzzing", () => {
  // Deliberately shaped to never accidentally satisfy the real shape check
  // (a string "hex" field for color, an array of exactly 4 numbers for
  // easing) -- each case below always exercises the failure path.
  const nonColorArb = fc.oneof(
    fc.integer(),
    fc.string(),
    fc.constant(null),
    fc.constant(undefined),
    fc.record({ value: fc.integer(), unit: fc.string() }),
    fc.record({ hex: fc.integer() }),
    fc.array(fc.integer(), { maxLength: 5 }),
  );

  it("formatColor never returns a string or throws a non-DesignTokenError for any non-color-shaped input", () => {
    fc.assert(
      fc.property(nonColorArb, (value) => {
        let thrown: unknown;
        try {
          lib.formatColor(value as never);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(lib.DesignTokenError);
      }),
      { numRuns: 200 },
    );
  });

  const nonEasingArb = fc.oneof(
    fc.array(fc.double({ noNaN: true }), { maxLength: 3 }),
    fc.array(fc.double({ noNaN: true }), { minLength: 5, maxLength: 8 }),
    fc.string(),
    fc.integer(),
    fc.constant(null),
  );

  it("formatEasing never returns a string or throws a non-DesignTokenError for any array of length != 4 or non-array", () => {
    fc.assert(
      fc.property(nonEasingArb, (value) => {
        let thrown: unknown;
        try {
          lib.formatEasing(value as never);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(lib.DesignTokenError);
      }),
      { numRuns: 200 },
    );
  });
});

describe("flattenFamily: unique names", () => {
  // A small alphabet keeps keys short and readable in a shrunk failure
  // while excluding "$" (which walkLeaves treats as metadata) and "."
  // (which would be ambiguous with the dashed-name separator).
  const keyArb = fc.stringMatching(/^[a-j]{1,4}$/);
  const leafArb = fc.record({
    $value: fc.oneof(fc.integer(), fc.string()),
  });

  function nodeArb(depth: number): fc.Arbitrary<JsonRecord> {
    if (depth <= 0) {
      return fc.dictionary(keyArb, leafArb, { minKeys: 1, maxKeys: 3 });
    }
    return fc.dictionary(keyArb, fc.oneof(leafArb, nodeArb(depth - 1)), {
      minKeys: 1,
      maxKeys: 3,
    });
  }

  it("produces flattened names that are always unique for any tree shape without duplicate keys", () => {
    fc.assert(
      fc.property(nodeArb(2), (familyNode) => {
        const tree = { family: familyNode };
        const result = lib.flattenFamily(tree, "family", "family", (v) =>
          String(v),
        );
        const names = result.map((r) => r.name);
        expect(new Set(names).size).toBe(names.length);
      }),
      { numRuns: 200 },
    );
  });
});
