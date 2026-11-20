// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `groundwork.answers` v1 contract (src/headless/contract.ts): runtime
 * tuples plus `validateAnswers`, which must never throw and must report every
 * problem with a JSON pointer. See `.claude/rules/headless-mode.md`.
 */
import { describe, expect, expectTypeOf, it, test } from "vitest";
import * as fc from "fast-check";
import {
  ANSWER_MODES,
  BASELINE_AGENTS,
  CI_DEPTHS,
  CONFLICT_RESOLUTIONS,
  PROJECT_KINDS,
  RUNTIME_TARGETS,
  validateAnswers,
  type AnswersV1,
  type PendingEntry,
  type ValidationIssue,
  type ValidationProfile,
  type ValidationResult,
} from "../src/headless/contract.js";

type Json = Record<string, unknown>;
const PROFILES: readonly ValidationProfile[] = ["partial", "complete"];
const SHA = "a".repeat(64);

/** A fully decided, valid document for each mode (valid under both profiles). */
function freshDoc(): Json {
  return {
    schema: "groundwork.answers",
    schemaVersion: 1,
    mode: "fresh",
    basis: null,
    fresh: { name: "acme", skipInstall: false },
    interview: {
      kind: "library",
      runtime: "node",
      testsMandatory: true,
      ciDepth: "standard",
      keepAgents: ["Explore", "test-author"],
    },
    adopt: null,
    upgrade: null,
    packs: { install: [], decline: [] },
    plugins: { enabled: [], declined: [] },
    guidance: { enabled: false, domains: [] },
    pending: [],
  };
}
function adoptDoc(): Json {
  return {
    ...freshDoc(),
    mode: "adopt",
    basis: { inventorySha256: SHA },
    fresh: null,
    adopt: {
      additions: [
        { path: "a/b.txt", action: "add" },
        { path: "c.txt", action: "skip" },
      ],
      conflicts: [
        { path: "x.json", resolution: "merge-keys", takeKeys: ["scripts"] },
        { path: "y.md", resolution: "keep" },
      ],
      missedNotes: "",
    },
  };
}
function upgradeDoc(): Json {
  return {
    ...freshDoc(),
    mode: "upgrade",
    basis: { planSha256: SHA },
    fresh: null,
    interview: {
      kind: null,
      runtime: null,
      testsMandatory: null,
      ciDepth: null,
      keepAgents: null,
    },
    upgrade: {
      applySafe: true,
      removals: "delete",
      conflicts: [{ path: "z.md", resolution: "take" }],
    },
  };
}
const DOCS: readonly (readonly [string, () => Json])[] = [
  ["fresh", freshDoc],
  ["adopt", adoptDoc],
  ["upgrade", upgradeDoc],
];

/** Sets `value` at the JSON-pointer-like `path` of `doc` (a clone), `undefined` deletes. */
function setAt(doc: Json, path: readonly (string | number)[], value: unknown) {
  const copy = structuredClone(doc);
  let node: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) {
      throw new Error(`setAt: nothing to walk into at ${String(key)}`);
    }
    node = next as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("setAt: empty path");
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return copy;
}

function errorsOf(value: unknown, profile: ValidationProfile) {
  const result = validateAnswers(value, profile);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}
function pointersOf(value: unknown, profile: ValidationProfile): string[] {
  return errorsOf(value, profile).map((e) => e.pointer);
}

