// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for the upgrade classifier: totality, the safety
 * of the destructive classes, and classifyAll's structural guarantees.
 */
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
  classifyAll,
  classifyPath,
  type Recorded,
  type UpgradeClass,
} from "../src/upgrade/classify.js";

const CLASSES: readonly UpgradeClass[] = [
  "current",
  "local-only",
  "safe-update",
  "conflict-3way",
  "add",
  "conflict-2way",
  "user-deleted",
  "remove",
  "orphan-edited",
];

const hash = fc.constantFrom("a", "b", "c", "d").map((c) => c.repeat(64));
const maybeHash = fc.option(hash, { nil: undefined });
const recordedArb = fc.option(
  fc.record({
    sha256: hash,
    origin: fc.constantFrom("emitted" as const, "merged" as const),
  }),
  { nil: undefined },
);
const triple = fc.record({
  recorded: recordedArb,
  current: maybeHash,
  next: maybeHash,
});
const classifiable = triple.filter(
  (t) => !(t.recorded === undefined && t.next === undefined),
);

describe("classifyPath properties", () => {
  test("is total except for the both-absent input", () => {
    fc.assert(
      fc.property(classifiable, (input) => {
        expect(CLASSES).toContain(classifyPath(input));
      }),
    );
  });

  test("safe-update and remove require an untouched emitted file", () => {
    fc.assert(
      fc.property(classifiable, (input) => {
        const cls = classifyPath(input);
        if (cls === "safe-update" || cls === "remove") {
          expect(input.recorded?.origin).toBe("emitted");
          expect(input.current).toBeDefined();
          expect(input.current).toBe(input.recorded?.sha256);
        }
      }),
    );
  });

  test("no safe-update when upstream is unchanged; no 3-way classes for merged", () => {
    fc.assert(
      fc.property(classifiable, (input) => {
        const cls = classifyPath(input);
        if (
          input.recorded !== undefined &&
          input.next === input.recorded.sha256
        ) {
          expect(cls).not.toBe("safe-update");
        }
        if (input.recorded?.origin === "merged") {
          expect(cls).not.toBe("local-only");
          expect(cls).not.toBe("safe-update");
          expect(cls).not.toBe("conflict-3way");
        }
      }),
    );
  });

  test("current iff the project matches the release or is correctly absent", () => {
    fc.assert(
      fc.property(classifiable, (input) => {
        const matches =
          input.current !== undefined && input.current === input.next;
        const bothAbsent =
          input.recorded !== undefined &&
          input.current === undefined &&
          input.next === undefined;
        expect(classifyPath(input) === "current").toBe(matches || bothAbsent);
      }),
    );
  });
});

describe("classifyAll properties", () => {
  const pathArb = fc.constantFrom(
    "a",
    "B",
    "c/d",
    "__proto__",
    "constructor",
    ".claude/x.md",
    "Z",
  );
  const rowsArb = fc.uniqueArray(fc.tuple(pathArb, triple), {
    selector: ([p]) => p,
    maxLength: 7,
  });

  test("is deterministic, sorted, one entry per path of recorded and next, each matching classifyPath", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const recorded = new Map<string, Recorded>();
        const current = new Map<string, string>();
        const next = new Map<string, string>();
        for (const [p, t] of rows) {
          if (t.recorded) recorded.set(p, t.recorded);
          if (t.current) current.set(p, t.current);
          if (t.next) next.set(p, t.next);
        }
        const result = classifyAll({ recorded, current, next });
        expect(classifyAll({ recorded, current, next })).toEqual(result);

        const expectedRows = rows
          .filter(([, t]) => t.recorded !== undefined || t.next !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        expect(result).toHaveLength(expectedRows.length);
        expect(result.map((e) => e.path)).toEqual(expectedRows.map(([p]) => p));
        expectedRows.forEach(([, t], i) => {
          expect(result[i]?.class).toBe(classifyPath(t));
        });
      }),
    );
  });
});
