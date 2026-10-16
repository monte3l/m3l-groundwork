// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for assets.ts's dotfile-name escaping -- see
 * SECURITY.md's "Dynamic analysis" section. assets.test.ts keeps the
 * example-based cases; this file adds fuzzed invariants alongside it.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  escapeDotfileName,
  restoreDotfileName,
  restoreDotfilePath,
} from "../src/assets.js";

// Hand-written [real, escaped] pairs: the escape rule is pinned here by hand,
// never recomputed from the implementation under test.
const NAME_PAIRS = [
  [".gitignore", "_gitignore"],
  [".npmrc", "_npmrc"],
  [".npmignore", "_npmignore"],
  ["package-lock.json", "_package-lock.json"],
] as const;
const DOTFILE_NAMES = NAME_PAIRS.map(([real]) => real);
const ESCAPED_FORMS: readonly string[] = NAME_PAIRS.map(
  ([, escaped]) => escaped,
);

describe("escapeDotfileName / restoreDotfileName round trip", () => {
  // NOTE: this is deliberately NOT a universal round trip. escapeDotfileName
  // only transforms the four real names; restoreDotfileName cannot
  // then distinguish "an escaped dotfile" from "a file that was already
  // literally named _gitignore/_npmrc/_npmignore/_package-lock.json" -- both
  // un-escape to the real spelling. assets.test.ts's own "does not restore an underscore
  // name that is not an escape" test deliberately avoids these four names
  // for the same reason. The property below is therefore scoped to exclude
  // them, and the `it.each` afterward documents the known exception
  // explicitly rather than silently dropping it.
  const nameArb = fc.oneof(
    fc.constantFrom(...DOTFILE_NAMES, ...ESCAPED_FORMS),
    fc.string(),
  );

  it("round-trips any name that is not itself shaped like one of the four escaped spellings", () => {
    fc.assert(
      fc.property(
        nameArb.filter((name) => !ESCAPED_FORMS.includes(name)),
        (name) => {
          expect(restoreDotfileName(escapeDotfileName(name))).toBe(name);
        },
      ),
      { numRuns: 200 },
    );
  });

  it.each(NAME_PAIRS)(
    "[known, documented limitation] does not round-trip %s's escaped form %s -- it is indistinguishable from an escaped name",
    (real, escaped) => {
      expect(escapeDotfileName(escaped)).toBe(escaped); // not a real name; escape is a no-op
      expect(restoreDotfileName(escapeDotfileName(escaped))).toBe(real);
    },
  );
});

describe("restoreDotfilePath", () => {
  it("only ever changes the final path segment of dir/filename, never the directory", () => {
    const segmentArb = fc
      .string()
      .filter((s) => !s.includes("/") && !s.includes("\\"));

    fc.assert(
      fc.property(segmentArb, segmentArb, (dir, filename) => {
        const relPath = `${dir}/${filename}`;
        const result = restoreDotfilePath(relPath);
        const cut = result.lastIndexOf("/");
        expect(result.slice(0, cut)).toBe(dir);
        expect(result.slice(cut + 1)).toBe(restoreDotfileName(filename));
      }),
      { numRuns: 200 },
    );
  });
});
