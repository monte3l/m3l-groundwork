// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The install manifest (`.groundwork/manifest.json`): hashing, JSON key
 * flattening, building from real files, strict parsing, and atomic writing.
 * Real per-test temp directories; no mocks.
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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANIFEST_RELATIVE_PATH,
  MANIFEST_SCHEMA_VERSION,
  ManifestError,
  buildManifest,
  flattenJsonKeys,
  parseManifest,
  readManifest,
  serializeManifest,
  sha256Hex,
  writeManifest,
  type Manifest,
} from "../src/manifest.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function nodeSha(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function validManifest(): Manifest {
  return {
    schemaVersion: 1,
    cliVersion: "1.2.3",
    tokens: { PROJECT_NAME: "widgets", YEAR: "2026" },
    packs: ["harness-extras"],
    files: {
      "a.txt": { sha256: HASH_A, origin: "emitted" },
      "dir/b.txt": { sha256: HASH_B, origin: "merged" },
    },
    jsonKeys: {
      "package.json": { "/name": HASH_A, "/scripts/verify": HASH_B },
    },
  };
}

/** A raw object a test can corrupt before serializing it with JSON.stringify. */
function rawManifest(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validManifest())) as Record<string, unknown>;
}

function parseRaw(raw: unknown): Manifest {
  return parseManifest(JSON.stringify(raw));
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

let dir: string;

/** Whether this platform can create a FIFO with `mkfifo` (the FIFO test skips otherwise). */
const canMakeFifo = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "manifest-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(probe, "p")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // A prototype-sensitive key must never pollute; restore unconditionally.
  Reflect.deleteProperty(Object.prototype, "polluted");
});

describe("constants", () => {
  it("pins the schema version and the relative path", () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(MANIFEST_RELATIVE_PATH).toBe(".groundwork/manifest.json");
  });

  it("types the manifest shape", () => {
    expectTypeOf<Manifest["schemaVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<Manifest["packs"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Manifest["files"][string]["origin"]>().toEqualTypeOf<
      "emitted" | "merged"
    >();
  });
});

