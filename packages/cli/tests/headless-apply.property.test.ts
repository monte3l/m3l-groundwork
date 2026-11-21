// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property: a failure injected before any step of an apply, whatever the mix
 * of installs (into new nested directories) and takes in the plan, rolls the
 * project back to a byte-identical tree with no lock, txn/ or applied.json
 * left behind, and reports exactly the steps that had landed.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { applyAdoptActions } from "../src/headless/apply.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";
import { failure, makeEnv } from "./headless-apply-fixture.js";
import type { Action } from "./headless-apply-fixture.js";

describe("applyAdoptActions: rollback property", () => {
  it("restores a byte-identical tree whatever step fails", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("install", "take", "merge"), {
          minLength: 1,
          maxLength: 7,
        }),
        fc.nat(),
        async (kinds, failSeed) => {
          const env = makeEnv();
          try {
            const actions: Action[] = kinds.map((kind, i) => {
              if (kind === "install") {
                return env.install(
                  `new${String(i % 3)}/sub${String(i % 2)}/f${String(i)}.txt`,
                  `installed ${String(i)}\r\n`,
                );
              }
              if (kind === "take") {
                env.put(`t${String(i)}.txt`, `original ${String(i)}\n`);
                return env.take(`t${String(i)}.txt`, `taken ${String(i)}`);
              }
              env.put(`m${String(i)}.json`, `{\n  "k": ${String(i)}\n}\n`);
              return env.merge(
                `m${String(i)}.json`,
                `{"k":${String(i + 100)}}`,
                ["k"],
              );
            });
            const failAt = failSeed % actions.length;
            const before = snapshotTree(env.root);
            const error = await failure(
              applyAdoptActions({
                root: env.root,
                actions,
                io: {
                  beforeStep: ({ index }) => {
                    if (index === failAt) throw new Error("injected");
                  },
                },
              }),
            );
            expect(error.rolledBack).toBe(true);
            expect(error.leftovers).toEqual([]);
            expect(error.written).toHaveLength(failAt);
            expect(snapshotTree(env.root)).toEqual(before);
            env.noResidue();
          } finally {
            env.dispose();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
