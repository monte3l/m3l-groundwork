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

const DOTFILE_NAMES = [".gitignore", ".npmrc", ".npmignore"] as const;
const ESCAPED_FORMS = ["_gitignore", "_npmrc", "_npmignore"] as const;

describe("escapeDotfileName / restoreDotfileName round trip", () => {
  // NOTE: this is deliberately NOT a universal round trip. escapeDotfileName
  // only transforms the three real dotfile names; restoreDotfileName cannot
  // then distinguish "an escaped dotfile" from "a file that was already
  // literally named _gitignore/_npmrc/_npmignore" -- both un-escape to the
  // dotfile spelling. assets.test.ts's own "does not restore an underscore
  // name that is not an escape" test deliberately avoids these three names
  // for the same reason. The property below is therefore scoped to exclude
  // them, and the `it.each` afterward documents the known exception
  // explicitly rather than silently dropping it.
  const nameArb = fc.oneof(
    fc.constantFrom(...DOTFILE_NAMES, ...ESCAPED_FORMS),
    fc.string(),
  );

  it("round-trips any name that is not itself shaped like one of the three escaped dotfile spellings", () => {
    fc.assert(
      fc.property(
        nameArb.filter(
          (name) => !(ESCAPED_FORMS as readonly string[]).includes(name),
        ),
        (name) => {
          expect(restoreDotfileName(escapeDotfileName(name))).toBe(name);
        },
      ),
      { numRuns: 200 },
    );
  });

  it.each(ESCAPED_FORMS)(
    "[known, documented limitation] does not round-trip %s -- it is indistinguishable from an escaped dotfile",
    (name) => {
      const dotForm = `.${name.slice(1)}`;
      expect(escapeDotfileName(name)).toBe(name); // not a real dotfile name; escape is a no-op
      expect(restoreDotfileName(escapeDotfileName(name))).toBe(dotForm);
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