describe("sha256Hex", () => {
  it("hashes a string as lowercase hex", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes bytes identically to the equivalent string", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });

  it("hashes the empty input", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("flattenJsonKeys", () => {
  const h = (canonical: string): string => nodeSha(canonical);

  it("emits one entry per top-level scalar key, hashing the canonical value", () => {
    expect(flattenJsonKeys({ name: "x", n: 1, t: true, z: null })).toEqual({
      "/name": h('"x"'),
      "/n": h("1"),
      "/t": h("true"),
      "/z": h("null"),
    });
  });

  it("emits JSON Pointer entries for a top-level plain object, not the object itself", () => {
    const result = flattenJsonKeys({
      scripts: { build: "tsc", test: "vitest" },
    });
    expect(result).toEqual({
      "/scripts/build": h('"tsc"'),
      "/scripts/test": h('"vitest"'),
    });
    expect(Object.hasOwn(result, "/scripts")).toBe(false);
  });

  it("does not descend below depth 2: a depth-2 object is hashed whole, keys sorted", () => {
    expect(flattenJsonKeys({ a: { b: { y: 1, x: 2 } } })).toEqual({
      "/a/b": h('{"x":2,"y":1}'),
    });
  });

  it("treats arrays as values hashed whole, at either depth", () => {
    expect(flattenJsonKeys({ files: ["a", "b"], o: { l: [1, 2] } })).toEqual({
      "/files": h('["a","b"]'),
      "/o/l": h("[1,2]"),
    });
  });

  it("keeps a top-level key named a.b distinct from object a's inner key b", () => {
    const result = flattenJsonKeys({ "a.b": 1, a: { b: 2 } });
    expect(result).toEqual({ "/a.b": h("1"), "/a/b": h("2") });
  });

  it("gives different key sets for {a.b:{c}} and {a:{b.c}}", () => {
    expect(Object.keys(flattenJsonKeys({ "a.b": { c: 1 } }))).toEqual([
      "/a.b/c",
    ]);
    expect(Object.keys(flattenJsonKeys({ a: { "b.c": 1 } }))).toEqual([
      "/a/b.c",
    ]);
  });

  it("escapes ~ as ~0 and / as ~1, in top-level and inner keys, keeping them distinct", () => {
    expect(
      flattenJsonKeys({ "a/b": 1, "a~b": 2, a: { "b/c": 3, "~": 4 } }),
    ).toEqual({
      "/a~1b": h("1"),
      "/a~0b": h("2"),
      "/a/b~1c": h("3"),
      "/a/~0": h("4"),
    });
  });

  it("escapes ~ before /, so a literal ~1 key and a / key do not collide", () => {
    expect(flattenJsonKeys({ "~1": 1, "/": 2 })).toEqual({
      "/~01": h("1"),
      "/~1": h("2"),
    });
  });

  it("skips a key whose value has no JSON form, at either depth", () => {
    expect(flattenJsonKeys({ gone: undefined, kept: 1 })).toEqual({
      "/kept": h("1"),
    });
    expect(flattenJsonKeys({ o: { gone: undefined, kept: 2 } })).toEqual({
      "/o/kept": h("2"),
    });
  });

  it("records an empty object as its own /x entry, unlike a missing x", () => {
    expect(flattenJsonKeys({ x: {} })).toEqual({ "/x": h("{}") });
    expect(flattenJsonKeys({})).toEqual({});
  });

  it("records a top-level __proto__ key as an own /__proto__ entry without polluting", () => {
    const parsed: unknown = JSON.parse(
      '{"__proto__": 1, "a": {"__proto__": 2}}',
    );
    const result = flattenJsonKeys(parsed);
    expect(Object.hasOwn(result, "/__proto__")).toBe(true);
    expect(Object.hasOwn(result, "/a/__proto__")).toBe(true);
    expect(result["/__proto__"]).toBe(h("1"));
    expect(result["/a/__proto__"]).toBe(h("2"));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("is invariant under key order", () => {
    const forward = flattenJsonKeys({ a: 1, b: { x: 1, y: 2 } });
    expect(Object.keys(forward).sort()).toEqual(["/a", "/b/x", "/b/y"]);
    expect(flattenJsonKeys({ b: { y: 2, x: 1 }, a: 1 })).toEqual(forward);
  });

  it("changes a hash when a value changes", () => {
    const one = flattenJsonKeys({ a: 1 })["/a"];
    const two = flattenJsonKeys({ a: 2 })["/a"];
    expect(one).toBe(nodeSha("1"));
    expect(two).toBe(nodeSha("2"));
    expect(one).not.toBe(two);
  });

  it.each([[[1, 2]], ["str"], [null], [42], [undefined]])(
    "returns {} for the non-object input %j",
    (input) => {
      expect(flattenJsonKeys(input)).toEqual({});
    },
  );
});

describe("buildManifest", () => {
  function put(rel: string, content: string): void {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const base = (): {
    cliVersion: string;
    tokens: Record<string, string>;
    packs: string[];
  } => ({
    cliVersion: "1.0.0",
    tokens: { PROJECT_NAME: "p", YEAR: "2026" },
    packs: [],
  });

  it("records the current on-disk hash of each file as emitted, sorted", () => {
    put("z.txt", "zed");
    put("sub/a.txt", "ay");

    const manifest = buildManifest({
      targetDir: dir,
      ...base(),
      files: ["z.txt", "sub/a.txt"],
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.cliVersion).toBe("1.0.0");
    expect(manifest.tokens).toEqual({ PROJECT_NAME: "p", YEAR: "2026" });
    expect(Object.keys(manifest.files)).toEqual(["sub/a.txt", "z.txt"]);
    expect(manifest.files["z.txt"]).toEqual({
      sha256: nodeSha("zed"),
      origin: "emitted",
    });
    expect(manifest.files["sub/a.txt"]).toEqual({
      sha256: nodeSha("ay"),
      origin: "emitted",
    });
    expect(manifest.jsonKeys).toEqual({});
  });

  it("hashes the bytes on disk now, not what was originally emitted", () => {
    put("a.txt", "first");
    put("a.txt", "second");
    const manifest = buildManifest({
      targetDir: dir,
      ...base(),
      files: ["a.txt"],
    });
    expect(manifest.files["a.txt"]?.sha256).toBe(nodeSha("second"));
  });

  it("collapses duplicate files and sorts and dedupes packs", () => {
    put("a.txt", "x");
    const manifest = buildManifest({
      targetDir: dir,
      ...base(),
      packs: ["service", "frontend", "service"],
      files: ["a.txt", "a.txt"],
    });
    expect(Object.keys(manifest.files)).toEqual(["a.txt"]);
    expect(manifest.packs).toEqual(["frontend", "service"]);
  });

  it("records jsonKeys for package.json, tsconfig*.json and .claude/settings.json only", () => {
    put("package.json", JSON.stringify({ name: "n", scripts: { a: "b" } }));
    put("packages/x/package.json", JSON.stringify({ name: "x" }));
    put("tsconfig.json", '// c\n{ "compilerOptions": { "strict": true, }, }');
    put("tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json" }));
    put(".claude/settings.json", '{ /* c */ "hooks": { "x": [] } }');
    put("other.json", JSON.stringify({ ignored: 1 }));
    put("notpackage.json", JSON.stringify({ ignored: 1 }));
    put("settings.json", JSON.stringify({ ignored: 1 }));
    put("sub/.claude/settings.json", JSON.stringify({ ignored: 1 }));

    const manifest = buildManifest({
      targetDir: dir,
      ...base(),
      files: [
        "package.json",
        "packages/x/package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        ".claude/settings.json",
        "other.json",
        "notpackage.json",
        "settings.json",
        "sub/.claude/settings.json",
      ],
    });

    expect(Object.keys(manifest.jsonKeys).sort()).toEqual(
      [
        ".claude/settings.json",
        "package.json",
        "packages/x/package.json",
        "tsconfig.build.json",
        "tsconfig.json",
      ].sort(),
    );
    expect(manifest.jsonKeys["package.json"]).toEqual({
      "/name": nodeSha('"n"'),
      "/scripts/a": nodeSha('"b"'),
    });
    expect(manifest.jsonKeys["tsconfig.json"]).toEqual({
      "/compilerOptions/strict": nodeSha("true"),
    });
    expect(manifest.jsonKeys[".claude/settings.json"]).toEqual({
      "/hooks/x": nodeSha("[]"),
    });
    // The file hash covers the raw bytes, comments included.
    expect(manifest.files["tsconfig.json"]?.sha256).toBe(
      nodeSha('// c\n{ "compilerOptions": { "strict": true, }, }'),
    );
  });

  it("throws an Error naming the path for an unreadable file", () => {
    put("a.txt", "x");
    expect(() =>
      buildManifest({
        targetDir: dir,
        ...base(),
        files: ["a.txt", "missing/gone.txt"],
      }),
    ).toThrow(/missing\/gone\.txt/);
  });

  it("wraps a read failure in a ManifestError carrying the read error as cause", () => {
    const error = thrownBy(() =>
      buildManifest({ targetDir: dir, ...base(), files: ["missing.txt"] }),
    );
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).cause).toBeInstanceOf(Error);
    expect(((error as ManifestError).cause as NodeJS.ErrnoException).code).toBe(
      "ENOENT",
    );
  });

  it("records a __proto__ key of a package.json as an own /__proto__/x entry that survives write and read", () => {
    put("package.json", '{"name":"n","__proto__":{"x":1}}');
    const manifest = buildManifest({
      targetDir: dir,
      ...base(),
      files: ["package.json"],
    });
    const keys = manifest.jsonKeys["package.json"] ?? {};
    expect(Object.hasOwn(keys, "/__proto__/x")).toBe(true);
    expect(keys["/__proto__/x"]).toBe(nodeSha("1"));
    expect(Object.getPrototypeOf(keys)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);

    writeManifest(dir, manifest);
    const back = readManifest(dir);
    expect(back).toEqual(manifest);
    expect(
      Object.hasOwn(back?.jsonKeys["package.json"] ?? {}, "/__proto__/x"),
    ).toBe(true);
  });

  it("keeps a scalar top-level __proto__ as /__proto__ through write and read", () => {
    put("package.json", '{"__proto__":5}');
    const manifest = buildManifest({
      targetDir: dir,
      ...base(),
      files: ["package.json"],
    });
    writeManifest(dir, manifest);
    const keys = readManifest(dir)?.jsonKeys["package.json"] ?? {};
    expect(Object.hasOwn(keys, "/__proto__")).toBe(true);
    expect(keys["/__proto__"]).toBe(nodeSha("5"));
  });

  it("throws an Error naming the path for a JSON file that cannot be parsed", () => {
    put("package.json", "{ not json");
    const error = thrownBy(() =>
      buildManifest({ targetDir: dir, ...base(), files: ["package.json"] }),
    );
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as Error).message).toContain("package.json");
  });

  it("does not chain or quote the parser's view of a broken file (it may hold a secret)", () => {
    // Assembled at runtime so no secret-shaped literal sits in the source.
    const secret = ["sk-live-", "0123456789abcdef"].join("");
    put("package.json", `{"token": "${secret}" "oops"`);
    const error = thrownBy(() =>
      buildManifest({ targetDir: dir, ...base(), files: ["package.json"] }),
    );
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).cause).toBeUndefined();
    let current: unknown = error;
    while (current instanceof Error) {
      expect(current.message).not.toContain(secret);
      current = current.cause;
    }
  });
});

