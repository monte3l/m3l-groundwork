// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The upgrade flow's pure classifier: every row of the decision procedure,
 * plus classifyAll's union, ordering and purity guarantees.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  classifyAll,
  classifyPath,
  type ClassifyInput,
  type Recorded,
  type UpgradeClass,
  type UpgradeEntry,
} from "../src/upgrade/classify.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const emitted = (sha256: string): Recorded => ({ sha256, origin: "emitted" });
const merged = (sha256: string): Recorded => ({ sha256, origin: "merged" });

describe("classifyPath", () => {
  test.each<[string, ClassifyInput, UpgradeClass]>([
    // row 2: no recorded entry
    [
      "row 2: new file, absent in project",
      { recorded: undefined, current: undefined, next: H1 },
      "add",
    ],
    [
      "row 3: new file, project already matches",
      { recorded: undefined, current: H1, next: H1 },
      "current",
    ],
    [
      "row 4: new file, project differs",
      { recorded: undefined, current: H2, next: H1 },
      "conflict-2way",
    ],
    // row 3a
    [
      "row 5: user deleted (emitted)",
      { recorded: emitted(H1), current: undefined, next: H2 },
      "user-deleted",
    ],
    [
      "row 5: user deleted (merged)",
      { recorded: merged(H1), current: undefined, next: H2 },
      "user-deleted",
    ],
    [
      "row 5: user deleted, next unchanged",
      { recorded: emitted(H1), current: undefined, next: H1 },
      "user-deleted",
    ],
    // row 3b
    [
      "row 6: all equal (emitted)",
      { recorded: emitted(H1), current: H1, next: H1 },
      "current",
    ],
    [
      "row 6: all equal (merged)",
      { recorded: merged(H1), current: H1, next: H1 },
      "current",
    ],
    [
      "row 6: current === next beats the emitted rows",
      { recorded: emitted(H1), current: H2, next: H2 },
      "current",
    ],
    [
      "row 6: current === next beats merged conflict",
      { recorded: merged(H1), current: H2, next: H2 },
      "current",
    ],
    // row 3c
    [
      "row 7: merged, current === recorded, next differs",
      { recorded: merged(H1), current: H1, next: H2 },
      "conflict-2way",
    ],
    [
      "row 7: merged, next === recorded, current differs",
      { recorded: merged(H1), current: H2, next: H1 },
      "conflict-2way",
    ],
    [
      "row 7: merged, all three differ",
      { recorded: merged(H1), current: H2, next: H3 },
      "conflict-2way",
    ],
    // row 3d
    [
      "row 8: emitted, upstream unchanged, user edited",
      { recorded: emitted(H1), current: H2, next: H1 },
      "local-only",
    ],
    // row 3e
    [
      "row 9: emitted, user untouched, upstream changed",
      { recorded: emitted(H1), current: H1, next: H2 },
      "safe-update",
    ],
    // row 3f
    [
      "row 10: emitted, all three differ",
      { recorded: emitted(H1), current: H2, next: H3 },
      "conflict-3way",
    ],
    // row 4
    [
      "row 11: removed upstream, already absent (emitted)",
      { recorded: emitted(H1), current: undefined, next: undefined },
      "gone",
    ],
    [
      "row 11: removed upstream, already absent (merged)",
      { recorded: merged(H1), current: undefined, next: undefined },
      "gone",
    ],
    [
      "row 12: removed upstream, merged, current === recorded",
      { recorded: merged(H1), current: H1, next: undefined },
      "orphan-edited",
    ],
    [
      "row 12: removed upstream, merged, current differs",
      { recorded: merged(H1), current: H2, next: undefined },
      "orphan-edited",
    ],
    [
      "row 13: removed upstream, emitted, untouched",
      { recorded: emitted(H1), current: H1, next: undefined },
      "remove",
    ],
    [
      "row 14: removed upstream, emitted, edited",
      { recorded: emitted(H1), current: H2, next: undefined },
      "orphan-edited",
    ],
  ])("%s", (_name, input, expected) => {
    expect(classifyPath(input)).toBe(expected);
  });

  test.each([undefined, H1])(
    "row 1: throws when recorded and next are both absent (current %s)",
    (current) => {
      expect(() =>
        classifyPath({ recorded: undefined, current, next: undefined }),
      ).toThrowError(/absent/i);
    },
  );

  test("both-absent is the only throwing shape", () => {
    const recs: (Recorded | undefined)[] = [undefined, emitted(H1), merged(H1)];
    const hashes: (string | undefined)[] = [undefined, H1, H2];
    for (const recorded of recs) {
      for (const current of hashes) {
        for (const next of hashes) {
          const input = { recorded, current, next };
          if (recorded === undefined && next === undefined) {
            expect(() => classifyPath(input)).toThrowError();
          } else {
            expect(() => classifyPath(input)).not.toThrowError();
          }
        }
      }
    }
  });

  test("the class union is the contract", () => {
    expectTypeOf<UpgradeClass>().toEqualTypeOf<
      | "current"
      | "local-only"
      | "safe-update"
      | "conflict-3way"
      | "add"
      | "conflict-2way"
      | "user-deleted"
      | "remove"
      | "orphan-edited"
      | "gone"
    >();
    expectTypeOf<UpgradeEntry>().toEqualTypeOf<{
      readonly path: string;
      readonly class: UpgradeClass;
    }>();
  });
});

