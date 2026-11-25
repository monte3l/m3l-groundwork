// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property tests for the template-history data format: the generator's
 * serializer (bin/lib/template-history.mjs) is deterministic, sorts every
 * key, and its output round-trips through the loader's strict parser.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { parseTemplateHistory } from "../src/template-history.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface HistoryLib {
  serializeTemplateHistory(history: unknown): string;
  checkTemplateHistory(options: {
    text: string;
    changelogText: string;
    currentVersion: string;
  }): string[];
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "template-history.mjs")).href
)) as HistoryLib;

const hash = fc.stringMatching(/^[0-9a-f]{64}$/);
const projectPath = fc.stringMatching(/^[a-z]{1,5}(\/[a-z.]{1,5}){0,2}$/);
const files = fc.dictionary(projectPath, hash, { maxKeys: 5 });
const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
// Each pack manifest is generated as its blob text; the history derives the
// hash (the blob's key) from it, so every manifest hash has a blob.
const packs = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,6}$/),
  fc.record({ manifestText: fc.string({ maxLength: 20 }), files }),
  { maxKeys: 3 },
);
const version = fc
  .tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }))
  .map(([a, b, c]) => `${String(a)}.${String(b)}.${String(c)}`);
const versions = fc.dictionary(version, fc.record({ core: files, packs }), {
  maxKeys: 4,
});
const extraBlobs = fc
  .array(fc.string({ maxLength: 20 }), { maxLength: 4 })
  .map((texts) => Object.fromEntries(texts.map((text) => [sha(text), text])));
const history = fc
  .record({ versions, extraBlobs })
  .map(({ versions: generated, extraBlobs: extra }) => {
    const blobs: Record<string, string> = { ...extra };
    const resolved = Object.fromEntries(
      Object.entries(generated).map(([ver, entry]) => [
        ver,
        {
          core: entry.core,
          packs: Object.fromEntries(
            Object.entries(entry.packs).map(([name, pack]) => {
              blobs[sha(pack.manifestText)] = pack.manifestText;
              return [
                name,
                { manifest: sha(pack.manifestText), files: pack.files },
              ];
            }),
          ),
        },
      ]),
    );
    return { schemaVersion: 1, versions: resolved, blobs };
  });

function keysSortedDeep(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  return (
    keys.every((key, index) => key === sorted[index]) &&
    Object.values(value).every(keysSortedDeep)
  );
}

describe("serializeTemplateHistory (property)", () => {
  it("sorts every key and ends with a newline", () => {
    fc.assert(
      fc.property(history, (h) => {
        const text = lib.serializeTemplateHistory(h);
        expect(text.endsWith("\n")).toBe(true);
        expect(keysSortedDeep(JSON.parse(text))).toBe(true);
      }),
    );
  });

  it("is idempotent: serializing the parsed output reproduces it byte for byte", () => {
    fc.assert(
      fc.property(history, (h) => {
        const text = lib.serializeTemplateHistory(h);
        expect(lib.serializeTemplateHistory(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it("does not depend on key insertion order", () => {
    fc.assert(
      fc.property(history, (h) => {
        const reversed = {
          blobs: Object.fromEntries(Object.entries(h.blobs).reverse()),
          versions: Object.fromEntries(Object.entries(h.versions).reverse()),
          schemaVersion: h.schemaVersion,
        };
        expect(lib.serializeTemplateHistory(reversed)).toBe(
          lib.serializeTemplateHistory(h),
        );
      }),
    );
  });

  it("round-trips through the loader's strict parser without losing content", () => {
    fc.assert(
      fc.property(history, (h) => {
        const text = lib.serializeTemplateHistory(h);
        expect(parseTemplateHistory(text)).toEqual(h);
      }),
    );
  });

  it("passes its own check when the changelog lists nothing", () => {
    fc.assert(
      fc.property(history, (h) => {
        expect(
          lib.checkTemplateHistory({
            text: lib.serializeTemplateHistory(h),
            changelogText: "",
            currentVersion: "99.0.0",
          }),
        ).toEqual([]);
      }),
    );
  });
});
