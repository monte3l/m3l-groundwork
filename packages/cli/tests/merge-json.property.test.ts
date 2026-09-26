// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for merge-json.ts -- see SECURITY.md's "Dynamic
 * analysis" section. merge-json.test.ts keeps the example-based cases
 * (including the collision paths); this file adds fuzzed idempotence and
 * no-collision invariants over disjoint key sets alongside it, per the
 * module's own doc comment: "Every merge is ... idempotent (merging the same
 * fragment twice produces the same result as merging it once)."
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  mergePackageScripts,
  mergeSettingsHooks,
  mergeSettingsTopLevel,
  mergeVerifySteps,
} from "../src/merge-json.js";
import type { VerifyStepAddition } from "../src/merge-json.js";

// Names that collide with inherited Object.prototype members (`toString`,
// `valueOf`, ...) are in the domain -- every merge reads presence with
// Object.hasOwn, so they must behave like any other key. A plain
// alphanumeric generator could in principle produce one of these names, but
// at astronomically low odds; mixing them in explicitly at low relative
// weight makes that claim literally true without letting them dominate
// every run.
const keyArb = fc.oneof(
  { weight: 9, arbitrary: fc.stringMatching(/^[A-Za-z0-9]{1,10}$/) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "toString",
      "valueOf",
      "constructor",
      "hasOwnProperty",
      "isPrototypeOf",
    ),
  },
);

const jsonPrimitiveArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/**
 * A record whose keys never overlap `fragment`'s keys, so `mergeSettingsTopLevel`
 * never hits its collision branch -- every fragment key is genuinely new.
 * "hooks" is excluded from both sides: it is `mergeSettingsTopLevel`'s own
 * documented rejection, not a collision this property is about.
 */
const disjointTopLevelArb = fc
  .tuple(
    fc.dictionary(keyArb, jsonPrimitiveArb, { maxKeys: 6 }),
    fc.dictionary(keyArb, jsonPrimitiveArb, { minKeys: 1, maxKeys: 6 }),
  )
  .filter(
    ([existing, fragment]) =>
      !Object.hasOwn(fragment, "hooks") &&
      !Object.hasOwn(existing, "hooks") &&
      !Object.keys(fragment).some((key) => Object.hasOwn(existing, key)),
  );

describe("mergeSettingsTopLevel", () => {
  it("is idempotent for disjoint existing/fragment key sets and never throws", () => {
    fc.assert(
      fc.property(disjointTopLevelArb, ([existing, fragment]) => {
        const once = mergeSettingsTopLevel(existing, fragment);
        const twice = mergeSettingsTopLevel(once, fragment);
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});

const disjointScriptsArb = fc
  .tuple(
    fc.dictionary(keyArb, fc.string(), { maxKeys: 6 }),
    fc.dictionary(keyArb, fc.string(), { minKeys: 1, maxKeys: 6 }),
  )
  .filter(
    ([existing, additions]) =>
      !Object.keys(additions).some((key) => Object.hasOwn(existing, key)),
  );

describe("mergePackageScripts", () => {
  it("never reports a collision when additions and existing keys are disjoint", () => {
    fc.assert(
      fc.property(disjointScriptsArb, ([existing, additions]) => {
        const { collisions } = mergePackageScripts(existing, additions);
        expect(collisions).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("is idempotent for disjoint existing/additions key sets and never throws", () => {
    fc.assert(
      fc.property(disjointScriptsArb, ([existing, additions]) => {
        const once = mergePackageScripts(existing, additions);
        const twice = mergePackageScripts(once.scripts, additions);
        expect(twice.scripts).toEqual(once.scripts);
        expect(twice.collisions).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  // Regression: found by the property test above shrinking to this exact
  // input. Bracket access (`scripts[name]`) once resolved an addition named
  // after an inherited Object.prototype member (e.g. "toString") to that
  // inherited function rather than "absent", reporting a false collision.
  it("does not report a false collision for an addition named after an inherited Object.prototype member", () => {
    const { collisions, scripts } = mergePackageScripts(
      {},
      { toString: "custom-script" },
    );
    expect(collisions).toEqual([]);
    // Read via getOwnPropertyDescriptor, not bracket access: `scripts["toString"]`
    // resolves at the TYPE level to the inherited Object.prototype method
    // regardless of what is actually stored at runtime.
    expect(Object.hasOwn(scripts, "toString")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(scripts, "toString")?.value).toBe(
      "custom-script",
    );
  });
});

const verifyStepArb: fc.Arbitrary<VerifyStepAddition> = fc.record({
  id: keyArb,
  group: keyArb,
  name: fc.string(),
  cmd: fc.array(fc.string(), { minLength: 1, maxLength: 4 }),
});

const uniqueIdStepsArb = fc.uniqueArray(verifyStepArb, {
  selector: (step) => step.id,
  maxLength: 8,
});

describe("mergeVerifySteps", () => {
  it("is idempotent for an arbitrary list of steps with unique ids, and never throws", () => {
    fc.assert(
      fc.property(uniqueIdStepsArb, (steps) => {
        const once = mergeVerifySteps(undefined, steps);
        const twice = mergeVerifySteps(once, steps);
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});

const prototypeKeyArb = fc.constantFrom(
  "__proto__",
  "constructor",
  "prototype",
);

describe("prototype pollution resistance (issue #48)", () => {
  it("never alters [[Prototype]] in mergeSettingsTopLevel when key is __proto__, constructor, or prototype", () => {
    fc.assert(
      fc.property(prototypeKeyArb, jsonPrimitiveArb, (key, value) => {
        const fragment: Record<string, unknown> = {};
        Object.defineProperty(fragment, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        const merged = mergeSettingsTopLevel({}, fragment);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        expect(Object.hasOwn(merged, key)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(merged, key)?.value).toBe(value);
      }),
      { numRuns: 100 },
    );
  });

  it("never alters [[Prototype]] in mergePackageScripts when script name is __proto__, constructor, or prototype", () => {
    fc.assert(
      fc.property(prototypeKeyArb, fc.string(), (name, cmd) => {
        const additions: Record<string, string> = {};
        Object.defineProperty(additions, name, {
          value: cmd,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        const { scripts, collisions } = mergePackageScripts({}, additions);
        expect(Object.getPrototypeOf(scripts)).toBe(Object.prototype);
        expect(collisions).toEqual([]);
        expect(Object.hasOwn(scripts, name)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(scripts, name)?.value).toBe(cmd);
      }),
      { numRuns: 100 },
    );
  });

  it("never alters [[Prototype]] in mergeSettingsHooks when event name is __proto__, constructor, or prototype", () => {
    fc.assert(
      fc.property(prototypeKeyArb, fc.string(), (event, cmd) => {
        const fragment: Record<string, unknown> = {};
        const entries = [{ hooks: [{ type: "command", command: cmd }] }];
        Object.defineProperty(fragment, event, {
          value: entries,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        const merged = mergeSettingsHooks(
          {},
          fragment as unknown as Parameters<typeof mergeSettingsHooks>[1],
        );
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        const hooks = merged["hooks"] as Record<string, unknown>;
        expect(Object.getPrototypeOf(hooks)).toBe(Object.prototype);
        expect(Object.hasOwn(hooks, event)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