describe("tuples", () => {
  it("pins every enum by hand", () => {
    expect(PROJECT_KINDS).toEqual([
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ]);
    expect(RUNTIME_TARGETS).toEqual(["node", "browser", "both"]);
    expect(CI_DEPTHS).toEqual(["minimal", "standard", "thorough"]);
    expect(BASELINE_AGENTS).toEqual([
      "Explore",
      "test-author",
      "code-implementer",
      "code-reviewer",
      "silent-failure-hunter",
    ]);
    expect(ANSWER_MODES).toEqual(["fresh", "adopt", "upgrade"]);
    expect(CONFLICT_RESOLUTIONS).toEqual([
      "keep",
      "take",
      "merge-keys",
      "delegate",
    ]);
  });

  it("types the document", () => {
    expectTypeOf(ANSWER_MODES[0]).toEqualTypeOf<"fresh">();
    expectTypeOf<AnswersV1["mode"]>().toEqualTypeOf<
      "fresh" | "adopt" | "upgrade"
    >();
    expectTypeOf<AnswersV1["schema"]>().toEqualTypeOf<"groundwork.answers">();
    expectTypeOf<AnswersV1["schemaVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<ValidationProfile>().toEqualTypeOf<"partial" | "complete">();
    expectTypeOf<PendingEntry>().toEqualTypeOf<{
      readonly pointer: string;
      readonly reason: string;
      readonly choices: readonly string[] | null;
      readonly evidence: string | null;
    }>();
    expectTypeOf<ValidationResult>().toEqualTypeOf<
      ReturnType<typeof validateAnswers>
    >();
    expectTypeOf<ValidationIssue>().toEqualTypeOf<{
      readonly pointer: string;
      readonly message: string;
    }>();
    expectTypeOf<ValidationResult>().toEqualTypeOf<
      | { readonly ok: true; readonly value: AnswersV1 }
      | { readonly ok: false; readonly errors: readonly ValidationIssue[] }
    >();
    expectTypeOf(validateAnswers).parameters.toEqualTypeOf<
      [unknown, ValidationProfile]
    >();
  });
});

describe("validateAnswers: valid documents", () => {
  test.each(
    DOCS.flatMap(([mode, build]) =>
      PROFILES.map((profile) => [mode, profile, build] as const),
    ),
  )("accepts a decided %s document under %s", (_mode, profile, build) => {
    const doc = build();
    const result = validateAnswers(doc, profile);
    expect(result).toEqual({ ok: true, value: doc });
  });

  test.each(DOCS)("round-trips %s through JSON", (_mode, build) => {
    const parsed: unknown = JSON.parse(JSON.stringify(build()));
    for (const profile of PROFILES) {
      expect(validateAnswers(parsed, profile).ok).toBe(true);
    }
  });

  it("accepts a partial document full of nulls and a non-empty pending list", () => {
    const doc = freshDoc();
    doc["interview"] = {
      kind: null,
      runtime: null,
      testsMandatory: null,
      ciDepth: null,
      keepAgents: null,
    };
    doc["pending"] = [
      {
        pointer: "/interview/kind",
        reason: "no default",
        choices: [...PROJECT_KINDS],
        evidence: null,
      },
      {
        pointer: "/interview/runtime",
        reason: "r",
        choices: null,
        evidence: "e",
      },
    ];
    expect(validateAnswers(doc, "partial").ok).toBe(true);
  });

  it("accepts null resolutions and null upgrade fields under partial", () => {
    const adopt = adoptDoc();
    (adopt["adopt"] as Json)["conflicts"] = [{ path: "q", resolution: null }];
    expect(validateAnswers(adopt, "partial").ok).toBe(true);

    const upgrade = upgradeDoc();
    upgrade["upgrade"] = {
      applySafe: null,
      removals: null,
      conflicts: [{ path: "q", resolution: null }],
    };
    expect(validateAnswers(upgrade, "partial").ok).toBe(true);
  });

  test.each(["..foo", "a..b", ".claude/settings.json", "dir/file.name"])(
    "accepts the path %j (dots are not traversal)",
    (path) => {
      const doc = setAt(
        adoptDoc(),
        ["adopt", "additions"],
        [{ path, action: "add" }],
      );
      expect(validateAnswers(doc, "complete").ok).toBe(true);
    },
  );
});

describe("validateAnswers: structure", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["an array", []],
    ["a string", "answers"],
    ["a number", 7],
  ])("rejects %s at the root pointer", (_name, value) => {
    for (const profile of PROFILES) {
      expect(pointersOf(value, profile)).toContain("");
    }
  });

  test.each([
    ["an unknown top-level key", ["extra"], "/extra"],
    ["an unknown interview key", ["interview", "extra"], "/interview/extra"],
    ["an unknown packs key", ["packs", "extra"], "/packs/extra"],
    ["an unknown plugins key", ["plugins", "extra"], "/plugins/extra"],
    ["an unknown guidance key", ["guidance", "extra"], "/guidance/extra"],
    ["an unknown fresh key", ["fresh", "extra"], "/fresh/extra"],
  ])("rejects %s with its pointer", (_name, path, pointer) => {
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(freshDoc(), path, 1), profile)).toContain(
        pointer,
      );
    }
  });

  it.each([
    ["adopt", ["adopt", "extra"], "/adopt/extra"],
    [
      "adopt addition",
      ["adopt", "additions", 0, "extra"],
      "/adopt/additions/0/extra",
    ],
    [
      "adopt conflict",
      ["adopt", "conflicts", 1, "extra"],
      "/adopt/conflicts/1/extra",
    ],
  ])("rejects an unknown %s key", (_name, path, pointer) => {
    expect(pointersOf(setAt(adoptDoc(), path, 1), "partial")).toContain(
      pointer,
    );
  });

  it.each([
    ["upgrade", ["upgrade", "extra"], "/upgrade/extra"],
    [
      "upgrade conflict",
      ["upgrade", "conflicts", 0, "extra"],
      "/upgrade/conflicts/0/extra",
    ],
    [
      "upgrade conflict takeKeys",
      ["upgrade", "conflicts", 0, "takeKeys"],
      "/upgrade/conflicts/0/takeKeys",
    ],
  ])("rejects an unknown %s key", (_name, path, pointer) => {
    expect(pointersOf(setAt(upgradeDoc(), path, []), "partial")).toContain(
      pointer,
    );
  });

  it("rejects an unknown key inside a pending entry", () => {
    const doc = setAt(
      freshDoc(),
      ["pending"],
      [{ pointer: "/x", reason: "r", choices: null, evidence: null, extra: 1 }],
    );
    expect(pointersOf(doc, "partial")).toContain("/pending/0/extra");
  });

  test.each([
    ["top level", [], "/__proto__"],
    ["interview", ["interview"], "/interview/__proto__"],
    ["packs", ["packs"], "/packs/__proto__"],
  ])("rejects an own __proto__ key at the %s", (_name, parent, pointer) => {
    const doc = freshDoc();
    const target =
      parent.length === 0 ? doc : (doc[parent[0] as string] as Json);
    // JSON.parse creates a real own "__proto__" property, unlike an object literal.
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as Json;
    Object.defineProperty(target, "__proto__", {
      value: payload["__proto__"],
      enumerable: true,
      configurable: true,
      writable: true,
    });
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain(pointer);
    }
    expect(({} as Json)["polluted"]).toBeUndefined();
  });

  test.each(["__proto__", "constructor", "prototype"])(
    "rejects the prototype-sensitive key %s inside an array item",
    (key) => {
      const item = JSON.parse(
        `{"path":"a","action":"add","${key}":{}}`,
      ) as unknown;
      const doc = setAt(adoptDoc(), ["adopt", "additions"], [item]);
      expect(pointersOf(doc, "partial")).toContain(`/adopt/additions/0/${key}`);
    },
  );

  test.each([
    ["schema", ["schema"], "/schema", "other"],
    ["schemaVersion", ["schemaVersion"], "/schemaVersion", 2],
    ["schemaVersion as string", ["schemaVersion"], "/schemaVersion", "1"],
  ])("rejects a wrong %s literal", (_name, path, pointer, bad) => {
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(freshDoc(), path, bad), profile)).toContain(
        pointer,
      );
    }
  });

  test.each([
    ["/schema", ["schema"]],
    ["/mode", ["mode"]],
    ["/basis", ["basis"]],
    ["/fresh", ["fresh"]],
    ["/interview", ["interview"]],
    ["/adopt", ["adopt"]],
    ["/upgrade", ["upgrade"]],
    ["/packs", ["packs"]],
    ["/plugins", ["plugins"]],
    ["/guidance", ["guidance"]],
    ["/pending", ["pending"]],
    ["/interview/kind", ["interview", "kind"]],
    ["/interview/keepAgents", ["interview", "keepAgents"]],
    ["/guidance/domains", ["guidance", "domains"]],
    ["/fresh/skipInstall", ["fresh", "skipInstall"]],
  ])("rejects a missing key at %s", (pointer, path) => {
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(freshDoc(), path, undefined), profile)).toContain(
        pointer,
      );
    }
  });

  test.each([
    ["mode", ["mode"], "/mode", "bogus"],
    ["mode as number", ["mode"], "/mode", 1],
    ["interview.kind", ["interview", "kind"], "/interview/kind", "app"],
    [
      "interview.runtime",
      ["interview", "runtime"],
      "/interview/runtime",
      "deno",
    ],
    [
      "interview.ciDepth",
      ["interview", "ciDepth"],
      "/interview/ciDepth",
      "heavy",
    ],
    [
      "interview.testsMandatory",
      ["interview", "testsMandatory"],
      "/interview/testsMandatory",
      "yes",
    ],
    [
      "interview.keepAgents not an array",
      ["interview", "keepAgents"],
      "/interview/keepAgents",
      "Explore",
    ],
    [
      "interview.keepAgents entry",
      ["interview", "keepAgents"],
      "/interview/keepAgents",
      ["Explore", 3],
    ],
    ["fresh.name", ["fresh", "name"], "/fresh/name", 5],
    ["fresh.skipInstall", ["fresh", "skipInstall"], "/fresh/skipInstall", "no"],
    ["packs.install", ["packs", "install"], "/packs/install", [1]],
    ["packs.decline as object", ["packs", "decline"], "/packs/decline", {}],
    ["plugins.enabled", ["plugins", "enabled"], "/plugins/enabled", "x"],
    ["plugins.declined", ["plugins", "declined"], "/plugins/declined", [null]],
    ["guidance.enabled", ["guidance", "enabled"], "/guidance/enabled", 1],
    ["guidance.domains", ["guidance", "domains"], "/guidance/domains", [true]],
    ["pending as object", ["pending"], "/pending", {}],
    ["pending entry not an object", ["pending"], "/pending/0", ["x"]],
  ])("rejects a bad %s with its pointer", (_name, path, pointer, bad) => {
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(freshDoc(), path, bad), profile)).toContain(
        pointer,
      );
    }
  });

  test.each([
    ["adopt.missedNotes", ["adopt", "missedNotes"], "/adopt/missedNotes", 5],
    [
      "addition action",
      ["adopt", "additions", 0, "action"],
      "/adopt/additions/0/action",
      "remove",
    ],
    [
      "conflict resolution",
      ["adopt", "conflicts", 0, "resolution"],
      "/adopt/conflicts/0/resolution",
      "overwrite",
    ],
    [
      "conflict takeKeys",
      ["adopt", "conflicts", 0, "takeKeys"],
      "/adopt/conflicts/0/takeKeys",
      "scripts",
    ],
    [
      "addition path type",
      ["adopt", "additions", 0, "path"],
      "/adopt/additions/0/path",
      3,
    ],
  ])("rejects a bad adopt %s", (_name, path, pointer, bad) => {
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(adoptDoc(), path, bad), profile)).toContain(
        pointer,
      );
    }
  });

  test.each([
    ["applySafe", ["upgrade", "applySafe"], "/upgrade/applySafe", "yes"],
    ["removals", ["upgrade", "removals"], "/upgrade/removals", "purge"],
    [
      "conflict resolution",
      ["upgrade", "conflicts", 0, "resolution"],
      "/upgrade/conflicts/0/resolution",
      "overwrite",
    ],
    [
      "merge-keys (adopt only)",
      ["upgrade", "conflicts", 0, "resolution"],
      "/upgrade/conflicts/0/resolution",
      "merge-keys",
    ],
  ])("rejects a bad upgrade %s", (_name, path, pointer, bad) => {
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(upgradeDoc(), path, bad), profile)).toContain(
        pointer,
      );
    }
  });

  test.each([
    [
      "missing reason",
      { pointer: "/a", choices: null, evidence: null },
      "/pending/0/reason",
    ],
    [
      "numeric pointer",
      { pointer: 1, reason: "r", choices: null, evidence: null },
      "/pending/0/pointer",
    ],
    [
      "string choices",
      { pointer: "/a", reason: "r", choices: "x", evidence: null },
      "/pending/0/choices",
    ],
    [
      "numeric evidence",
      { pointer: "/a", reason: "r", choices: null, evidence: 1 },
      "/pending/0/evidence",
    ],
  ])("rejects a pending entry with %s", (_name, entry, pointer) => {
    const doc = setAt(freshDoc(), ["pending"], [entry]);
    expect(pointersOf(doc, "partial")).toContain(pointer);
  });
});