describe("serializeManifest", () => {
  it("is deterministic: sorted keys, two-space indent, trailing newline", () => {
    const text = serializeManifest(validManifest());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain('\n  "cliVersion": "1.2.3",\n');
    const topKeys = Object.keys(JSON.parse(text) as object);
    expect(topKeys).toEqual([
      "cliVersion",
      "files",
      "jsonKeys",
      "packs",
      "schemaVersion",
      "tokens",
    ]);
  });

  it("emits identical text regardless of input key insertion order", () => {
    const a = validManifest();
    const b: Manifest = {
      jsonKeys: a.jsonKeys,
      files: {
        "dir/b.txt": { sha256: HASH_B, origin: "merged" },
        "a.txt": { sha256: HASH_A, origin: "emitted" },
      },
      packs: a.packs,
      tokens: { YEAR: "2026", PROJECT_NAME: "widgets" },
      cliVersion: a.cliVersion,
      schemaVersion: 1,
    };
    expect(serializeManifest(b)).toBe(serializeManifest(a));
  });

  it("wraps a packs array one element per line once its line exceeds 80 columns, and round-trips", () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      cliVersion: "1.2.3",
      tokens: {},
      packs: [
        "frontend",
        "harness-extras",
        "licensing",
        "quality",
        "service",
        "statusline",
      ],
      files: {},
      jsonKeys: {},
    };
    const text = serializeManifest(manifest);
    expect(text).toBe(
      [
        "{",
        '  "cliVersion": "1.2.3",',
        '  "files": {},',
        '  "jsonKeys": {},',
        '  "packs": [',
        '    "frontend",',
        '    "harness-extras",',
        '    "licensing",',
        '    "quality",',
        '    "service",',
        '    "statusline"',
        "  ],",
        '  "schemaVersion": 1,',
        '  "tokens": {}',
        "}",
        "",
      ].join("\n"),
    );
    expect(parseManifest(text)).toEqual(manifest);
  });

  it.each([
    [64, true],
    [65, false],
  ])(
    "keeps a one-name packs array on one line exactly while the line fits in 80 columns (name length %i, flat: %s)",
    (length, flat) => {
      const name = "a".repeat(length);
      const text = serializeManifest({ ...validManifest(), packs: [name] });
      // `  "packs": ["<name>"],` is length + 16 columns: 80 fits, 81 does not.
      const flatLine = `  "packs": ["${name}"],`;
      expect(flatLine.length).toBe(length + 16);
      expect(text.includes(`${flatLine}\n`)).toBe(flat);
      expect(text.includes(`  "packs": [\n    "${name}"\n  ],\n`)).toBe(!flat);
    },
  );

  it("round-trips through parseManifest", () => {
    const m = validManifest();
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
});

