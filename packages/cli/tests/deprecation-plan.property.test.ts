// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for bin/lib/deprecation-plan.mjs -- see
 * SECURITY.md's "Dynamic analysis" section. compareSemver must be a total
 * preorder, and a plan must never reach latest or anything newer.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface PlanLib {
  compareSemver(a: string, b: string): -1 | 0 | 1;
  planDeprecations(packument: {
    "dist-tags": { latest?: string };
    versions: Record<string, { deprecated?: string }>;
  }): { deprecate: { version: string; message: string }[]; refused?: string };
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "deprecation-plan.mjs")).href
)) as PlanLib;

const ident = fc.oneof(
  fc.nat({ max: 20 }).map(String),
  fc.constantFrom("alpha", "beta", "rc", "next", "x-1"),
);

const semver = fc
  .tuple(
    fc.nat({ max: 12 }),
    fc.nat({ max: 12 }),
    fc.nat({ max: 12 }),
    fc.array(ident, { maxLength: 3 }),
  )
  .map(
    ([a, b, c, pre]) =>
      `${String(a)}.${String(b)}.${String(c)}${pre.length > 0 ? `-${pre.join(".")}` : ""}`,
  );

describe("compareSemver properties", () => {
  it("is antisymmetric", () => {
    fc.assert(
      fc.property(semver, semver, (a, b) => {
        expect(lib.compareSemver(a, b)).toBe(-lib.compareSemver(b, a) || 0);
      }),
    );
  });

  it("is reflexive", () => {
    fc.assert(
      fc.property(semver, (a) => {
        expect(lib.compareSemver(a, a)).toBe(0);
      }),
    );
  });

  it("is transitive", () => {
    fc.assert(
      fc.property(semver, semver, semver, (a, b, c) => {
        if (lib.compareSemver(a, b) <= 0 && lib.compareSemver(b, c) <= 0) {
          expect(lib.compareSemver(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe("planDeprecations properties", () => {
  it("never plans latest or any version at or above it", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(semver, { maxLength: 15 }),
        semver,
        fc.array(fc.boolean(), { minLength: 15, maxLength: 15 }),
        (versions, latest, flags) => {
          const all = [...new Set([...versions, latest])];
          const map: Record<string, { deprecated?: string }> = {};
          all.forEach((v, i) => {
            map[v] =
              flags[i % flags.length] === true && v !== latest
                ? { deprecated: "x" }
                : {};
          });
          const plan = lib.planDeprecations({
            "dist-tags": { latest },
            versions: map,
          });
          for (const { version, message } of plan.deprecate) {
            expect(message).toBe(
              `Superseded by ${latest}. Use @monte3l/groundwork@latest.`,
            );
            expect(version).not.toBe(latest);
            expect(lib.compareSemver(version, latest)).toBe(-1);
            expect(map[version]?.deprecated).toBeUndefined();
          }
          if (plan.refused !== undefined) {
            expect(plan.deprecate).toEqual([]);
          }
        },
      ),
    );
  });
});