describe("validateAnswers: collections are arrays, never path-keyed objects", () => {
  test.each([
    ["adopt.additions", adoptDoc, ["adopt", "additions"], "/adopt/additions"],
    ["adopt.conflicts", adoptDoc, ["adopt", "conflicts"], "/adopt/conflicts"],
    [
      "upgrade.conflicts",
      upgradeDoc,
      ["upgrade", "conflicts"],
      "/upgrade/conflicts",
    ],
  ])("rejects an object for %s", (_name, build, path, pointer) => {
    const keyed = { "a.txt": { action: "add" } };
    for (const profile of PROFILES) {
      expect(pointersOf(setAt(build(), path, keyed), profile)).toContain(
        pointer,
      );
    }
  });
});

describe("validateAnswers: paths", () => {
  const bad: readonly (readonly [string, string])[] = [
    ["empty", ""],
    ["NUL", "a\0b"],
    ["absolute", "/etc/passwd"],
    ["parent segment", ".."],
    ["leading parent", "../x"],
    ["embedded parent", "a/../b"],
    ["trailing parent", "a/.."],
  ];

  test.each(bad)("rejects an %s addition path", (_name, path) => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "additions"],
      [{ path, action: "add" }],
    );
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain("/adopt/additions/0/path");
    }
  });

  test.each(bad)("rejects an %s adopt conflict path", (_name, path) => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "conflicts"],
      [{ path, resolution: "keep" }],
    );
    expect(pointersOf(doc, "partial")).toContain("/adopt/conflicts/0/path");
  });

  test.each(bad)("rejects an %s upgrade conflict path", (_name, path) => {
    const doc = setAt(
      upgradeDoc(),
      ["upgrade", "conflicts"],
      [{ path, resolution: "keep" }],
    );
    expect(pointersOf(doc, "partial")).toContain("/upgrade/conflicts/0/path");
  });

  it("allows one entry per path and rejects a duplicate in additions", () => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "additions"],
      [
        { path: "a.txt", action: "add" },
        { path: "b.txt", action: "add" },
        { path: "a.txt", action: "skip" },
      ],
    );
    const pointers = pointersOf(doc, "partial");
    expect(pointers.some((p) => p.startsWith("/adopt/additions/2"))).toBe(true);
    expect(pointers.some((p) => p.startsWith("/adopt/additions/1"))).toBe(
      false,
    );
  });

  it("rejects a duplicate path in adopt conflicts", () => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "conflicts"],
      [
        { path: "a.txt", resolution: "keep" },
        { path: "a.txt", resolution: "take" },
      ],
    );
    expect(
      pointersOf(doc, "partial").some((p) =>
        p.startsWith("/adopt/conflicts/1"),
      ),
    ).toBe(true);
  });

  it("rejects a duplicate path in upgrade conflicts", () => {
    const doc = setAt(
      upgradeDoc(),
      ["upgrade", "conflicts"],
      [
        { path: "a.txt", resolution: "keep" },
        { path: "a.txt", resolution: "take" },
      ],
    );
    expect(
      pointersOf(doc, "partial").some((p) =>
        p.startsWith("/upgrade/conflicts/1"),
      ),
    ).toBe(true);
  });

  it("allows the same path in additions and conflicts (separate collections)", () => {
    const doc = setAt(adoptDoc(), ["adopt"], {
      additions: [{ path: "a.txt", action: "add" }],
      conflicts: [{ path: "a.txt", resolution: "keep" }],
      missedNotes: "",
    });
    expect(validateAnswers(doc, "complete").ok).toBe(true);
  });
});

describe("validateAnswers: complete profile", () => {
  it("requires the mode's own section", () => {
    for (const [mode, build] of DOCS) {
      const doc = setAt(build(), [mode], null);
      expect(pointersOf(doc, "complete")).toContain(`/${mode}`);
    }
  });

  test.each([
    ["adopt", "fresh", freshDoc, ["adopt"], adoptDoc()["adopt"]],
    ["upgrade", "fresh", freshDoc, ["upgrade"], upgradeDoc()["upgrade"]],
    ["fresh", "adopt", adoptDoc, ["fresh"], freshDoc()["fresh"]],
    ["upgrade", "adopt", adoptDoc, ["upgrade"], upgradeDoc()["upgrade"]],
    ["fresh", "upgrade", upgradeDoc, ["fresh"], freshDoc()["fresh"]],
    ["adopt", "upgrade", upgradeDoc, ["adopt"], adoptDoc()["adopt"]],
  ])(
    "rejects a foreign %s section in a %s-mode document",
    (section, _mode, build, path, value) => {
      const doc = setAt(build(), path, value);
      expect(pointersOf(doc, "complete")).toContain(`/${section}`);
    },
  );

  test.each([
    ["kind", "fresh", freshDoc],
    ["runtime", "fresh", freshDoc],
    ["kind", "adopt", adoptDoc],
    ["runtime", "adopt", adoptDoc],
  ])("requires interview.%s in %s mode", (field, _mode, build) => {
    const doc = setAt(build(), ["interview", field], null);
    expect(pointersOf(doc, "complete")).toContain(`/interview/${field}`);
    expect(validateAnswers(doc, "partial").ok).toBe(true);
  });

  it("does not require an interview for upgrade", () => {
    expect(validateAnswers(upgradeDoc(), "complete").ok).toBe(true);
  });

  it("rejects null resolutions", () => {
    const adopt = setAt(
      adoptDoc(),
      ["adopt", "conflicts", 1, "resolution"],
      null,
    );
    expect(pointersOf(adopt, "complete")).toContain(
      "/adopt/conflicts/1/resolution",
    );
    const upgrade = setAt(
      upgradeDoc(),
      ["upgrade", "conflicts", 0, "resolution"],
      null,
    );
    expect(pointersOf(upgrade, "complete")).toContain(
      "/upgrade/conflicts/0/resolution",
    );
  });

  it("rejects null upgrade fields", () => {
    for (const field of ["applySafe", "removals"]) {
      const doc = setAt(upgradeDoc(), ["upgrade", field], null);
      expect(pointersOf(doc, "complete")).toContain(`/upgrade/${field}`);
      expect(validateAnswers(doc, "partial").ok).toBe(true);
    }
  });

  it("rejects a non-empty pending list but accepts it as partial", () => {
    const doc = setAt(
      freshDoc(),
      ["pending"],
      [
        {
          pointer: "/interview/kind",
          reason: "r",
          choices: null,
          evidence: null,
        },
      ],
    );
    expect(pointersOf(doc, "complete")).toContain("/pending");
    expect(validateAnswers(doc, "partial").ok).toBe(true);
  });

  test.each([
    ["adopt", adoptDoc],
    ["upgrade", upgradeDoc],
  ])("requires a basis for %s", (_mode, build) => {
    const doc = setAt(build(), ["basis"], null);
    expect(pointersOf(doc, "complete")).toContain("/basis");
  });

  it("requires a null basis for fresh", () => {
    const doc = setAt(freshDoc(), ["basis"], { inventorySha256: SHA });
    expect(pointersOf(doc, "complete")).toContain("/basis");
  });

  it("accepts either basis shape only with its exact key", () => {
    const both = setAt(adoptDoc(), ["basis"], {
      inventorySha256: SHA,
      planSha256: SHA,
    });
    expect(validateAnswers(both, "complete").ok).toBe(false);
    const wrong = setAt(adoptDoc(), ["basis"], { sha: SHA });
    expect(validateAnswers(wrong, "partial").ok).toBe(false);
    const nonString = setAt(adoptDoc(), ["basis"], { inventorySha256: 1 });
    expect(
      pointersOf(nonString, "partial").some((p) => p.startsWith("/basis")),
    ).toBe(true);
  });

  it("allows takeKeys only with resolution merge-keys", () => {
    for (const resolution of ["keep", "take", "delegate"]) {
      const doc = setAt(
        adoptDoc(),
        ["adopt", "conflicts"],
        [{ path: "x.json", resolution, takeKeys: ["scripts"] }],
      );
      expect(pointersOf(doc, "complete")).toContain(
        "/adopt/conflicts/0/takeKeys",
      );
    }
    const ok = setAt(
      adoptDoc(),
      ["adopt", "conflicts"],
      [{ path: "x.json", resolution: "merge-keys", takeKeys: ["scripts"] }],
    );
    expect(validateAnswers(ok, "complete").ok).toBe(true);
  });
});

