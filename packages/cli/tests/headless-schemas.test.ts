// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The shipped JSON Schemas (packages/cli/schemas/) must not drift from the
 * TypeScript contract: same property names, same enums, closed objects.
 */
import { describe, expect, it, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_MODES,
  validateAnswers,
  CI_DEPTHS,
  CONFLICT_RESOLUTIONS,
  PROJECT_KINDS,
  RUNTIME_TARGETS,
} from "../src/headless/contract.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { buildErrorReport, buildReport } from "../src/headless/report.js";
import { buildAdoptPending } from "../src/headless/pending.js";
import type { Inventory } from "../src/inventory.js";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");

type Schema = Record<string, unknown>;

function load(name: string): Schema {
  return JSON.parse(
    readFileSync(join(cliDir, "schemas", name), "utf8"),
  ) as Schema;
}

/** Follows a local `$ref`. */
function deref(node: Schema, root: Schema): Schema {
  const ref = node["$ref"];
  if (typeof ref !== "string") return node;
  let current: unknown = root;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    current = (current as Schema)[part];
  }
  return deref(current as Schema, root);
}

/** Every object-typed schema reachable from `node` through $ref and anyOf/oneOf. */
function objectSchemas(node: Schema, root: Schema): Schema[] {
  const resolved = deref(node, root);
  const branches = [resolved["anyOf"], resolved["oneOf"]].flatMap((b) =>
    Array.isArray(b) ? (b as Schema[]) : [],
  );
  const own = resolved["properties"] === undefined ? [] : [resolved];
  return [...own, ...branches.flatMap((b) => objectSchemas(b, root))];
}

function itemsOf(node: Schema, root: Schema): Schema {
  const resolved = deref(node, root);
  const branches = [resolved["anyOf"], resolved["oneOf"]].flatMap((b) =>
    Array.isArray(b) ? (b as Schema[]) : [],
  );
  for (const candidate of [resolved, ...branches.map((b) => deref(b, root))]) {
    if (candidate["items"] !== undefined) {
      return candidate["items"] as Schema;
    }
  }
  throw new Error("no items schema found");
}

function keysOf(schemas: readonly Schema[]): string[] {
  return [
    ...new Set(schemas.flatMap((s) => Object.keys(s["properties"] as Schema))),
  ].sort();
}

/** Every enum array (null stripped, sorted) anywhere in the schema. */
function allEnums(node: unknown): string[][] {
  if (Array.isArray(node)) return node.flatMap(allEnums);
  if (node === null || typeof node !== "object") return [];
  const record = node as Schema;
  const own = Array.isArray(record["enum"])
    ? [
        (record["enum"] as unknown[])
          .filter((v): v is string => typeof v === "string")
          .sort(),
      ]
    : [];
  return [...own, ...Object.values(record).flatMap(allEnums)];
}

function allObjectSchemas(node: unknown): Schema[] {
  if (Array.isArray(node)) return node.flatMap(allObjectSchemas);
  if (node === null || typeof node !== "object") return [];
  const record = node as Schema;
  const own = record["properties"] === undefined ? [] : [record];
  return [...own, ...Object.values(record).flatMap(allObjectSchemas)];
}

