// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `mergeJson3(base, ours, theirs)` and `mergeJsonText(baseText, oursText,
 * theirsText)`: the three-way JSON merge of the update flow.
 */
import { describe, expect, it } from "vitest";
import { mergeJson3, mergeJsonText } from "../src/merge-json3.js";

describe("mergeJson3", () => {
  it("takes ours when ours and theirs agree", () => {
    expect(mergeJson3({ a: 1 }, { a: 2 }, { a: 2 })).toEqual({
      value: { a: 2 },
      conflicts: [],
    });
  });

  it("takes theirs for a key only theirs changed", () => {
    expect(mergeJson3({ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1, b: 2 })).toEqual({
      value: { a: 1, b: 2 },
      conflicts: [],
    });
  });

  it("keeps ours for a key only ours changed", () => {
    expect(mergeJson3({ a: 1, b: 1 }, { a: 5, b: 1 }, { a: 1, b: 1 })).toEqual({
      value: { a: 5, b: 1 },
      conflicts: [],
    });
  });

  it("merges independent changes to different keys", () => {
    const result = mergeJson3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 });
    expect(result).toEqual({ value: { a: 2, b: 3 }, conflicts: [] });
  });

  it("recurses into nested objects and reports a nested conflict as a JSON pointer, keeping ours", () => {
    const base = { devDependencies: { vitest: "1", tsx: "1" } };
    const ours = { devDependencies: { vitest: "2", tsx: "1" } };
    const theirs = { devDependencies: { vitest: "3", tsx: "2" } };
    expect(mergeJson3(base, ours, theirs)).toEqual({
      value: { devDependencies: { vitest: "2", tsx: "2" } },
      conflicts: ["/devDependencies/vitest"],
    });
  });

  it("treats a key absent on one side as a deletion", () => {
    // theirs deleted b, ours left it: the deletion wins
    expect(mergeJson3({ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1 })).toEqual({
      value: { a: 1 },
      conflicts: [],
    });
    // ours deleted b, theirs changed it: conflict, value keeps ours (absent)
    expect(mergeJson3({ a: 1, b: 1 }, { a: 1 }, { a: 1, b: 2 })).toEqual({
      value: { a: 1 },
      conflicts: ["/b"],
    });
  });

  it("adds a key only theirs has and a key only ours has", () => {
    expect(mergeJson3({}, { x: 1 }, { y: 2 })).toEqual({
      value: { x: 1, y: 2 },
      conflicts: [],
    });
  });

  it("treats arrays as whole values", () => {
    expect(mergeJson3({ l: [1] }, { l: [1, 2] }, { l: [1, 3] })).toEqual({
      value: { l: [1, 2] },
      conflicts: ["/l"],
    });
    expect(mergeJson3({ l: [1] }, { l: [1] }, { l: [1, 3] })).toEqual({
      value: { l: [1, 3] },
      conflicts: [],
    });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "throws on the prototype-sensitive key %s on any side, at any level",
    (key) => {
      const bad = JSON.parse(`{"${key}": 1}`) as unknown;
      const nested = { a: bad };
      expect(() => mergeJson3({}, {}, bad)).toThrow(Error);
      expect(() => mergeJson3({}, bad, {})).toThrow(Error);
      expect(() => mergeJson3(bad, {}, {})).toThrow(Error);
      expect(() => mergeJson3({ a: {} }, { a: {} }, nested)).toThrow(Error);
    },
  );
});

describe("mergeJsonText", () => {
  const text = (value: unknown, indent: string | number = 2): string =>
    `${JSON.stringify(value, null, indent)}\n`;

  it("merges and re-serializes with ours' two-space indent and trailing newline", () => {
    const result = mergeJsonText(
      text({ a: 1, b: 1 }),
      text({ a: 2, b: 1 }),
      text({ a: 1, b: 3 }),
    );
    expect(result).toEqual({ text: text({ a: 2, b: 3 }), conflicts: [] });
  });

  it("reuses a four-space indent", () => {
    const result = mergeJsonText(
      text({ a: 1, b: 1 }, 4),
      text({ a: 2, b: 1 }, 4),
      text({ a: 1, b: 3 }, 4),
    );
    expect(result).toEqual({ text: text({ a: 2, b: 3 }, 4), conflicts: [] });
  });

  it("reuses a tab indent", () => {
    const result = mergeJsonText(
      text({ a: 1, b: 1 }, "\t"),
      text({ a: 2, b: 1 }, "\t"),
      text({ a: 1, b: 3 }, "\t"),
    );
    expect(result).toEqual({
      text: text({ a: 2, b: 3 }, "\t"),
      conflicts: [],
    });
  });

  it("omits the trailing newline when ours has none", () => {
    const result = mergeJsonText(
      JSON.stringify({ a: 1, b: 1 }, null, 2),
      JSON.stringify({ a: 2, b: 1 }, null, 2),
      JSON.stringify({ a: 1, b: 3 }, null, 2),
    );
    expect(result).toEqual({
      text: JSON.stringify({ a: 2, b: 3 }, null, 2),
      conflicts: [],
    });
  });

  it("orders keys by ours and inserts theirs-only keys after their predecessor in theirs", () => {
    const result = mergeJsonText(
      text({ a: 1, c: 3 }),
      text({ c: 3, a: 1, x: 9 }),
      text({ a: 1, b: 2, c: 3 }),
    );
    expect(result).toMatchObject({ conflicts: [] });
    const merged = result as { text: string };
    expect(Object.keys(JSON.parse(merged.text) as object)).toEqual([
      "c",
      "a",
      "b",
      "x",
    ]);
  });

  it("returns theirs' exact text when the merge equals theirs", () => {
    const theirs = '{ "a": 2,\n  "b": 1 }\n';
    const result = mergeJsonText(text({ a: 1, b: 1 }), '{"a":1,"b":1}', theirs);
    expect(result).toEqual({ text: theirs, conflicts: [] });
  });

  it("returns ours' exact text when the merge equals ours", () => {
    const ours = '{ "a": 2,\n  "b": 1 }\n';
    const result = mergeJsonText(
      text({ a: 1, b: 1 }),
      ours,
      text({ a: 1, b: 1 }),
    );
    expect(result).toEqual({ text: ours, conflicts: [] });
  });

  it("reports conflicts and keeps ours' value", () => {
    const result = mergeJsonText(
      text({ a: 1 }),
      text({ a: 2 }),
      text({ a: 3 }),
    );
    expect(result).toEqual({ text: text({ a: 2 }), conflicts: ["/a"] });
  });

  it.each([
    ["a comment in ours", '{ // c\n "a": 1 }', text({ a: 1 }), text({ a: 1 })],
    [
      "a comment in theirs",
      text({ a: 1 }),
      text({ a: 1 }),
      '{ /* c */ "a": 2 }',
    ],
    ["a trailing comma in base", '{ "a": 1, }', text({ a: 1 }), text({ a: 2 })],
    ["unparseable ours", text({ a: 1 }), "{ not json", text({ a: 2 })],
  ])("is unmergeable for %s", (_name, base, ours, theirs) => {
    const result = mergeJsonText(base, ours, theirs);
    expect(result).toHaveProperty("unmergeable");
    expect(typeof (result as { unmergeable: string }).unmergeable).toBe(
      "string",
    );
  });

  it.each([
    ["base", ['{"secret-marker-123": nope', '{"a":1}', '{"a":2}']],
    ["ours", ['{"a":1}', '{"secret-marker-123": nope', '{"a":2}']],
    ["theirs", ['{"a":1}', '{"a":1}', '{"secret-marker-123": nope']],
  ] as const)(
    "an unparsable %s gives a fixed reason that never embeds the input",
    (_side, [base, ours, theirs]) => {
      const result = mergeJsonText(base, ours, theirs);
      expect(result).toHaveProperty("unmergeable");
      const { unmergeable } = result as { unmergeable: string };
      expect(unmergeable).not.toContain("secret-marker-123");
      expect(unmergeable).not.toContain("nope");
    },
  );
});
