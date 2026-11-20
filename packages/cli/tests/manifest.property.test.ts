// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for manifest.ts: hash stability under key order and
 * whitespace, serialize/parse round-trip, and rejection of every input that
 * carries a prototype-sensitive key.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  ManifestError,
  flattenJsonKeys,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "../src/manifest.js";

afterEach(() => {
  Reflect.deleteProperty(Object.prototype, "polluted");
});

const SENSITIVE = ["__proto__", "constructor", "prototype"] as const;

const safeKey = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((k) => !(SENSITIVE as readonly string[]).includes(k));

const jsonValue = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3 },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string({ maxLength: 8 }),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(safeKey, tie("value"), { maxKeys: 3 }),
  ),
})).value;

const jsonObject = fc.dictionary(safeKey, jsonValue, { maxKeys: 5 });

/** Reverses key order at every object level. */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reorder(v)] as const),
    );
  }
  return value;
}

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
const pathSegment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,6}$/);
const relPath = fc
  .array(pathSegment, { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join("/"));

const manifestArb: fc.Arbitrary<Manifest> = fc.record({
  schemaVersion: fc.constant(1 as const),
  cliVersion: fc.string({ maxLength: 10 }),
  tokens: fc.dictionary(safeKey, fc.string({ maxLength: 8 }), { maxKeys: 3 }),
  packs: fc.array(pathSegment, { maxLength: 3 }),
  files: fc.dictionary(
    relPath,
    fc.record({
      sha256: hex64,
      origin: fc.constantFrom("emitted" as const, "merged" as const),
    }),
    { maxKeys: 4 },
  ),
  jsonKeys: fc.dictionary(
    relPath,
    fc.dictionary(safeKey, hex64, { maxKeys: 3 }),
    { maxKeys: 3 },
  ),
});

describe("manifest properties", () => {
  it("flattenJsonKeys is invariant under key reordering", () => {
    fc.assert(
      fc.property(jsonObject, (value) => {
        expect(flattenJsonKeys(reorder(value))).toEqual(flattenJsonKeys(value));
      }),
    );
  });

  it("flattenJsonKeys is invariant under whitespace in the source text", () => {
    fc.assert(
      fc.property(jsonObject, (value) => {
        const compact = JSON.parse(JSON.stringify(value)) as unknown;
        const spaced = JSON.parse(
          JSON.stringify(value, null, 4).replace(/\n/g, "\r\n"),
        ) as unknown;
        expect(flattenJsonKeys(spaced)).toEqual(flattenJsonKeys(compact));
      }),
    );
  });

  it("parseManifest(serializeManifest(m)) deep-equals m", () => {
    fc.assert(
      fc.property(manifestArb, (manifest) => {
        expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
      }),
    );
  });

  it("serializeManifest is independent of insertion order", () => {
    fc.assert(
      fc.property(manifestArb, (manifest) => {
        expect(serializeManifest(reorder(manifest) as Manifest)).toBe(
          serializeManifest(manifest),
        );
      }),
    );
  });

  it("parseManifest never returns for input containing a prototype-sensitive key", () => {
    fc.assert(
      fc.property(
        manifestArb,
        fc.constantFrom(...SENSITIVE),
        fc.constantFrom("tokens", "files", "jsonKeys"),
        (manifest, key, where) => {
          const raw = JSON.parse(serializeManifest(manifest)) as Record<
            string,
            unknown
          >;
          // Build text by hand: JSON.stringify of an object literal would not
          // keep `__proto__` as an own key.
          const section = JSON.stringify(raw[where]);
          const member =
            where === "files"
              ? `"${key}":{"sha256":"${"a".repeat(64)}","origin":"emitted"}`
              : `"${key}":${where === "tokens" ? '"x"' : "{}"}`;
          const spliced =
            section === "{}"
              ? "{" + member + "}"
              : "{" + member + "," + section.slice(1);
          const text = JSON.stringify({ ...raw, [where]: "@@" }).replace(
            '"@@"',
            spliced,
          );
          expect(text).toContain(`"${key}"`);
          expect(() => parseManifest(text)).toThrow(ManifestError);
          expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
        },
      ),
    );
  });
});
