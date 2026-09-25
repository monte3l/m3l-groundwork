// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for the toolchain grader's scraper functions --
 * see SECURITY.md's "Dynamic analysis" section. rules.ts's rules are regex
 * scrapes over already-read file text (`ToolchainSnapshot.eslint.source`,
 * `.vitest.source`, etc.), and `tsconfig-chain.ts`'s `loadTsconfigChain`
 * scrapes real tsconfig files off disk; both are documented (rules.ts's own
 * module doc, and CLAUDE.md's "the toolchain grader has the same two-
 * implementations shape" section) as never throwing and returning the
 * "can't determine" shape (`{ checked: 0 }`, or `parsed: false` without a
 * throw for `loadTsconfigChain`) rather than a false failure when a scrape
 * cannot tell the answer. grade.test.ts / tsconfig-chain.test.ts keep the
 * example-based cases; this file fuzzes the input domain instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULES } from "../../src/toolchain/rules.js";
import type { ToolchainSnapshot } from "../../src/toolchain/rules.js";
import { loadTsconfigChain } from "../../src/toolchain/tsconfig-chain.js";

/** A minimal, fully-absent snapshot: no config file this grader reads exists. */
function emptySnapshot(
  overrides: Partial<ToolchainSnapshot> = {},
): ToolchainSnapshot {
  return {
    packageJson: undefined,
    scripts: {},
    nodeVersion: undefined,
    tsconfigFiles: new Map(),
    tsconfigLinks: [],
    chains: [],
    eslint: { flatFile: undefined, source: undefined, legacy: [] },
    vitest: { file: undefined, source: undefined },
    gates: { stepsFile: undefined, groups: [], steps: [], packs: undefined },
    lanes: [],
    projectFiles: new Set(),
    ...overrides,
  };
}

/** Arbitrary text biased toward JS/JSON shapes (braces, quotes, comments), not pure noise. */
const jsLikeArb = fc.oneof(
  fc.string(),
  fc.string({ maxLength: 40 }).map((s) => `// ${s}\n${s}`),
  fc.string({ maxLength: 40 }).map((s) => `/* ${s} */ ${s}`),
  fc.string({ maxLength: 40 }).map((s) => `{ "ignores": ["${s}"] }`),
  fc.constantFrom(
    "export default [];",
    'import x from "y";\nexport default [x];',
    "{ oops",
    "const a = { b: 1 };",
    "",
  ),
);

describe("toolchain rules: absence is never a defect", () => {
  it("returns { checked: 0, failures: [] } for every rule when the project has nothing to grade, for any unrelated node version text", () => {
    fc.assert(
      fc.property(fc.string(), (nodeVersion) => {
        const snapshot = emptySnapshot({ nodeVersion });
        for (const rule of RULES) {
          expect(rule.check(snapshot), rule.id).toEqual({
            checked: 0,
            failures: [],
          });
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("toolchain rules: never throw on arbitrary scraped source text", () => {
  it("every rule.check tolerates arbitrary eslint/vitest source text and package.json scripts without throwing", () => {
    fc.assert(
      fc.property(
        jsLikeArb,
        jsLikeArb,
        fc.dictionary(
          fc.string({ maxLength: 20 }),
          fc.string({ maxLength: 40 }),
          {
            maxKeys: 5,
          },
        ),
        fc.string(),
        (eslintSource, vitestSource, scripts, nodeVersion) => {
          const snapshot = emptySnapshot({
            scripts,
            nodeVersion,
            packageJson: { scripts },
            eslint: {
              flatFile: "eslint.config.js",
              source: eslintSource,
              legacy: [],
            },
            vitest: { file: "vitest.config.ts", source: vitestSource },
          });
          for (const rule of RULES) {
            expect(() => rule.check(snapshot), rule.id).not.toThrow();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("loadTsconfigChain: never throws, and reports 'cannot determine' rather than a false claim", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tsconfig-chain-fuzz-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never throws for arbitrary tsconfig.json file content", () => {
    fc.assert(
      fc.property(jsLikeArb, (content) => {
        writeFileSync(join(root, "tsconfig.json"), content);
        expect(() => loadTsconfigChain(root, "tsconfig.json")).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("always reports parsed/complete as booleans, never a thrown exception, for arbitrary content", () => {
    fc.assert(
      fc.property(jsLikeArb, (content) => {
        writeFileSync(join(root, "tsconfig.json"), content);
        const chain = loadTsconfigChain(root, "tsconfig.json");
        expect(typeof chain.parsed).toBe("boolean");
        expect(typeof chain.complete).toBe("boolean");
        expect(Array.isArray(chain.files)).toBe(true);
        expect(Array.isArray(chain.links)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("marks a file that fails to parse as JSONC as parsed: false, rather than throwing or claiming success", () => {
    fc.assert(
      fc.property(
        fc.string().filter((content) => {
          try {
            JSON.parse(content);
            return false; // valid JSON is not the case under test here
          } catch {
            return true;
          }
        }),
        (unparseable) => {
          writeFileSync(join(root, "tsconfig.json"), unparseable);
          const chain = loadTsconfigChain(root, "tsconfig.json");
          expect(chain.parsed).toBe(false);
          expect(chain.complete).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never throws for an arbitrary extends specifier, whether or not it resolves", () => {
    fc.assert(
      fc.property(fc.string(), (specifier) => {
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({ extends: specifier }),
        );
        expect(() => loadTsconfigChain(root, "tsconfig.json")).not.toThrow();
        const chain = loadTsconfigChain(root, "tsconfig.json");
        expect(typeof chain.complete).toBe("boolean");
      }),
      { numRuns: 100 },
    );
  });
});