describe.each([
  ["answers.v1.schema.json", "groundwork.answers"],
  ["report.v1.schema.json", "groundwork.report"],
])("%s", (file, schemaName) => {
  const schema = load(file);

  it("is a draft 2020-12 schema with an $id and a title", () => {
    expect(schema["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(typeof schema["$id"]).toBe("string");
    expect(schema["$id"]).not.toBe("");
    expect(typeof schema["title"]).toBe("string");
    expect(schema["title"]).not.toBe("");
  });

  it("pins the schema name and version", () => {
    const props = schema["properties"] as Record<string, Schema>;
    expect(props["schema"]?.["const"]).toBe(schemaName);
    expect(props["schemaVersion"]?.["const"]).toBe(1);
  });

  it("closes every object with additionalProperties: false", () => {
    const objects = allObjectSchemas(schema);
    expect(objects.length).toBeGreaterThan(1);
    for (const object of objects) {
      expect(object["additionalProperties"]).toBe(false);
    }
  });
});

describe("answers.v1.schema.json against the contract", () => {
  const schema = load("answers.v1.schema.json");
  const props = (node: Schema) => node["properties"] as Record<string, Schema>;
  const section = (name: string) =>
    objectSchemas(props(schema)[name] as Schema, schema);

  it("has exactly the contract's top-level keys", () => {
    expect(keysOf([schema])).toEqual(
      [
        "schema",
        "schemaVersion",
        "mode",
        "basis",
        "fresh",
        "interview",
        "adopt",
        "upgrade",
        "packs",
        "plugins",
        "guidance",
        "pending",
      ].sort(),
    );
  });

  it.each([
    ["basis", ["inventorySha256", "planSha256"]],
    ["fresh", ["name", "skipInstall"]],
    [
      "interview",
      ["kind", "runtime", "testsMandatory", "ciDepth", "keepAgents"],
    ],
    ["adopt", ["additions", "conflicts", "missedNotes"]],
    ["upgrade", ["applySafe", "removals", "conflicts"]],
    ["packs", ["install", "decline"]],
    ["plugins", ["enabled", "declined"]],
    ["guidance", ["enabled", "domains"]],
  ])("has exactly the contract's %s keys", (name, keys) => {
    expect(keysOf(section(name))).toEqual([...keys].sort());
  });

  it.each([
    ["adopt", "additions", ["path", "action"]],
    ["adopt", "conflicts", ["path", "resolution", "takeKeys"]],
    ["upgrade", "conflicts", ["path", "resolution"]],
  ])("has exactly the contract's %s.%s item keys", (name, field, keys) => {
    const parent = section(name).find(
      (s) => props(s)[field] !== undefined,
    ) as Schema;
    const items = itemsOf(props(parent)[field] as Schema, schema);
    expect(keysOf(objectSchemas(items, schema))).toEqual([...keys].sort());
  });

  it("has exactly the contract's pending entry keys", () => {
    const items = itemsOf(props(schema)["pending"] as Schema, schema);
    expect(keysOf(objectSchemas(items, schema))).toEqual(
      ["pointer", "reason", "choices", "evidence"].sort(),
    );
  });

  it("carries the exported enums", () => {
    const enums = allEnums(schema).map((e) => JSON.stringify(e));
    for (const tuple of [
      PROJECT_KINDS,
      RUNTIME_TARGETS,
      CI_DEPTHS,
      ANSWER_MODES,
      CONFLICT_RESOLUTIONS,
    ]) {
      expect(enums).toContain(JSON.stringify([...tuple].sort()));
    }
    expect(enums).toContain(JSON.stringify(["delegate", "keep", "take"]));
    expect(enums).toContain(JSON.stringify(["add", "skip"]));
    expect(enums).toContain(JSON.stringify(["delete", "keep"]));
  });

  it("has no enum member outside the contract's vocabulary", () => {
    const vocabulary = new Set<string>([
      ...PROJECT_KINDS,
      ...RUNTIME_TARGETS,
      ...CI_DEPTHS,
      ...ANSWER_MODES,
      ...CONFLICT_RESOLUTIONS,
      "add",
      "skip",
      "delete",
      "__proto__",
      "constructor",
      "prototype",
    ]);
    const members = allEnums(schema).flat();
    expect(members.length).toBeGreaterThan(0);
    expect(members.filter((m) => !vocabulary.has(m))).toEqual([]);
  });

  it("lists every property of an object schema as required (takeKeys and the basis variants aside)", () => {
    const objects = allObjectSchemas(schema).filter((o) => {
      const keys = Object.keys(o["properties"] as Schema);
      return !keys.every((k) => k === "inventorySha256" || k === "planSha256");
    });
    expect(objects.length).toBeGreaterThan(5);
    for (const object of objects) {
      const keys = Object.keys(object["properties"] as Schema)
        .filter((k) => k !== "takeKeys")
        .sort();
      const required = ((object["required"] as string[] | undefined) ?? [])
        .filter((k) => k !== "takeKeys")
        .sort();
      expect(required).toEqual(keys);
    }
  });

  it("caps every array at 10000 items", () => {
    const arrays: Schema[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === "object") {
        const record = node as Schema;
        if (record["type"] === "array") arrays.push(record);
        Object.values(record).forEach(walk);
      }
    };
    walk(schema);
    expect(arrays.length).toBeGreaterThan(5);
    for (const array of arrays) expect(array["maxItems"]).toBe(10000);
  });

  it("constrains both basis hashes to 64 lowercase hex digits", () => {
    const variants = objectSchemas(props(schema)["basis"] as Schema, schema);
    const patterns = variants.flatMap((variant) =>
      Object.values(props(variant)).map((p) => p["pattern"]),
    );
    expect(patterns).toHaveLength(2);
    for (const pattern of patterns) {
      expect(typeof pattern).toBe("string");
      const regex = new RegExp(pattern as string, "u");
      expect(regex.test("0123456789abcdef".repeat(4))).toBe(true);
      for (const bad of [
        "A".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
        `${"a".repeat(64)}\n`,
        "g".repeat(64),
      ]) {
        expect(regex.test(bad)).toBe(false);
      }
    }
  });

  describe("relativePath", () => {
    const defs = schema["$defs"] as Record<string, Schema>;
    const relative = defs["relativePath"] as Schema;
    const regex = (): RegExp => new RegExp(relative["pattern"] as string, "u");
    // JSON Schema's minLength/maxLength count Unicode code points, while the
    // validator caps UTF-16 code units (`String.length`), so the two limits
    // differ for astral characters; the validator is intentionally stricter.
    const bySchema = (path: string): boolean => {
      const codePoints = [...path].length;
      return (
        regex().test(path) &&
        codePoints >= ((relative["minLength"] as number | undefined) ?? 0) &&
        codePoints <=
          ((relative["maxLength"] as number | undefined) ?? Infinity)
      );
    };
    const byValidator = (path: string): boolean => {
      const doc = {
        schema: "groundwork.answers",
        schemaVersion: 1,
        mode: "adopt",
        basis: { inventorySha256: "a".repeat(64) },
        fresh: null,
        interview: {
          kind: "library",
          runtime: "node",
          testsMandatory: true,
          ciDepth: "standard",
          keepAgents: null,
        },
        adopt: {
          additions: [{ path, action: "add" }],
          conflicts: [],
          missedNotes: "",
        },
        upgrade: null,
        packs: { install: [], decline: [] },
        plugins: { enabled: [], declined: [] },
        guidance: { enabled: false, domains: [] },
        pending: [],
      };
      return validateAnswers(doc, "complete").ok;
    };
    const corpus: readonly (readonly [string, boolean])[] = [
      ...[
        ".",
        "./",
        "a/.",
        "./a",
        "a//b",
        "a/",
        "/abs",
        "..",
        "../x",
        "a/../b",
        "a/..",
        "a/.. ",
        "a./b",
        "a /b",
        "a\\b",
        "C:/x",
        "",
        "a\0b",
        "a\nb",
        "a\u007fb",
        "a\u001fb",
        "a\n/..",
        "x\n/..",
        ".git",
        ".git/config",
        ".GIT/hooks/x",
        ".groundwork",
        ".groundwork/manifest.json",
        "a".repeat(4097),
        // NTFS: an alternate data stream or a ":" anywhere in a segment
        ".git::$INDEX_ALLOCATION/config",
        "a:b",
        "dir/f:ads",
        "dir/:x",
        "x:",
        // NTFS 8.3 short name of .git, first segment only, any case
        "git~1",
        "git~1/config",
        "GIT~1/config",
        "Git~1",
        // Kelvin sign U+212A folds to k
        ".groundwor\u212A",
        ".groundwor\u212A/x",
        ".GROUNDWOR\u212A/x",
        ".GROUNDWORK/x",
        // NTFS dotless i (U+0131) folds to I, so these alias .git / git~1
        ".g\u0131t",
        ".g\u0131t/x",
        "g\u0131t~1",
        "g\u0131t~1/x",
        "GIT~1",
        // lone surrogates (Node writes them as U+FFFD, so paths alias)
        "a\uD800",
        "a\uDC00",
        "\uD800/x",
        "\uDC00\uD800",
      ].map((p) => [p, false] as const),
      ...[
        "a.md",
        "docs/a.md",
        ".github/workflows/ci.yml",
        ".claude/settings.json",
        "..foo",
        "a..b",
        ".gitignore",
        ".gitattributes",
        "pkg/.git-keep",
        "a".repeat(4096),
        "a~1",
        "git~2/x",
        "pkg/git~1/x",
        "docs/\u{1F600}.md",
        ".g\u0131tignore",
        "pkg/.g\u0131t/x",
      ].map((p) => [p, true] as const),
    ];

    test.each([["a\uD800"], ["a\uDC00"], ["\uD800/x"], ["\uDC00\uD800"]])(
      "the schema pattern rejects the lone surrogate %j with and without the u flag",
      (path) => {
        const source = relative["pattern"] as string;
        expect(new RegExp(source, "u").test(path)).toBe(false);
        expect(new RegExp(source).test(path)).toBe(false);
        expect(byValidator(path)).toBe(false);
      },
    );

    test("the schema pattern accepts an astral path with and without the u flag", () => {
      const source = relative["pattern"] as string;
      expect(new RegExp(source, "u").test("docs/\u{1F600}.md")).toBe(true);
      expect(new RegExp(source).test("docs/\u{1F600}.md")).toBe(true);
    });

    test("the schema description names the 1,000,000-unit work budget", () => {
      expect(schema["description"]).toContain("1,000,000");
    });

    test("2049 emoji: inside the schema's code-point limit, over the validator's UTF-16 unit limit (documented, intentionally stricter validator)", () => {
      const path = "\u{1F600}".repeat(2049);
      expect([...path]).toHaveLength(2049);
      expect(path.length).toBe(4098);
      expect(bySchema(path)).toBe(true);
      expect(byValidator(path)).toBe(false);
    });

    test.each(
      corpus.map(
        ([p, ok]) =>
          [p.length > 40 ? `(${p.length} chars)` : p, p, ok] as const,
      ),
    )(
      "accepts or rejects %j exactly as the validator does",
      (_label, path, expected) => {
        expect(byValidator(path)).toBe(expected);
        expect(bySchema(path)).toBe(expected);
      },
    );
  });
});

describe("report.v1.schema.json against buildReport", () => {
  const schema = load("report.v1.schema.json");
  const report = buildReport(
    {
      mode: "fresh",
      target: "/t",
      warnings: [],
      setupSteps: [],
      nextStep: null,
      manifest: null,
      pending: [],
      pendingPath: null,
    },
    { cliVersion: "1.0.0" },
  );

  it("has exactly ReportV1's top-level keys", () => {
    expect(keysOf([schema])).toEqual(Object.keys(report).sort());
  });

  it("has exactly ReportV1's artifacts keys", () => {
    const artifacts = (schema["properties"] as Record<string, Schema>)[
      "artifacts"
    ] as Schema;
    expect(keysOf(objectSchemas(artifacts, schema))).toEqual(
      Object.keys(report.artifacts).sort(),
    );
  });
});

describe("report.v1.schema.json against a report with real adopt pending entries", () => {
  const schema = load("report.v1.schema.json");
  const props = schema["properties"] as Record<string, Schema>;
  const inventory = {
    schemaVersion: 6,
    packs: [],
    conflicts: [
      { relPath: "tsconfig.json", status: "divergent", keyDiffs: undefined },
      { relPath: "eslint.config.js", status: "absent", keyDiffs: undefined },
      { relPath: ".gitignore", status: "identical", keyDiffs: undefined },
    ],
  } as unknown as Inventory;
  const { pending } = buildAdoptPending(inventory, {
    inventorySha256: "a".repeat(64),
  });
  const report = buildReport(
    {
      mode: "adopt",
      target: "/t",
      warnings: [],
      setupSteps: [],
      nextStep: null,
      manifest: null,
      pending,
      pendingPath: ".groundwork/headless/pending.json",
    },
    { cliVersion: "1.0.0" },
  );

  it("has a non-empty pending list and an artifacts.pending path", () => {
    expect(report.pending.length).toBeGreaterThan(0);
    expect(report.artifacts.pending).toBe(".groundwork/headless/pending.json");
  });

  it("has exactly the schema's top-level and artifacts keys", () => {
    expect(keysOf([schema])).toEqual(Object.keys(report).sort());
    const artifacts = props["artifacts"] as Schema;
    expect(keysOf(objectSchemas(artifacts, schema))).toEqual(
      Object.keys(report.artifacts).sort(),
    );
  });

  it("gives every pending entry exactly the schema's entry keys, in the schema's value shapes", () => {
    const items = itemsOf(props["pending"] as Schema, schema);
    const keys = keysOf(objectSchemas(items, schema));
    for (const entry of report.pending) {
      expect(Object.keys(entry).sort()).toEqual(keys);
      expect(typeof entry.pointer).toBe("string");
      expect(typeof entry.reason).toBe("string");
      expect(
        entry.choices === null ||
          (Array.isArray(entry.choices) &&
            entry.choices.every((c) => typeof c === "string")),
      ).toBe(true);
      expect(
        entry.evidence === null || typeof entry.evidence === "string",
      ).toBe(true);
    }
  });

  it("allows every status, exitCode, mode and phase value this report holds", () => {
    for (const key of ["status", "exitCode", "mode", "phase"] as const) {
      expect((props[key]?.["enum"] as unknown[]).includes(report[key])).toBe(
        true,
      );
    }
  });
});

describe("report.v1.schema.json enums against the runtime", () => {
  const schema = load("report.v1.schema.json");
  const props = schema["properties"] as Record<string, Schema>;
  const enumOf = (key: string): unknown[] => props[key]?.["enum"] as unknown[];
  const context = { cliVersion: "1.0.0" };
  const ok = (mode: "fresh" | "adopt") =>
    buildReport(
      {
        mode,
        target: "/t",
        warnings: [],
        setupSteps: [],
        nextStep: null,
        manifest: null,
        pending: [],
        pendingPath: null,
      },
      context,
    );
  const failures = [
    EXIT_CODES.runtime,
    EXIT_CODES.usage,
    EXIT_CODES.pending,
    EXIT_CODES.drift,
  ].map((code) => buildErrorReport(new Error("x"), code, context));
  const produced = [ok("fresh"), ok("adopt"), ...failures];

  it("lists exactly the exit codes exit-codes.ts defines", () => {
    expect([...enumOf("exitCode")].sort()).toEqual(
      Object.values(EXIT_CODES).sort(),
    );
  });

  it.each(["status", "exitCode", "mode", "phase"] as const)(
    "allows every %s value the builders produce",
    (key) => {
      const allowed = enumOf(key);
      for (const report of produced) {
        expect(allowed).toContain(report[key]);
      }
    },
  );
});

describe("package.json", () => {
  it("ships the schemas directory", () => {
    const pkg = JSON.parse(
      readFileSync(join(cliDir, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("schemas");
  });
});

describe("answers.v1 relativePath pattern", () => {
  const defs = load("answers.v1.schema.json")["$defs"] as Record<
    string,
    Schema
  >;
  const pattern = new RegExp(
    (defs["relativePath"] as { pattern: string }).pattern,
    "u",
  );
  const KELVIN = "\u212A";

  test.each([
    [".GROUNDWORK/x"],
    [".Groundwork"],
    [".GIT/config"],
    [`.groundwor${KELVIN}`],
    [`.groundwor${KELVIN}/x`],
  ])(
    "rejects the protected first segment %j, as the validator does",
    (path) => {
      expect(pattern.test(path)).toBe(false);
    },
  );

  it("accepts an ordinary path", () => {
    expect(pattern.test("src/a.ts")).toBe(true);
  });
});
