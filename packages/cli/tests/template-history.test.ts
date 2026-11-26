// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The template-history loader (update flow, PR 2): the strict parser, the
 * never-throwing file loader, the per-pack lookup, and the committed data
 * file the package ships. Fixtures are temp-dir files and literal objects.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateHistoryPath } from "../src/assets.js";
import {
  TEMPLATE_HISTORY_SCHEMA_VERSION,
  loadTemplateHistory,
  packHashesAt,
  parseTemplateHistory,
} from "../src/template-history.js";
import type { TemplateHistory } from "../src/template-history.js";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

const VALID: TemplateHistory = {
  schemaVersion: 1,
  versions: {
    "1.0.0": {
      core: { "package.json": H1, ".gitignore": H2 },
      packs: { quality: { manifest: H3, files: { "a.txt": H1 } } },
    },
  },
  blobs: { [H1]: "hello __YEAR__" },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "template-history-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("TEMPLATE_HISTORY_SCHEMA_VERSION", () => {
  it("is 1", () => {
    expect(TEMPLATE_HISTORY_SCHEMA_VERSION).toBe(1);
  });
});

describe("parseTemplateHistory", () => {
  it("parses a valid history and keeps its content", () => {
    expect(parseTemplateHistory(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("accepts an empty history", () => {
    const empty = { schemaVersion: 1, versions: {}, blobs: {} };
    expect(parseTemplateHistory(JSON.stringify(empty))).toEqual(empty);
  });

  it("does not require sorted keys", () => {
    const text = `{"blobs":{},"versions":{},"schemaVersion":1}`;
    expect(() => parseTemplateHistory(text)).not.toThrow();
  });

  it("returns the TemplateHistory type", () => {
    expectTypeOf(parseTemplateHistory).returns.toEqualTypeOf<TemplateHistory>();
  });

  it.each([
    ["malformed JSON", "{ nope"],
    ["an empty string", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "7"],
    ["a wrong schemaVersion", JSON.stringify({ ...VALID, schemaVersion: 2 })],
    ["a missing schemaVersion", JSON.stringify({ versions: {}, blobs: {} })],
    ["a missing versions", JSON.stringify({ schemaVersion: 1, blobs: {} })],
    ["a missing blobs", JSON.stringify({ schemaVersion: 1, versions: {} })],
    [
      "versions that is an array",
      JSON.stringify({ schemaVersion: 1, versions: [], blobs: {} }),
    ],
    [
      "a version without core",
      JSON.stringify({
        schemaVersion: 1,
        versions: { "1.0.0": { packs: {} } },
        blobs: {},
      }),
    ],
    [
      "a version without packs",
      JSON.stringify({
        schemaVersion: 1,
        versions: { "1.0.0": { core: {} } },
        blobs: {},
      }),
    ],
    [
      "a pack without a manifest hash",
      JSON.stringify({
        schemaVersion: 1,
        versions: { "1.0.0": { core: {}, packs: { q: { files: {} } } } },
        blobs: {},
      }),
    ],
    [
      "a pack without files",
      JSON.stringify({
        schemaVersion: 1,
        versions: { "1.0.0": { core: {}, packs: { q: { manifest: H1 } } } },
        blobs: {},
      }),
    ],
    [
      "a non-hex core hash",
      JSON.stringify({
        schemaVersion: 1,
        versions: { "1.0.0": { core: { "a.txt": "z".repeat(64) }, packs: {} } },
        blobs: {},
      }),
    ],
    [
      "a non-string core hash",
      JSON.stringify({
        schemaVersion: 1,
        versions: { "1.0.0": { core: { "a.txt": 5 }, packs: {} } },
        blobs: {},
      }),
    ],
    [
      "a non-hex pack manifest hash",
      JSON.stringify({
        schemaVersion: 1,
        versions: {
          "1.0.0": {
            core: {},
            packs: { q: { manifest: "nothex", files: {} } },
          },
        },
        blobs: {},
      }),
    ],
    [
      "a non-hex pack file hash",
      JSON.stringify({
        schemaVersion: 1,
        versions: {
          "1.0.0": {
            core: {},
            packs: { q: { manifest: H1, files: { "a.txt": "g".repeat(64) } } },
          },
        },
        blobs: {},
      }),
    ],
    [
      "a non-hex blob key",
      JSON.stringify({
        schemaVersion: 1,
        versions: {},
        blobs: { nothex: "x" },
      }),
    ],
    [
      "a non-string blob text",
      JSON.stringify({ schemaVersion: 1, versions: {}, blobs: { [H1]: 5 } }),
    ],
  ])("throws an Error with a message for %s", (_label, text) => {
    expect(() => parseTemplateHistory(text)).toThrow(Error);
    expect(() => parseTemplateHistory(text)).toThrow(/.+/);
  });

  it.each([
    [
      "versions",
      `{"schemaVersion":1,"versions":{"__proto__":{"core":{},"packs":{}}},"blobs":{}}`,
    ],
    [
      "core",
      `{"schemaVersion":1,"versions":{"1.0.0":{"core":{"constructor":"${H1}"},"packs":{}}},"blobs":{}}`,
    ],
    [
      "packs",
      `{"schemaVersion":1,"versions":{"1.0.0":{"core":{},"packs":{"prototype":{"manifest":"${H1}","files":{}}}}},"blobs":{}}`,
    ],
    [
      "pack files",
      `{"schemaVersion":1,"versions":{"1.0.0":{"core":{},"packs":{"q":{"manifest":"${H1}","files":{"__proto__":"${H1}"}}}}},"blobs":{}}`,
    ],
    ["blobs", `{"schemaVersion":1,"versions":{},"blobs":{"__proto__":"x"}}`],
  ])("rejects a prototype-sensitive key in %s", (_label, text) => {
    expect(() => parseTemplateHistory(text)).toThrow(Error);
  });
});

describe("loadTemplateHistory", () => {
  it("returns the history of a valid file", () => {
    const path = join(root, "history.json");
    writeFileSync(path, JSON.stringify(VALID));
    expect(loadTemplateHistory(path)).toEqual({ history: VALID });
  });

  it("returns a note naming the path for a missing file, never throwing", () => {
    const path = join(root, "absent.json");
    const result = loadTemplateHistory(path);
    expect(result).toHaveProperty("note");
    expect((result as { note: string }).note).toContain(path);
  });

  it("returns a note for an invalid file", () => {
    const path = join(root, "bad.json");
    writeFileSync(path, "{ nope");
    const result = loadTemplateHistory(path);
    expect(result).not.toHaveProperty("history");
    expect((result as { note: string }).note.length).toBeGreaterThan(0);
  });

  it("carries the parser's own message in the note for invalid JSON", () => {
    const path = join(root, "bad-cause.json");
    writeFileSync(path, "{ nope");
    let parserMessage = "";
    try {
      JSON.parse("{ nope");
    } catch (error) {
      parserMessage = (error as Error).message;
    }
    expect(parserMessage).not.toBe("");
    expect((loadTemplateHistory(path) as { note: string }).note).toContain(
      parserMessage,
    );
  });

  it("returns a note for a file of the wrong schema", () => {
    const path = join(root, "schema.json");
    writeFileSync(path, JSON.stringify({ ...VALID, schemaVersion: 9 }));
    expect(loadTemplateHistory(path)).toHaveProperty("note");
  });

  it("returns a note, not a throw, for an unreadable path (a directory)", () => {
    const path = join(root, "dir");
    mkdirSync(path);
    const result = loadTemplateHistory(path);
    expect(result).toHaveProperty("note");
  });

  it("loads the committed data file by default", () => {
    expect(loadTemplateHistory()).toHaveProperty("history");
  });
});

describe("packHashesAt", () => {
  it("returns a pack's manifest hash and file hashes at a version", () => {
    expect(packHashesAt(VALID, "1.0.0", "quality")).toEqual({
      manifest: H3,
      files: { "a.txt": H1 },
    });
  });

  it("returns undefined for a version the history lacks", () => {
    expect(packHashesAt(VALID, "9.9.9", "quality")).toBeUndefined();
  });

  it("returns undefined for a pack the version lacks", () => {
    expect(packHashesAt(VALID, "1.0.0", "statusline")).toBeUndefined();
  });

  it.each([["constructor"], ["__proto__"], ["toString"]])(
    "never reads an inherited property: %s is not a pack or a version",
    (name) => {
      expect(packHashesAt(VALID, "1.0.0", name)).toBeUndefined();
      expect(packHashesAt(VALID, name, "quality")).toBeUndefined();
    },
  );
});

describe("the committed template history", () => {
  it("resolves, through templateHistoryPath, to an existing file", () => {
    expect(existsSync(templateHistoryPath())).toBe(true);
  });

  it("parses and holds every stable release from 1.0.0 to 1.5.0, never a prerelease", () => {
    const loaded = loadTemplateHistory(templateHistoryPath());
    if (!("history" in loaded)) throw new Error(loaded.note);
    const versions = Object.keys(loaded.history.versions);
    for (const version of [
      "1.0.0",
      "1.0.5",
      "1.1.0",
      "1.2.0",
      "1.3.2",
      "1.4.0",
      "1.5.0",
    ]) {
      expect(versions).toContain(version);
    }
    for (const version of versions) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("records a package.json hash in every version's core, and the quality pack at 1.5.0", () => {
    const loaded = loadTemplateHistory(templateHistoryPath());
    if (!("history" in loaded)) throw new Error(loaded.note);
    for (const entry of Object.values(loaded.history.versions)) {
      expect(Object.keys(entry.core)).toContain("package.json");
    }
    const quality = packHashesAt(loaded.history, "1.5.0", "quality");
    expect(quality?.manifest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(quality?.files ?? {}).length).toBeGreaterThan(0);
  });
});