describe("parseManifest", () => {
  it("accepts a valid manifest, including empty collections", () => {
    const empty: Manifest = {
      schemaVersion: 1,
      cliVersion: "0.0.0",
      tokens: {},
      packs: [],
      files: {},
      jsonKeys: {},
    };
    expect(parseRaw(empty)).toEqual(empty);
    expect(parseRaw(validManifest())).toEqual(validManifest());
  });

  it("throws ManifestError (an Error subclass) for invalid JSON", () => {
    const error = thrownBy(() => parseManifest("{ nope"));
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ManifestError);
  });

  it.each([["[]"], ['"s"'], ["null"], ["3"]])(
    "rejects non-object top-level %s",
    (text) => {
      expect(() => parseManifest(text)).toThrow(ManifestError);
    },
  );

  it.each([[2], [0], ["1"], [null]])(
    "rejects schemaVersion %j naming the field",
    (version) => {
      const raw = rawManifest();
      raw["schemaVersion"] = version;
      expect(() => parseRaw(raw)).toThrow(/schemaVersion/);
      expect(() => parseRaw(raw)).toThrow(ManifestError);
    },
  );

  it("names the unsupported schemaVersion number", () => {
    const raw = rawManifest();
    raw["schemaVersion"] = 2;
    expect(() => parseRaw(raw)).toThrow(/schemaVersion.*2/);
  });

  it("rejects a missing schemaVersion", () => {
    const raw = rawManifest();
    delete raw["schemaVersion"];
    expect(() => parseRaw(raw)).toThrow(/schemaVersion/);
  });

  it.each([
    ["cliVersion", 1],
    ["cliVersion", undefined],
    ["tokens", []],
    ["tokens", { PROJECT_NAME: 3 }],
    ["tokens", undefined],
    ["packs", "x"],
    ["packs", [1]],
    ["packs", undefined],
    ["files", []],
    ["files", undefined],
    ["jsonKeys", []],
    ["jsonKeys", undefined],
    ["jsonKeys", { "package.json": { a: 1 } }],
    ["jsonKeys", { "package.json": "x" }],
    ["jsonKeys", { "package.json": { "scripts.verify": HASH_A } }],
    ["jsonKeys", { "package.json": { name: HASH_A } }],
    ["cliVersion", ""],
    ["packs", ["../x"]],
    ["packs", ["Foo"]],
    ["packs", [""]],
    ["packs", ["a/b"]],
    ["packs", ["-a"]],
    ["packs", ["1a"]],
    ["packs", ["a_b"]],
  ])(
    "rejects an ill-typed or missing %s (%j) naming the field",
    (field, bad) => {
      const raw = rawManifest();
      if (bad === undefined) delete raw[field];
      else raw[field] = bad;
      const error = thrownBy(() => parseRaw(raw));
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as Error).message).toContain(field);
    },
  );

  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["non-hex", "g".repeat(64)],
    ["not a string", 5],
  ])("rejects a file sha256 that is %s", (_label, sha256) => {
    const raw = rawManifest();
    raw["files"] = { "a.txt": { sha256, origin: "emitted" } };
    expect(() => parseRaw(raw)).toThrow(ManifestError);
    expect(() => parseRaw(raw)).toThrow(/sha256/);
  });

  it.each([["generated"], ["EMITTED"], [""], [1]])(
    "rejects a file origin of %j",
    (origin) => {
      const raw = rawManifest();
      raw["files"] = { "a.txt": { sha256: HASH_A, origin } };
      expect(() => parseRaw(raw)).toThrow(ManifestError);
      expect(() => parseRaw(raw)).toThrow(/origin/);
    },
  );

  it("rejects an unknown key inside a files entry, naming it", () => {
    const raw = rawManifest();
    raw["files"] = {
      "a.txt": { sha256: HASH_A, origin: "emitted", extra: 1 },
    };
    const error = thrownBy(() => parseRaw(raw));
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as Error).message).toContain("extra");
  });

  it.each([["nothex"], ["A".repeat(64)], ["a".repeat(63)], [""]])(
    "rejects a jsonKeys hash that is a string but not a sha256 (%j)",
    (hash) => {
      const raw = rawManifest();
      raw["jsonKeys"] = { "package.json": { "/a": hash } };
      const error = thrownBy(() => parseRaw(raw));
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as Error).message).toContain("jsonKeys");
      expect((error as Error).message).toContain("64 lowercase hex");
    },
  );

  it("rejects a file entry that is not an object", () => {
    const raw = rawManifest();
    raw["files"] = { "a.txt": "x" };
    expect(() => parseRaw(raw)).toThrow(ManifestError);
  });

  it.each([["extra"], ["answers"]])(
    "rejects the unknown top-level key %s, naming it",
    (key) => {
      const raw = rawManifest();
      raw[key] = {};
      const error = thrownBy(() => parseRaw(raw));
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as Error).message).toContain(key);
    },
  );

  describe("prototype-sensitive keys", () => {
    const sensitive = ["__proto__", "constructor", "prototype"];
    const places = ["top", "tokens", "files", "jsonKeys", "jsonKeys-inner"];

    /** Splices a raw member into the JSON text so `__proto__` becomes an own key. */
    function withInjected(where: string, key: string): string {
      const text = JSON.stringify(rawManifest());
      const member = `"${key}":{"polluted":true}`;
      switch (where) {
        case "top":
          return text.replace(/^\{/, `{${member},`);
        case "tokens":
          return text.replace('"tokens":{', `"tokens":{"${key}":"x",`);
        case "files":
          return text.replace(
            '"files":{',
            `"files":{"${key}":{"sha256":"${HASH_A}","origin":"emitted"},`,
          );
        case "jsonKeys":
          return text.replace('"jsonKeys":{', `"jsonKeys":{${member},`);
        default:
          return text.replace(
            '"package.json":{',
            `"package.json":{"${key}":"${HASH_A}",`,
          );
      }
    }

    it.each(
      sensitive.flatMap((key) => places.map((where) => [key, where] as const)),
    )("rejects %s at %s", (key, where) => {
      const text = withInjected(where, key);
      expect(text).toContain(`"${key}"`);
      expect(() => parseManifest(text)).toThrow(ManifestError);
    });

    it("accepts a pointer key that merely ends in a sensitive name", () => {
      const raw = rawManifest();
      raw["jsonKeys"] = {
        "package.json": { "/__proto__": HASH_A, "/constructor/x": HASH_B },
      };
      const parsed = parseRaw(raw);
      expect(
        Object.hasOwn(parsed.jsonKeys["package.json"] ?? {}, "/__proto__"),
      ).toBe(true);
    });
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["dot-dot segment", "a/../b"],
    ["leading dot-dot", "../b"],
    ["backslash", "a\\b"],
  ])("rejects a %s file path", (_label, path) => {
    const raw = rawManifest();
    raw["files"] = { [path]: { sha256: HASH_A, origin: "emitted" } };
    expect(() => parseRaw(raw)).toThrow(ManifestError);
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["dot-dot segment", "a/../b"],
    ["backslash", "a\\b"],
  ])("rejects a %s jsonKeys path", (_label, path) => {
    const raw = rawManifest();
    raw["jsonKeys"] = { [path]: { "/a": HASH_A } };
    expect(() => parseRaw(raw)).toThrow(ManifestError);
  });

  it.each([["generic-pack"], ["harness-extras"], ["a1"], ["a"]])(
    "accepts the pack name %s",
    (name) => {
      const raw = rawManifest();
      raw["packs"] = [name];
      expect(parseRaw(raw).packs).toEqual([name]);
    },
  );

  it("accepts a path that merely contains dots in a segment", () => {
    const raw = rawManifest();
    raw["files"] = {
      "a..b/.claude/x.json": { sha256: HASH_A, origin: "emitted" },
    };
    expect(parseRaw(raw).files["a..b/.claude/x.json"]?.sha256).toBe(HASH_A);
  });
});