describe("classifyAll", () => {
  test("classifies the union of recorded and next keys, once each", () => {
    const result = classifyAll({
      recorded: new Map([
        ["both", emitted(H1)],
        ["gone", emitted(H1)],
      ]),
      current: new Map([
        ["both", H1],
        ["gone", H1],
        ["new", H2],
      ]),
      next: new Map([
        ["both", H2],
        ["new", H2],
      ]),
    });
    expect(result).toEqual([
      { path: "both", class: "safe-update" },
      { path: "gone", class: "remove" },
      { path: "new", class: "current" },
    ]);
  });

  test("never lists a path that exists only in current", () => {
    const result = classifyAll({
      recorded: new Map(),
      current: new Map([["mine.txt", H1]]),
      next: new Map(),
    });
    expect(result).toEqual([]);
  });

  test("lists a path recorded, gone upstream and absent from the project as gone", () => {
    const result = classifyAll({
      recorded: new Map([["old.txt", emitted(H1)]]),
      current: new Map(),
      next: new Map(),
    });
    expect(result).toEqual([{ path: "old.txt", class: "gone" }]);
  });

  test("a path missing from current is looked up as absent", () => {
    const result = classifyAll({
      recorded: new Map([["a", emitted(H1)]]),
      current: new Map(),
      next: new Map([
        ["a", H2],
        ["b", H3],
      ]),
    });
    expect(result).toEqual([
      { path: "a", class: "user-deleted" },
      { path: "b", class: "add" },
    ]);
  });

  test("sorts by code-unit order, uppercase before lowercase, not locale", () => {
    const result = classifyAll({
      recorded: new Map(),
      current: new Map(),
      next: new Map([
        ["b", H1],
        ["a", H1],
        ["B", H1],
        ["A", H1],
        ["a/b", H1],
        ["a.b", H1],
      ]),
    });
    expect(result.map((e) => e.path)).toEqual([
      "A",
      "B",
      "a",
      "a.b",
      "a/b",
      "b",
    ]);
  });

  test("output order does not depend on input insertion order", () => {
    const keys = ["z", "m", "a", "Q"];
    const build = (order: string[]) =>
      classifyAll({
        recorded: new Map(),
        current: new Map(),
        next: new Map(order.map((k) => [k, H1] as const)),
      });
    expect(build(keys)).toEqual(build([...keys].reverse()));
  });

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "treats %s as an ordinary key",
    (name) => {
      const result = classifyAll({
        recorded: new Map([[name, emitted(H1)]]),
        current: new Map([[name, H1]]),
        next: new Map([[name, H2]]),
      });
      expect(result).toEqual([{ path: name, class: "safe-update" }]);
    },
  );

  test("a prototype-named path present only in next is an add", () => {
    const result = classifyAll({
      recorded: new Map(),
      current: new Map(),
      next: new Map([["__proto__", H1]]),
    });
    expect(result).toEqual([{ path: "__proto__", class: "add" }]);
  });

  test("does not mutate its inputs", () => {
    const recorded = new Map<string, Recorded>([["b", emitted(H1)]]);
    const current = new Map<string, string>([["b", H1]]);
    const next = new Map<string, string>([
      ["b", H2],
      ["a", H3],
    ]);
    const before = {
      recorded: [...recorded],
      current: [...current],
      next: [...next],
    };
    classifyAll({ recorded, current, next });
    expect([...recorded]).toEqual(before.recorded);
    expect([...current]).toEqual(before.current);
    expect([...next]).toEqual(before.next);
  });

  test("empty inputs yield an empty list", () => {
    expect(
      classifyAll({ recorded: new Map(), current: new Map(), next: new Map() }),
    ).toEqual([]);
  });
});