describe("validateAnswers: never throws", () => {
  const hostile: readonly (readonly [string, () => unknown])[] = [
    [
      "a cyclic object",
      () => {
        const doc = freshDoc();
        (doc["guidance"] as Json)["self"] = doc;
        doc["loop"] = doc;
        return doc;
      },
    ],
    [
      "a cyclic array in a field",
      () => {
        const cycle: unknown[] = [];
        cycle.push(cycle);
        return setAt(freshDoc(), ["guidance", "domains"], cycle);
      },
    ],
    [
      "a throwing getter on a known key",
      () => {
        const doc = freshDoc();
        Object.defineProperty(doc, "mode", {
          enumerable: true,
          get() {
            throw new Error("boom");
          },
        });
        return doc;
      },
    ],
    [
      "a throwing getter on an unknown key",
      () => {
        const doc = freshDoc();
        Object.defineProperty(doc, "extra", {
          enumerable: true,
          get() {
            throw new Error("boom");
          },
        });
        return doc;
      },
    ],
    [
      "a throwing getter in a nested section",
      () => {
        const doc = freshDoc();
        Object.defineProperty(doc["interview"], "kind", {
          enumerable: true,
          get() {
            throw new Error("boom");
          },
        });
        return doc;
      },
    ],
    [
      "a proxy whose traps all throw",
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("get");
            },
            has() {
              throw new Error("has");
            },
            ownKeys() {
              throw new Error("ownKeys");
            },
            getOwnPropertyDescriptor() {
              throw new Error("gopd");
            },
            getPrototypeOf() {
              throw new Error("gpo");
            },
          },
        ),
    ],
    [
      "a revoked proxy",
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
    [
      "a proxy wrapping a valid document that throws on get",
      () =>
        new Proxy(freshDoc(), {
          get() {
            throw new Error("get");
          },
        }),
    ],
    [
      "a very deeply nested array",
      () => {
        let deep: unknown = [];
        for (let i = 0; i < 200_000; i += 1) deep = [deep];
        return setAt(freshDoc(), ["guidance", "domains"], deep);
      },
    ],
    [
      "a very deeply nested object",
      () => {
        let deep: unknown = {};
        for (let i = 0; i < 200_000; i += 1) deep = { a: deep };
        return { ...freshDoc(), extra: deep };
      },
    ],
    [
      "a deeply nested pending choices",
      () => {
        let deep: unknown = [];
        for (let i = 0; i < 200_000; i += 1) deep = [deep];
        return setAt(
          freshDoc(),
          ["pending"],
          [{ pointer: "/x", reason: "r", choices: deep, evidence: null }],
        );
      },
    ],
  ];

  test.each(hostile)(
    "returns ok:false for %s under both profiles",
    (_name, make) => {
      const value = make();
      for (const profile of PROFILES) {
        let result: ReturnType<typeof validateAnswers> | undefined;
        expect(() => {
          result = validateAnswers(value, profile);
        }).not.toThrow();
        expect(result?.ok).toBe(false);
        if (result !== undefined && !result.ok) {
          expect(result.errors.length).toBeGreaterThan(0);
          for (const error of result.errors) {
            expect(typeof error.pointer).toBe("string");
            expect(typeof error.message).toBe("string");
          }
        }
      }
    },
  );

  it("still accepts a modest number of entries", () => {
    const some = Array.from({ length: 100 }, (_, i) => ({
      path: `f${String(i)}`,
      action: "add",
    }));
    const doc = setAt(adoptDoc(), ["adopt", "additions"], some);
    expect(validateAnswers(doc, "complete").ok).toBe(true);
  });
});

describe("validateAnswers: properties", () => {
  it("never throws and always returns a well-formed result for arbitrary JSON", () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.constantFrom(...PROFILES),
        (value, profile) => {
          const result = validateAnswers(value, profile);
          if (result.ok) return true;
          return (
            result.errors.length > 0 &&
            result.errors.every(
              (e) =>
                typeof e.pointer === "string" && typeof e.message === "string",
            )
          );
        },
      ),
    );
  });

  const pathArb = fc.uniqueArray(
    fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,2}$/),
    {
      maxLength: 6,
    },
  );
  const nullable = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null });
  const interviewArb = fc.record({
    kind: nullable(fc.constantFrom(...PROJECT_KINDS)),
    runtime: nullable(fc.constantFrom(...RUNTIME_TARGETS)),
    testsMandatory: nullable(fc.boolean()),
    ciDepth: nullable(fc.constantFrom(...CI_DEPTHS)),
    keepAgents: nullable(fc.subarray([...BASELINE_AGENTS])),
  });
  const docArb = fc
    .tuple(
      fc.constantFrom(...ANSWER_MODES),
      interviewArb,
      pathArb,
      pathArb,
      fc.constantFrom(...CONFLICT_RESOLUTIONS, null),
      fc.constantFrom("keep", "take", "delegate", null),
      fc.string(),
    )
    .map(
      ([mode, interview, adds, conflicts, resolution, upResolution, notes]) => {
        const doc = freshDoc();
        doc["mode"] = mode;
        doc["interview"] = interview;
        doc["fresh"] =
          mode === "fresh" ? { name: "n", skipInstall: true } : null;
        doc["basis"] =
          mode === "adopt"
            ? { inventorySha256: SHA }
            : mode === "upgrade"
              ? { planSha256: SHA }
              : null;
        doc["adopt"] =
          mode === "adopt"
            ? {
                additions: adds.map((path) => ({ path, action: "add" })),
                conflicts: conflicts.map((path) => ({ path, resolution })),
                missedNotes: notes,
              }
            : null;
        doc["upgrade"] =
          mode === "upgrade"
            ? {
                applySafe: null,
                removals: null,
                conflicts: conflicts.map((path) => ({
                  path,
                  resolution: upResolution,
                })),
              }
            : null;
        return doc;
      },
    );

  it("accepts any partial document built from the tuples", () => {
    fc.assert(fc.property(docArb, (doc) => validateAnswers(doc, "partial").ok));
  });

  const MUTATIONS: readonly {
    readonly mode: string;
    readonly path: readonly (string | number)[];
  }[] = [
    { mode: "fresh", path: ["schema"] },
    { mode: "fresh", path: ["schemaVersion"] },
    { mode: "fresh", path: ["mode"] },
    { mode: "fresh", path: ["interview", "kind"] },
    { mode: "fresh", path: ["interview", "runtime"] },
    { mode: "fresh", path: ["interview", "ciDepth"] },
    { mode: "adopt", path: ["adopt", "additions", 0, "action"] },
    { mode: "adopt", path: ["adopt", "conflicts", 0, "resolution"] },
    { mode: "upgrade", path: ["upgrade", "conflicts", 0, "resolution"] },
    { mode: "upgrade", path: ["upgrade", "removals"] },
  ];
  const baseFor: Record<string, () => Json> = {
    fresh: freshDoc,
    adopt: adoptDoc,
    upgrade: upgradeDoc,
  };
  const ENUM_VALUES = new Set<unknown>([
    ...PROJECT_KINDS,
    ...RUNTIME_TARGETS,
    ...CI_DEPTHS,
    ...ANSWER_MODES,
    ...CONFLICT_RESOLUTIONS,
    "add",
    "skip",
    "delete",
    "groundwork.answers",
    1,
  ]);

  it("fails with the mutated field's pointer when it leaves its enum", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MUTATIONS),
        fc.constantFrom(...PROFILES),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (mutation, profile, bad) => {
          fc.pre(!ENUM_VALUES.has(bad));
          const doc = setAt(
            (baseFor[mutation.mode] ?? freshDoc)(),
            mutation.path,
            bad,
          );
          const pointer = `/${mutation.path.map(String).join("/")}`;
          return pointersOf(doc, profile).includes(pointer);
        },
      ),
    );
  });
});