describe("writeManifest", () => {
  const manifestPath = (): string => join(dir, ".groundwork", "manifest.json");

  it("rethrows the ManifestError of an invalid manifest unchanged, writing nothing", () => {
    const invalid = {
      ...validManifest(),
      schemaVersion: 2,
    } as unknown as Manifest;
    const error = thrownBy(() => writeManifest(dir, invalid));
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).message).toMatch(/schemaVersion.*2/);
    // Not re-wrapped as "could not write": no cause, the parse error itself.
    expect((error as ManifestError).cause).toBeUndefined();
    expect((error as ManifestError).message).not.toContain("could not write");
    expect(existsSync(join(dir, ".groundwork"))).toBe(false);
  });

  it("creates .groundwork and writes the serialized manifest", () => {
    writeManifest(dir, validManifest());
    expect(readFileSync(manifestPath(), "utf8")).toBe(
      serializeManifest(validManifest()),
    );
  });

  it("leaves no temp file behind on success", () => {
    writeManifest(dir, validManifest());
    expect(readdirSync(join(dir, ".groundwork"))).toEqual(["manifest.json"]);
  });

  it("replaces an existing manifest", () => {
    writeManifest(dir, validManifest());
    const next = { ...validManifest(), cliVersion: "9.9.9" };
    writeManifest(dir, next);
    expect(readFileSync(manifestPath(), "utf8")).toBe(serializeManifest(next));
    expect(readdirSync(join(dir, ".groundwork"))).toEqual(["manifest.json"]);
  });

  it("refuses a symlinked .groundwork and writes nothing through it", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "manifest-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(dir, ".groundwork"));
      const error = thrownBy(() => writeManifest(dir, validManifest()));
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as ManifestError).cause).toBeInstanceOf(Error);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(lstatSync(join(dir, ".groundwork")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked manifest path, leaving the target and directory untouched", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "manifest-elsewhere-"));
    try {
      const victim = join(elsewhere, "victim.txt");
      writeFileSync(victim, "keep");
      mkdirSync(join(dir, ".groundwork"));
      symlinkSync(victim, manifestPath());

      const error = thrownBy(() => writeManifest(dir, validManifest()));
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as ManifestError).cause).toBeInstanceOf(Error);

      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(lstatSync(manifestPath()).isSymbolicLink()).toBe(true);
      expect(readdirSync(join(dir, ".groundwork"))).toEqual(["manifest.json"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("readManifest", () => {
  it("returns undefined when the file is absent", () => {
    expect(readManifest(dir)).toBeUndefined();
    expect(existsSync(join(dir, ".groundwork"))).toBe(false);
  });

  it("returns undefined when .groundwork exists without a manifest", () => {
    mkdirSync(join(dir, ".groundwork"));
    expect(readManifest(dir)).toBeUndefined();
  });

  it("reads back what writeManifest wrote", () => {
    writeManifest(dir, validManifest());
    expect(readManifest(dir)).toEqual(validManifest());
  });

  it("throws ManifestError for a present-but-invalid file, never undefined", () => {
    mkdirSync(join(dir, ".groundwork"));
    writeFileSync(join(dir, ".groundwork", "manifest.json"), "{ nope");
    expect(() => readManifest(dir)).toThrow(ManifestError);
  });

  describe("is lstat-first: undefined only for a genuinely absent manifest", () => {
    function validText(): string {
      return serializeManifest(validManifest());
    }

    it("throws ManifestError when .groundwork is a regular file", () => {
      writeFileSync(join(dir, ".groundwork"), "not a directory");
      expect(() => readManifest(dir)).toThrow(ManifestError);
    });

    it("throws ManifestError when manifest.json is a dangling symlink", () => {
      mkdirSync(join(dir, ".groundwork"));
      symlinkSync(
        join(dir, "nowhere.json"),
        join(dir, ".groundwork", "manifest.json"),
      );
      expect(() => readManifest(dir)).toThrow(ManifestError);
    });

    it("throws ManifestError when manifest.json is a symlink to a valid manifest", () => {
      mkdirSync(join(dir, ".groundwork"));
      writeFileSync(join(dir, "real.json"), validText());
      symlinkSync(
        join(dir, "real.json"),
        join(dir, ".groundwork", "manifest.json"),
      );
      expect(() => readManifest(dir)).toThrow(ManifestError);
    });

    it("throws ManifestError when .groundwork is a symlink to a directory holding a valid manifest", () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "manifest-elsewhere-"));
      try {
        writeFileSync(join(elsewhere, "manifest.json"), validText());
        symlinkSync(elsewhere, join(dir, ".groundwork"));
        expect(() => readManifest(dir)).toThrow(ManifestError);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it.skipIf(!canMakeFifo)(
      "throws ManifestError, without blocking, when manifest.json is a FIFO",
      () => {
        mkdirSync(join(dir, ".groundwork"));
        execFileSync("mkfifo", [join(dir, ".groundwork", "manifest.json")]);
        const error = thrownBy(() => readManifest(dir));
        expect(error).toBeInstanceOf(ManifestError);
        expect(((error as ManifestError).cause as Error).message).toContain(
          "not a regular file",
        );
      },
    );

    it("throws ManifestError when manifest.json is a directory", () => {
      mkdirSync(join(dir, ".groundwork", "manifest.json"), { recursive: true });
      expect(() => readManifest(dir)).toThrow(ManifestError);
    });
  });

  it("throws ManifestError naming the field for a structurally invalid file", () => {
    mkdirSync(join(dir, ".groundwork"));
    writeFileSync(
      join(dir, ".groundwork", "manifest.json"),
      JSON.stringify({ schemaVersion: 2 }),
    );
    expect(() => readManifest(dir)).toThrow(/schemaVersion/);
  });
});
