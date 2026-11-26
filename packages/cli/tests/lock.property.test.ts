// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/** Property tests for `lock.ts`: serialize/parse round trip and layout. */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { buildLock, parseLock, serializeLock } from "../src/lock.js";
import type { LockFile } from "../src/lock.js";

const segment = fc
  .stringMatching(/^[a-z0-9][a-z0-9._-]{0,7}$/)
  .filter((s) => s !== "." && s !== "..");
const pathArb = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));
const sha = fc.stringMatching(/^[0-9a-f]{64}$/);
const sourceArb = fc.oneof(
  fc.constant("core"),
  fc.constant("skill"),
  segment.map((n) => `pack:${n}`),
);
const fileArb: fc.Arbitrary<LockFile> = fc.record({
  path: pathArb,
  source: sourceArb,
  baseSha256: fc.oneof(sha, fc.constant(null)),
  status: fc.constantFrom("installed", "kept", "declined", "removed"),
});

const lockArb = fc
  .record({
    files: fc.uniqueArray(fileArb, { selector: (f) => f.path, maxLength: 12 }),
    skip: fc.uniqueArray(pathArb, { maxLength: 4 }),
    tokens: fc.dictionary(
      fc.stringMatching(/^[A-Z_]{1,10}$/),
      fc.string({ maxLength: 12 }),
    ),
    baseVersion: fc.stringMatching(/^[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}$/),
  })
  .map(({ files, skip, tokens, baseVersion }) =>
    buildLock({
      baseVersion,
      origin: "fresh",
      tokens,
      via: "fresh",
      updatedAt: "2026-11-26T00:00:00.000Z",
      skip,
      files,
    }),
  );

describe("lock properties", () => {
  it("parseLock(serializeLock(l)) equals l", () => {
    fc.assert(
      fc.property(lockArb, (lock) => {
        expect(parseLock(serializeLock(lock))).toEqual(lock);
      }),
    );
  });

  it("serialization ends in one newline and is stable across a round trip", () => {
    fc.assert(
      fc.property(lockArb, (lock) => {
        const text = serializeLock(lock);
        expect(text.endsWith("}\n")).toBe(true);
        expect(serializeLock(parseLock(text))).toBe(text);
      }),
    );
  });

  it("buildLock output is sorted by path regardless of input order", () => {
    fc.assert(
      fc.property(lockArb, (lock) => {
        const paths = lock.files.map((f) => f.path);
        expect(paths).toEqual([...paths].sort());
      }),
    );
  });

  it("no serialized line holds both a path key and a 64-hex digest", () => {
    fc.assert(
      fc.property(lockArb, (lock) => {
        for (const line of serializeLock(lock).split("\n")) {
          expect(line.includes('"path"') && /[0-9a-f]{64}/.test(line)).toBe(
            false,
          );
        }
      }),
    );
  });
});
