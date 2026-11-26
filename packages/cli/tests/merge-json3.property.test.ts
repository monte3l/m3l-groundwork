// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for merge-json3.ts: the identities of a
 * three-way merge over fuzzed JSON values.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mergeJson3 } from "../src/merge-json3.js";

// A small key alphabet makes the three sides collide often. It excludes
// the prototype-sensitive keys.
const keyArb = fc.constantFrom("a", "b", "c", "d");
const { json } = fc.letrec<{ json: unknown }>((tie) => ({
  json: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.integer({ min: 0, max: 3 }),
    fc.constantFrom("x", "y"),
    fc.constant(null),
    fc.array(tie("json"), { maxLength: 2 }),
    fc.dictionary(keyArb, tie("json"), { maxKeys: 4 }),
  ),
}));
const objectArb = fc.dictionary(keyArb, json, { maxKeys: 4 });

function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([x], [y]) => x.localeCompare(y)),
        )
      : v,
  );
}

function at(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.split("/").slice(1)) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

describe("mergeJson3 properties", () => {
  it("merge(b, b, t) = t with no conflicts", () => {
    fc.assert(
      fc.property(objectArb, objectArb, (b, t) => {
        const r = mergeJson3(b, b, t);
        expect(canon(r.value)).toBe(canon(t));
        expect(r.conflicts).toEqual([]);
      }),
    );
  });

  it("merge(b, o, b) = o with no conflicts", () => {
    fc.assert(
      fc.property(objectArb, objectArb, (b, o) => {
        const r = mergeJson3(b, o, b);
        expect(canon(r.value)).toBe(canon(o));
        expect(r.conflicts).toEqual([]);
      }),
    );
  });

  it("merge(b, x, x) = x with no conflicts", () => {
    fc.assert(
      fc.property(objectArb, objectArb, (b, x) => {
        const r = mergeJson3(b, x, x);
        expect(canon(r.value)).toBe(canon(x));
        expect(r.conflicts).toEqual([]);
      }),
    );
  });

  it("every conflict pointer was changed from base on both sides", () => {
    fc.assert(
      fc.property(objectArb, objectArb, objectArb, (b, o, t) => {
        for (const pointer of mergeJson3(b, o, t).conflicts) {
          expect(canon(at(o, pointer))).not.toBe(canon(at(b, pointer)));
          expect(canon(at(t, pointer))).not.toBe(canon(at(b, pointer)));
        }
      }),
    );
  });

  it("rejects a prototype-sensitive key anywhere", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("__proto__", "constructor", "prototype"),
        objectArb,
        fc.constantFrom(0, 1, 2),
        (key, rest, side) => {
          const bad = JSON.parse(`{"${key}": 1}`) as Record<string, unknown>;
          const sides: unknown[] = [rest, rest, rest];
          sides[side] = { a: bad };
          expect(() => mergeJson3(sides[0], sides[1], sides[2])).toThrow(Error);
        },
      ),
    );
  });
});
