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
import { afterEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  mergePackageScripts,
  mergeSettingsHooks,
  mergeSettingsTopLevel,
  mergeVerifySteps,
} from "../src/merge-json.js";
import type { VerifyStepAddition } from "../src/merge-json.js";

// The three keys the merge guard rejects outright (CWE-1321). Defined here,
// ahead of `keyArb`, because `keyArb` must exclude all three -- not just
// `constructor` -- from both its explicit list AND its random alphanumeric
// branch: `prototype` is 9 characters of plain letters, squarely inside
// `/^[A-Za-z0-9]{1,10}$/`'s domain, so it CAN surface from the random branch
// on an unlucky seed (confirmed: it did, under `pnpm test:coverage`'s
// different seed, shrinking a "never throws" property down to exactly
// `{ prototype: "" }`). `__proto__` cannot match that regex (it contains
// underscores), so only `constructor` and `prototype` need the `.filter()`
// below in practice, but filtering all three keeps this list the single
// source of truth rather than something a future edit could re-desync.
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// Names that collide with inherited Object.prototype members (`toString`,
// `valueOf`, ...) are in the domain -- every merge reads presence with
// Object.hasOwn, so they must behave like any other key. A plain
// alphanumeric generator could in principle produce one of these names, but
// at astronomically low odds; mixing them in explicitly at low relative
// weight makes that claim literally true without letting them dominate every
// run. None of `DANGEROUS_KEYS` is mixed in here, and the random branch
// filters them out too: they are now rejected outright by the merge guard
// (CWE-1321), so including them would make these disjoint-key "never throws"
// properties false for the right reason rather than a wrong one. Their
// rejection is covered by the dedicated `dangerousKeyArb` properties below
// instead.
const keyArb = fc.oneof(
  {
    weight: 9,
    arbitrary: fc
      .stringMatching(/^[A-Za-z0-9]{1,10}$/)
      .filter((key) => !DANGEROUS_KEYS.has(key)),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "toString",
      "valueOf",
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

/**
 * Dedicated low-cardinality arbitrary over `DANGEROUS_KEYS` -- NOT folded
 * into `keyArb` above, since `keyArb` backs the *disjoint*-key idempotence
 * properties, which assert the functions never throw. Mixing a dangerous key
 * in there would make those properties false (a dangerous key must now
 * throw) rather than exercising a different, dedicated guarantee.
 */
const dangerousKeyArb = fc.constantFrom(...DANGEROUS_KEYS);

/**
 * Builds an object whose OWN key is literally `key`, via JSON.parse. Object
 * literal syntax (`{ [key]: value }` with a computed key is safe, but the
 * un-computed `{ __proto__: value }` and bracket assignment
 * `obj["__proto__"] = value` both invoke the Annex B exotic setter on
 * Object.prototype instead of creating a data property) -- JSON.parse never
 * does, matching how a real pack fragment reaches these functions after
 * being read off disk.
 */
function buildOwnKeyRecord<T>(key: string, value: T): Record<string, T> {
  return JSON.parse(`{"${key}":${JSON.stringify(value)}}`) as Record<string, T>;
}

describe("prototype-pollution guard (CWE-1321)", () => {
  afterEach(() => {
    // See merge-json.test.ts's identical afterEach: `not.toHaveProperty`
    // can't prove own-key absence, so an unconditional cleanup is required
    // regardless of which property run (if any) actually polluted it.
    Reflect.deleteProperty(Object.prototype, "polluted");
  });

  it("mergeSettingsTopLevel throws naming the key for any dangerous fragment key, and never pollutes Object.prototype", () => {
    fc.assert(
      fc.property(dangerousKeyArb, jsonPrimitiveArb, (key, value) => {
        const fragment = buildOwnKeyRecord(key, value);
        expect(() => mergeSettingsTopLevel({}, fragment)).toThrow(key);
        expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it("mergeSettingsHooks throws naming the key for any dangerous fragment event key, and never pollutes Object.prototype", () => {
    fc.assert(
      fc.property(dangerousKeyArb, (key) => {
        const fragment = buildOwnKeyRecord(key, [
          { hooks: [{ type: "command", command: "node x.mjs" }] },
        ]);
        expect(() => mergeSettingsHooks({}, fragment)).toThrow(key);
        expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it("mergePackageScripts throws naming the key for any dangerous addition name, and never pollutes Object.prototype", () => {
    fc.assert(
      fc.property(dangerousKeyArb, fc.string(), (key, cmd) => {
        const additions = buildOwnKeyRecord(key, cmd);
        expect(() => mergePackageScripts({}, additions)).toThrow(key);
        expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});