describe("validateAnswers: documented edge paths", () => {
  it("caps the errors one call reports at 100 and still fails", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      path: `f${String(i)}`,
      action: "bogus",
    }));
    const doc = setAt(adoptDoc(), ["adopt", "additions"], many);
    for (const profile of PROFILES) {
      const errors = errorsOf(doc, profile);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.length).toBeLessThanOrEqual(100);
    }
  });

  it("reports an array whose length getter throws at the array field", () => {
    const hostile = new Proxy(["a"], {
      get(target, key, receiver) {
        if (key === "length") throw new Error("length");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const doc = setAt(freshDoc(), ["guidance", "domains"], []);
    (doc["guidance"] as Json)["domains"] = hostile;
    for (const profile of PROFILES) {
      expect(() => validateAnswers(doc, profile)).not.toThrow();
      expect(pointersOf(doc, profile)).toContain("/guidance/domains");
    }
  });

  it("reports an array whose element read throws at the array field", () => {
    const hostile: unknown[] = ["a"];
    Object.defineProperty(hostile, 0, {
      enumerable: true,
      get() {
        throw new Error("element");
      },
    });
    const doc = setAt(freshDoc(), ["packs", "install"], []);
    (doc["packs"] as Json)["install"] = hostile;
    for (const profile of PROFILES) {
      expect(() => validateAnswers(doc, profile)).not.toThrow();
      expect(pointersOf(doc, profile)).toContain("/packs/install");
    }
  });

  test.each([
    ["a backslash", "a\\b"],
    ["a leading backslash", "\\a"],
    ["a drive letter with a slash", "C:/x"],
    ["a bare drive-letter prefix", "C:foo"],
    ["a lowercase drive-letter prefix", "c:foo"],
  ])("rejects %s in a path at .../path", (_name, path) => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "additions"],
      [{ path, action: "add" }],
    );
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain("/adopt/additions/0/path");
    }
  });

  it("rejects a non-string takeKeys entry at its own pointer", () => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "conflicts"],
      [{ path: "x.json", resolution: "merge-keys", takeKeys: ["ok", 3] }],
    );
    expect(pointersOf(doc, "partial")).toContain(
      "/adopt/conflicts/0/takeKeys/1",
    );
  });

  test.each(["__proto__", "constructor", "prototype"])(
    "rejects the prototype-sensitive takeKeys entry %s",
    (key) => {
      const doc = setAt(
        adoptDoc(),
        ["adopt", "conflicts"],
        [{ path: "x.json", resolution: "merge-keys", takeKeys: [key] }],
      );
      for (const profile of PROFILES) {
        expect(pointersOf(doc, profile)).toContain(
          "/adopt/conflicts/0/takeKeys/0",
        );
      }
    },
  );

  test.each([
    ["a string", "abc"],
    ["an array", [SHA]],
    ["a number", 5],
  ])("rejects %s as the basis at /basis", (_name, basis) => {
    const doc = setAt(adoptDoc(), ["basis"], basis);
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain("/basis");
    }
  });

  test.each([
    ["adopt", adoptDoc, { planSha256: SHA }],
    ["upgrade", upgradeDoc, { inventorySha256: SHA }],
  ])(
    "rejects a %s basis whose key does not match the mode under complete",
    (_mode, build, basis) => {
      const doc = setAt(build(), ["basis"], basis);
      expect(pointersOf(doc, "complete")).toContain("/basis");
    },
  );

  it("accepts a null addition action under partial but not complete", () => {
    const doc = setAt(adoptDoc(), ["adopt", "additions", 0, "action"], null);
    expect(validateAnswers(doc, "partial").ok).toBe(true);
    expect(pointersOf(doc, "complete")).toContain("/adopt/additions/0/action");
  });

  it("accepts merge-keys without takeKeys", () => {
    const doc = setAt(
      adoptDoc(),
      ["adopt", "conflicts"],
      [{ path: "x.json", resolution: "merge-keys" }],
    );
    for (const profile of PROFILES) {
      expect(validateAnswers(doc, profile).ok).toBe(true);
    }
  });
});

/** The validated value of `doc`; fails the test when it is rejected. */
function valueOf(doc: unknown, profile: ValidationProfile): unknown {
  const result = validateAnswers(doc, profile);
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** Every object and array reachable from `root` (including `root`), by identity. */
function referencesIn(root: unknown): Set<object> {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(root);
  return seen;
}

/** A getter-backed copy of `doc` whose `key` answers `first` once, then `later`. */
function withFlipping(
  target: Json,
  key: string,
  first: unknown,
  later: unknown,
): void {
  let reads = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? first : later;
    },
  });
}

