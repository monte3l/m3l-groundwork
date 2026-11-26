// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/** Properties of `diffAgainstHistory` over arbitrary core trees. */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffAgainstHistory } from "../src/update-base.js";
import { coreHistory, writeTree } from "./update-base-fixtures.js";

const tree = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,6}\.txt$/),
  fc.string({ maxLength: 12 }),
  { minKeys: 1, maxKeys: 6 },
);

/** Runs `diffAgainstHistory` of `base` (the recorded release) against `current`. */
function diffTrees(
  base: Record<string, string>,
  current: Record<string, string>,
): ReturnType<typeof diffAgainstHistory> {
  const root = mkdtempSync(join(tmpdir(), "update-base-prop-"));
  try {
    writeTree(join(root, "core"), current);
    writeTree(join(root, "project"), base);
    return diffAgainstHistory({
      targetDir: join(root, "project"),
      history: coreHistory({ "1.0.0": base }),
      baseVersion: "1.0.0",
      coreDir: join(root, "core"),
      packsRoot: join(root, "packs"),
      ledger: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("diffAgainstHistory properties", () => {
  it("an identical tree yields no change", () => {
    fc.assert(
      fc.property(tree, (files) => {
        expect(diffTrees(files, files).core).toEqual({
          changed: [],
          added: [],
          removed: [],
        });
      }),
      { numRuns: 25 },
    );
  });

  it("changing exactly one file's content yields exactly that one changed path", () => {
    fc.assert(
      fc.property(tree, fc.nat(), (files, pick) => {
        const paths = Object.keys(files);
        const target = paths[pick % paths.length] as string;
        const edited = { ...files, [target]: `${files[target] ?? ""}!edited` };
        expect(diffTrees(files, edited).core).toEqual({
          changed: [target],
          added: [],
          removed: [],
        });
      }),
      { numRuns: 25 },
    );
  });
});