describe("validateAnswers: ok:true carries a fresh, frozen projection", () => {
  test.each(DOCS)("a %s document is copied, not returned", (_mode, build) => {
    const doc = build();
    for (const profile of PROFILES) {
      const value = valueOf(doc, profile);
      expect(value).not.toBe(doc);
      const input = referencesIn(doc);
      for (const ref of referencesIn(value)) {
        expect(input.has(ref)).toBe(false);
      }
    }
  });

  test.each(DOCS)("a %s projection is deeply frozen", (_mode, build) => {
    const value = valueOf(build(), "complete");
    const refs = referencesIn(value);
    expect(refs.size).toBeGreaterThan(3);
    for (const ref of refs) expect(Object.isFrozen(ref)).toBe(true);
  });

  test.each(DOCS)(
    "a %s projection equals the input after JSON",
    (_m, build) => {
      const doc = build();
      const value = valueOf(doc, "partial");
      expect(JSON.parse(JSON.stringify(value))).toEqual(doc);
    },
  );

  it("is unaffected by mutating the input after validation", () => {
    const doc = adoptDoc();
    const snapshot = structuredClone(doc);
    const value = valueOf(doc, "complete");
    ((doc["adopt"] as Json)["additions"] as unknown[]).push({ path: "evil" });
    (doc["adopt"] as Json)["missedNotes"] = "changed";
    (doc["interview"] as Json)["kind"] = "bogus";
    (doc["packs"] as Json)["install"] = ["evil"];
    doc["mode"] = "fresh";
    expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  });

  test.each([
    ["a boolean field", ["guidance"], "enabled", true, "evil"],
    ["a string field", ["fresh"], "name", "acme", 42],
    ["an array field", ["packs"], "install", ["ok"], [7]],
  ])(
    "reads %s once: a getter's second answer never reaches the value",
    (_name, parent, key, first, later) => {
      const doc = freshDoc();
      let host = doc;
      for (const step of parent) host = host[step] as Json;
      withFlipping(host, key, first, later);
      const value = valueOf(doc, "partial") as Json;
      let at = value;
      for (const step of parent) at = at[step] as Json;
      expect(at[key]).toEqual(first);
    },
  );

  it("reads a nested array element once", () => {
    const doc = freshDoc();
    const domains: unknown[] = ["x"];
    let reads = 0;
    Object.defineProperty(domains, 0, {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "first" : 99;
      },
    });
    (doc["guidance"] as Json)["domains"] = domains;
    const value = valueOf(doc, "partial") as { guidance: { domains: unknown } };
    expect(value.guidance.domains).toEqual(["first"]);
  });

  it("does not leak a proxy whose later reads and key listings differ", () => {
    const doc = freshDoc();
    let gets = 0;
    let listings = 0;
    const packs = new Proxy(
      { install: ["a"], decline: [] as string[] },
      {
        get(target, key, receiver) {
          if (key === "install") {
            gets += 1;
            return gets === 1 ? ["a"] : ["leak"];
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
        ownKeys(target) {
          listings += 1;
          const keys = Reflect.ownKeys(target);
          return listings === 1 ? keys : [...keys, "bonus"];
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === "bonus") {
            return { value: 1, enumerable: true, configurable: true };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    doc["packs"] = packs;
    const value = valueOf(doc, "partial") as {
      packs: Record<string, unknown>;
    };
    expect(JSON.parse(JSON.stringify(value.packs))).toEqual({
      install: ["a"],
      decline: [],
    });
    expect(Object.keys(value.packs).sort()).toEqual(["decline", "install"]);
  });

  it("drops symbol keys and extra properties on arrays", () => {
    const doc = freshDoc();
    const domains = ["a"] as string[] & Record<string | symbol, unknown>;
    domains["extra"] = "x";
    domains[Symbol("s")] = "y";
    (doc["guidance"] as Json)["domains"] = domains;
    (doc as Record<symbol, unknown>)[Symbol("top")] = "z";
    const value = valueOf(doc, "partial") as {
      guidance: { domains: unknown[] };
    };
    expect(Object.keys(value.guidance.domains)).toEqual(["0"]);
    expect(Reflect.ownKeys(value.guidance.domains)).toEqual(["0", "length"]);
    expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  });
});

describe("validateAnswers: plain objects only", () => {
  class Evil {
    path = "x.json";
    resolution = "keep";
  }
  const adoptWith = (conflict: unknown) =>
    setAt(adoptDoc(), ["adopt", "conflicts"], [conflict]);

  it("accepts null-prototype objects", () => {
    const doc = freshDoc();
    doc["packs"] = Object.assign(Object.create(null) as Json, {
      install: [],
      decline: [],
    });
    expect(validateAnswers(doc, "complete").ok).toBe(true);
  });

  it("rejects a class instance as a conflict entry at that entry", () => {
    const doc = adoptWith(new Evil());
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain("/adopt/conflicts/0");
    }
  });

  it("rejects an inherited takeKeys at the conflict entry", () => {
    const hidden = Object.create({ takeKeys: ["__proto__"] }) as Json;
    hidden["path"] = "x.json";
    hidden["resolution"] = "merge-keys";
    const doc = adoptWith(hidden);
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain("/adopt/conflicts/0");
    }
  });

  test.each([
    ["top level", [] as string[]],
    ["packs", ["packs"]],
    ["interview", ["interview"]],
    ["fresh", ["fresh"]],
  ])("rejects a non-plain prototype on the %s object", (_name, path) => {
    const doc = freshDoc();
    const target = path.length === 0 ? doc : (doc[path[0] as string] as Json);
    Object.setPrototypeOf(target, { inherited: true });
    const pointer = path.length === 0 ? "" : `/${path.join("/")}`;
    for (const profile of PROFILES) {
      expect(pointersOf(doc, profile)).toContain(pointer);
    }
  });

  it("rejects a non-plain pending entry at that entry", () => {
    const entry = Object.create({ extra: 1 }) as Json;
    Object.assign(entry, {
      pointer: "/a",
      reason: "r",
      choices: null,
      evidence: null,
    });
    const doc = setAt(freshDoc(), ["pending"], [entry]);
    expect(pointersOf(doc, "partial")).toContain("/pending/0");
  });

  test.each(["keep", "merge-keys"])(
    "never lets a non-enumerable takeKeys (resolution %s) reach the result",
    (resolution) => {
      const entry: Json = { path: "x.json", resolution };
      Object.defineProperty(entry, "takeKeys", {
        value: ["__proto__"],
        enumerable: false,
      });
      const result = validateAnswers(adoptWith(entry), "complete");
      if (result.ok) {
        const conflict = (
          result.value.adopt?.conflicts as readonly object[]
        )[0] as object;
        expect(Reflect.ownKeys(conflict)).not.toContain("takeKeys");
        expect("takeKeys" in conflict).toBe(false);
      }
    },
  );
});

describe("validateAnswers: array length is read once", () => {
  const lengthProxy = (answers: () => unknown) =>
    new Proxy([] as unknown[], {
      get(target, key, receiver) {
        if (key === "length") return answers();
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  const boundedOrRejected = (domains: unknown) => {
    const doc = freshDoc();
    (doc["guidance"] as Json)["domains"] = domains;
    for (const profile of PROFILES) {
      const result = validateAnswers(doc, profile);
      if (result.ok) {
        expect(
          (result.value as { guidance: { domains: unknown } }).guidance.domains,
        ).toEqual([]);
      } else {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    }
  };

  it("survives a length trap that answers 0, then 4294967295", () => {
    let reads = 0;
    boundedOrRejected(lengthProxy(() => (reads++ === 0 ? 0 : 4_294_967_295)));
  }, 5000);

  it("survives an object-valued length with a changing valueOf", () => {
    let reads = 0;
    const length = {
      valueOf: () => (reads++ === 0 ? 0 : 4_294_967_295),
    };
    boundedOrRejected(lengthProxy(() => length));
  }, 5000);
});

describe("validateAnswers: path rules", () => {
  const rejected: readonly string[] = [
    ".",
    "./",
    "a/.",
    "./a",
    "a//b",
    "a/",
    "/abs",
    "a/.. ",
    "a./b",
    "a/b.",
    "a /b",
    "a/b ",
    "a/ ",
    "a\nb",
    "a\rb",
    "a\tb",
    "a\u0001b",
    "a\u001fb",
    "a\u007fb",
    "a\n/..",
    ".git",
    ".git/config",
    ".GIT/hooks/x",
    ".Git/x",
    ".groundwork",
    ".groundwork/manifest.json",
    "a".repeat(4097),
  ];
  const accepted: readonly string[] = [
    "a.md",
    "docs/a.md",
    ".github/workflows/ci.yml",
    ".claude/settings.json",
    "..foo",
    "a..b",
    ".gitignore",
    ".gitattributes",
    "pkg/.git-keep",
    "pkg/.git/config",
    "pkg/.groundwork/x",
    "a".repeat(4096),
  ];
  const label = (path: string) =>
    JSON.stringify(
      path.length > 20 ? `${path.slice(0, 8)}...(${path.length})` : path,
    );
  const places: readonly (readonly [string, (path: string) => Json, string])[] =
    [
      [
        "addition",
        (path) =>
          setAt(adoptDoc(), ["adopt", "additions"], [{ path, action: "add" }]),
        "/adopt/additions/0/path",
      ],
      [
        "adopt conflict",
        (path) =>
          setAt(
            adoptDoc(),
            ["adopt", "conflicts"],
            [{ path, resolution: "keep" }],
          ),
        "/adopt/conflicts/0/path",
      ],
      [
        "upgrade conflict",
        (path) =>
          setAt(
            upgradeDoc(),
            ["upgrade", "conflicts"],
            [{ path, resolution: "keep" }],
          ),
        "/upgrade/conflicts/0/path",
      ],
    ];

  describe.each(places)("in an %s", (_place, make, pointer) => {
    test.each(rejected.map((p) => [label(p), p] as const))(
      "rejects %s at .../path",
      (_label, path) => {
        for (const profile of PROFILES) {
          expect(pointersOf(make(path), profile)).toContain(pointer);
        }
      },
    );
    test.each(accepted.map((p) => [label(p), p] as const))(
      "accepts %s",
      (_label, path) => {
        for (const profile of PROFILES) {
          expect(validateAnswers(make(path), profile).ok).toBe(true);
        }
      },
    );
  });
});

describe("validateAnswers: NTFS-aliasing and surrogate paths", () => {
  const make = (path: string): Json =>
    setAt(adoptDoc(), ["adopt", "additions"], [{ path, action: "add" }]);

  test.each([
    ".git::$INDEX_ALLOCATION/config",
    "a:b",
    "dir/f:ads",
    "dir/:x",
    "GIT~1/config",
    "Git~1",
    "git~1",
    "a\uD800",
    "a\uDC00",
    "\uD800/x",
    "\uDC00\uD800",
    ".g\u0131t",
    ".g\u0131t/x",
    "g\u0131t~1",
    "g\u0131t~1/x",
    "GIT~1",
  ])("rejects %j at /adopt/additions/0/path", (path) => {
    for (const profile of PROFILES) {
      expect(pointersOf(make(path), profile)).toContain(
        "/adopt/additions/0/path",
      );
    }
  });

  test.each([
    "a~1",
    "git~2/x",
    "pkg/git~1/x",
    ".g\u0131tignore",
    "pkg/.g\u0131t/x",
  ])("still accepts %j", (path) => {
    for (const profile of PROFILES) {
      expect(validateAnswers(make(path), profile).ok).toBe(true);
    }
  });
});

describe("validateAnswers: duplicate paths ignore case and Unicode form", () => {
  const nfc = "café.md";
  const nfd = "café.md";
  const places: readonly (readonly [
    string,
    (a: string, b: string) => Json,
    string,
  ])[] = [
    [
      "additions",
      (a, b) =>
        setAt(
          adoptDoc(),
          ["adopt", "additions"],
          [
            { path: a, action: "add" },
            { path: b, action: "add" },
          ],
        ),
      "/adopt/additions/1/path",
    ],
    [
      "adopt conflicts",
      (a, b) =>
        setAt(
          adoptDoc(),
          ["adopt", "conflicts"],
          [
            { path: a, resolution: "keep" },
            { path: b, resolution: "take" },
          ],
        ),
      "/adopt/conflicts/1/path",
    ],
    [
      "upgrade conflicts",
      (a, b) =>
        setAt(
          upgradeDoc(),
          ["upgrade", "conflicts"],
          [
            { path: a, resolution: "keep" },
            { path: b, resolution: "take" },
          ],
        ),
      "/upgrade/conflicts/1/path",
    ],
  ];

  describe.each(places)("in %s", (_name, make, pointer) => {
    test.each([
      ["a case difference", "A.md", "a.md"],
      ["a case difference in a directory", "Docs/A.md", "docs/a.md"],
      ["NFC versus NFD", nfc, nfd],
      ["NFD versus NFC and case", nfd, nfc.toUpperCase()],
      ["long s (U+017F) versus s in a directory", "\u017Frc/a", "src/a"],
      ["dotless i (U+0131) versus I", "\u0131.md", "I.md"],
      ["dotless i versus i in a directory", "Dir/\u0131.md", "dir/I.md"],
      ["dotless i versus lowercase i", "dir/\u0131.md", "dir/i.md"],
    ])("rejects %s at the later entry's path", (_what, first, second) => {
      for (const profile of PROFILES) {
        expect(pointersOf(make(first, second), profile)).toContain(pointer);
      }
    });

    it("still accepts two different paths", () => {
      expect(validateAnswers(make("a.md", "b.md"), "complete").ok).toBe(true);
    });
  });
});

describe("validateAnswers: size limits", () => {
  const within = (pointers: readonly string[], at: string) =>
    pointers.some((p) => p === at || p.startsWith(`${at}/`));

  const arrays: readonly (readonly [
    string,
    () => Json,
    readonly (string | number)[],
    (n: number) => unknown,
  ])[] = [
    ["guidance.domains", freshDoc, ["guidance", "domains"], () => "a"],
    ["packs.install", freshDoc, ["packs", "install"], () => "a"],
    ["packs.decline", freshDoc, ["packs", "decline"], () => "a"],
    ["plugins.enabled", freshDoc, ["plugins", "enabled"], () => "a"],
    ["plugins.declined", freshDoc, ["plugins", "declined"], () => "a"],
    ["interview.keepAgents", freshDoc, ["interview", "keepAgents"], () => "a"],
    [
      "adopt.additions",
      adoptDoc,
      ["adopt", "additions"],
      (n) => ({ path: `f${String(n)}`, action: "add" }),
    ],
    [
      "adopt.conflicts",
      adoptDoc,
      ["adopt", "conflicts"],
      (n) => ({ path: `f${String(n)}`, resolution: "keep" }),
    ],
    [
      "upgrade.conflicts",
      upgradeDoc,
      ["upgrade", "conflicts"],
      (n) => ({ path: `f${String(n)}`, resolution: "keep" }),
    ],
    [
      "pending",
      freshDoc,
      ["pending"],
      (n) => ({
        pointer: `/p${String(n)}`,
        reason: "r",
        choices: null,
        evidence: null,
      }),
    ],
  ];

  test.each(arrays)(
    "accepts exactly 10000 entries in %s",
    (_name, build, path, entry) => {
      const items = Array.from({ length: 10_000 }, (_, i) => entry(i));
      const doc = setAt(build(), path, items);
      expect(validateAnswers(doc, "partial").ok).toBe(true);
    },
    20_000,
  );

  test.each(arrays)(
    "rejects 10001 entries in %s at the array's pointer",
    (_name, build, path, entry) => {
      const items = Array.from({ length: 10_001 }, (_, i) => entry(i));
      const doc = setAt(build(), path, items);
      expect(pointersOf(doc, "partial")).toContain(`/${path.join("/")}`);
    },
    20_000,
  );

  it("accepts exactly 10000 takeKeys and rejects 10001", () => {
    const keys = (n: number) =>
      Array.from({ length: n }, (_, i) => `k${String(i)}`);
    const make = (n: number) =>
      setAt(
        adoptDoc(),
        ["adopt", "conflicts"],
        [{ path: "x.json", resolution: "merge-keys", takeKeys: keys(n) }],
      );
    expect(validateAnswers(make(10_000), "complete").ok).toBe(true);
    expect(pointersOf(make(10_001), "complete")).toContain(
      "/adopt/conflicts/0/takeKeys",
    );
  }, 20_000);

  it("fails fast, with at most 100 errors, when one array is reused everywhere", () => {
    const shared = Array.from({ length: 10_000 }, () => "a");
    const entry = {
      pointer: "/x",
      reason: "r",
      choices: shared,
      evidence: null,
    };
    const doc = freshDoc();
    doc["pending"] = Array.from({ length: 10_000 }, () => entry);
    const errors = errorsOf(doc, "partial");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThanOrEqual(100);
  }, 20_000);

  const strings: readonly (readonly [
    string,
    () => Json,
    (value: string) => Json,
    string,
    number,
  ])[] = [
    [
      "adopt.missedNotes",
      adoptDoc,
      (v) => setAt(adoptDoc(), ["adopt", "missedNotes"], v),
      "/adopt/missedNotes",
      10_000,
    ],
    [
      "pending reason",
      freshDoc,
      (v) =>
        setAt(
          freshDoc(),
          ["pending"],
          [{ pointer: "/a", reason: v, choices: null, evidence: null }],
        ),
      "/pending/0/reason",
      10_000,
    ],
    [
      "pending evidence",
      freshDoc,
      (v) =>
        setAt(
          freshDoc(),
          ["pending"],
          [{ pointer: "/a", reason: "r", choices: null, evidence: v }],
        ),
      "/pending/0/evidence",
      10_000,
    ],
    [
      "pending pointer",
      freshDoc,
      (v) =>
        setAt(
          freshDoc(),
          ["pending"],
          [{ pointer: v, reason: "r", choices: null, evidence: null }],
        ),
      "/pending/0/pointer",
      1000,
    ],
    [
      "guidance domain",
      freshDoc,
      (v) => setAt(freshDoc(), ["guidance", "domains"], [v]),
      "/guidance/domains",
      1000,
    ],
    [
      "plugin id",
      freshDoc,
      (v) => setAt(freshDoc(), ["plugins", "enabled"], [v]),
      "/plugins/enabled",
      1000,
    ],
    [
      "declined plugin id",
      freshDoc,
      (v) => setAt(freshDoc(), ["plugins", "declined"], [v]),
      "/plugins/declined",
      1000,
    ],
    [
      "pack name",
      freshDoc,
      (v) => setAt(freshDoc(), ["packs", "install"], [v]),
      "/packs/install",
      1000,
    ],
    [
      "declined pack name",
      freshDoc,
      (v) => setAt(freshDoc(), ["packs", "decline"], [v]),
      "/packs/decline",
      1000,
    ],
    [
      "agent name",
      freshDoc,
      (v) => setAt(freshDoc(), ["interview", "keepAgents"], [v]),
      "/interview/keepAgents",
      1000,
    ],
    [
      "takeKeys entry",
      adoptDoc,
      (v) =>
        setAt(
          adoptDoc(),
          ["adopt", "conflicts"],
          [{ path: "x.json", resolution: "merge-keys", takeKeys: [v] }],
        ),
      "/adopt/conflicts/0/takeKeys",
      1000,
    ],
  ];

  test.each(strings)(
    "caps the %s at its limit",
    (_name, _build, make, pointer, limit) => {
      // The complete profile requires `pending` empty, so the pending
      // entries are checked under the partial profile only.
      const profiles: readonly ValidationProfile[] = _name.startsWith("pending")
        ? ["partial"]
        : PROFILES;
      for (const profile of profiles) {
        expect(validateAnswers(make("a".repeat(limit)), profile).ok).toBe(true);
        expect(
          within(pointersOf(make("a".repeat(limit + 1)), profile), pointer),
        ).toBe(true);
      }
    },
  );
});

describe("validateAnswers: hardening", () => {
  const KELVIN = "\u212A";
  test.each([
    [".GROUNDWORK/x"],
    [".Groundwork"],
    [".GIT/config"],
    [`.groundwor${KELVIN}`],
    [`.groundwor${KELVIN}/x`],
  ])("rejects the protected first segment %j at .../path", (path) => {
    for (const profile of PROFILES) {
      expect(
        pointersOf(
          setAt(adoptDoc(), ["adopt", "additions"], [{ path, action: "add" }]),
          profile,
        ),
      ).toContain("/adopt/additions/0/path");
    }
  });

  it("rejects an array whose prototype is not Array.prototype at the array pointer", () => {
    const names: unknown[] = ["a"];
    Object.setPrototypeOf(names, Object.create(Array.prototype) as object);
    const doc = freshDoc();
    (doc["packs"] as Json)["install"] = names; // set directly: structuredClone would drop the prototype
    expect(pointersOf(doc, "partial")).toContain("/packs/install");
  });

  it("rejects a sparse array at the array pointer", () => {
    // eslint-disable-next-line no-sparse-arrays -- a hole is the input under test
    const sparse: unknown[] = ["a", , "c"];
    const doc = freshDoc();
    (doc["packs"] as Json)["install"] = sparse;
    expect(pointersOf(doc, "partial")).toContain("/packs/install");
  });

  it("stops at 100 errors and still returns ok:false", () => {
    const doc = freshDoc();
    doc["pending"] = Array.from({ length: 1000 }, () => ({}));
    const result = validateAnswers(doc, "partial");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(100);
  });

  it("reports exactly one budget error, without throwing, when the work budget runs out", () => {
    const shared = Array.from({ length: 10_000 }, () => "a");
    const entry = {
      pointer: "/x",
      reason: "r",
      choices: shared,
      evidence: null,
    };
    const doc = freshDoc();
    doc["pending"] = Array.from({ length: 10_000 }, () => entry);
    const result = validateAnswers(doc, "partial");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/work budget/);
    }
  }, 20_000);

  it("accepts a document at every top-level cap within the work budget, in reasonable time", () => {
    const strs = Array.from({ length: 10_000 }, (_, i) => `n${String(i)}`);
    const doc = adoptDoc();
    (doc["interview"] as Json)["keepAgents"] = strs;
    (doc["packs"] as Json)["install"] = strs;
    (doc["packs"] as Json)["decline"] = strs;
    (doc["plugins"] as Json)["enabled"] = strs;
    (doc["plugins"] as Json)["declined"] = strs;
    (doc["guidance"] as Json)["domains"] = strs;
    doc["adopt"] = {
      additions: Array.from({ length: 10_000 }, (_, i) => ({
        path: `a${String(i)}`,
        action: "add",
      })),
      conflicts: Array.from({ length: 10_000 }, (_, i) => ({
        path: `c${String(i)}`,
        resolution: "keep",
      })),
      missedNotes: "",
    };
    doc["upgrade"] = {
      applySafe: true,
      removals: "delete",
      conflicts: Array.from({ length: 10_000 }, (_, i) => ({
        path: `u${String(i)}`,
        resolution: "keep",
      })),
    };
    doc["pending"] = Array.from({ length: 10_000 }, (_, i) => ({
      pointer: `/p${String(i)}`,
      reason: "r",
      choices: null,
      evidence: null,
    }));
    expect(validateAnswers(doc, "partial").ok).toBe(true);
  }, 10_000);

  it("rejects 10000 pending entries x 100 choices (over 1,000,000 units via nested lists) with the single work-budget error", () => {
    const choices = Array.from({ length: 100 }, (_, i) => `c${String(i)}`);
    const doc = freshDoc();
    doc["pending"] = Array.from({ length: 10_000 }, (_, i) => ({
      pointer: `/p${String(i)}`,
      reason: "r",
      choices: [...choices],
      evidence: null,
    }));
    const result = validateAnswers(doc, "partial");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/work budget/);
    }
  }, 20_000);

  it("rejects a non-BMP path of 2049 emoji (4098 UTF-16 units); the schema's maxLength counts code points, so it is looser", () => {
    const path = "\u{1F600}".repeat(2049);
    expect(path.length).toBe(4098);
    expect(
      pointersOf(
        setAt(adoptDoc(), ["adopt", "additions"], [{ path, action: "add" }]),
        "partial",
      ),
    ).toContain("/adopt/additions/0/path");
  });
});

describe("validateAnswers: formats", () => {
  const shaOk = ["0123456789abcdef".repeat(4), "a".repeat(64), "0".repeat(64)];
  const shaBad: readonly (readonly [string, string])[] = [
    ["uppercase", "A".repeat(64)],
    ["mixed case", `A${"a".repeat(63)}`],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
    ["empty", ""],
    ["a trailing newline", `${"a".repeat(64)}\n`],
    ["a sha256: prefix", `sha256:${"a".repeat(64)}`],
  ];
  describe.each([
    ["inventorySha256", adoptDoc],
    ["planSha256", upgradeDoc],
  ] as const)("basis.%s", (key, build) => {
    test.each(shaOk)("accepts %s", (sha) => {
      for (const profile of PROFILES) {
        expect(
          validateAnswers(setAt(build(), ["basis"], { [key]: sha }), profile)
            .ok,
        ).toBe(true);
      }
    });
    test.each(shaBad)("rejects %s at its pointer", (_what, sha) => {
      for (const profile of PROFILES) {
        expect(
          pointersOf(setAt(build(), ["basis"], { [key]: sha }), profile),
        ).toContain(`/basis/${key}`);
      }
    });
  });

  const nameOk = ["acme", "n", "@scope/pkg", "a.b_c-d", "a1", "a".repeat(214)];
  const nameBad = [
    "../x",
    "",
    "Acme",
    "a b",
    "@/x",
    "@scope/",
    "x/y",
    "-x",
    ".x",
    "a\n",
    "a".repeat(215),
  ];
  test.each(nameOk)("accepts the fresh.name %j", (name) => {
    for (const profile of PROFILES) {
      expect(
        validateAnswers(setAt(freshDoc(), ["fresh", "name"], name), profile).ok,
      ).toBe(true);
    }
  });
  test.each(nameBad.map((n) => [n.length > 30 ? `(${n.length} chars)` : n, n]))(
    "rejects the fresh.name %j at /fresh/name",
    (_label, name) => {
      for (const profile of PROFILES) {
        expect(
          pointersOf(setAt(freshDoc(), ["fresh", "name"], name), profile),
        ).toContain("/fresh/name");
      }
    },
  );
});
