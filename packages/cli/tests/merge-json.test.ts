// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import {
  isRecord,
  mergePackageScripts,
  mergeSettingsHooks,
  mergeSettingsTopLevel,
  mergeVerifySteps,
} from "../src/merge-json.js";

describe("isRecord", () => {
  it("is true for a plain object, false for null/array/primitive", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("mergeSettingsHooks", () => {
  it("creates a hooks block from scratch when the existing settings object has none", () => {
    const merged = mergeSettingsHooks(
      { $schema: "https://example.com/schema.json" },
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "node foo.mjs", timeout: 30 }],
          },
        ],
      },
    );
    expect(merged).toEqual({
      $schema: "https://example.com/schema.json",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "node foo.mjs", timeout: 30 }],
          },
        ],
      },
    });
  });

  it("appends a hook to an existing matcher entry rather than duplicating the entry", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "node existing.mjs", timeout: 30 },
            ],
          },
        ],
      },
    };
    const merged = mergeSettingsHooks(existing, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node new.mjs", timeout: 30 }],
        },
      ],
    });
    const hooksBlock = merged["hooks"] as Record<
      string,
      { hooks: unknown[] }[]
    >;
    const entries = hooksBlock["PreToolUse"];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.hooks).toEqual([
      { type: "command", command: "node existing.mjs", timeout: 30 },
      { type: "command", command: "node new.mjs", timeout: 30 },
    ]);
  });

  it("treats a matcher-absent entry (e.g. PreCompact) as its own match group", () => {
    const merged = mergeSettingsHooks(
      {},
      {
        PreCompact: [
          {
            hooks: [
              { type: "command", command: "node write.mjs", timeout: 30 },
            ],
          },
        ],
      },
    );
    const hooksBlock = merged["hooks"] as Record<
      string,
      { matcher?: string }[]
    >;
    const entries = hooksBlock["PreCompact"];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.matcher).toBeUndefined();
  });

  it("creates a new matcher entry when no existing entry matches", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "a" }] },
        ],
      },
    };
    const merged = mergeSettingsHooks(existing, {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "b" }] },
      ],
    });
    const hooksBlock = merged["hooks"] as Record<string, unknown[]>;
    expect(hooksBlock["PreToolUse"]).toHaveLength(2);
  });

  it("is idempotent -- merging the identical fragment twice changes nothing further", () => {
    const fragment = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node foo.mjs", timeout: 30 }],
        },
      ],
    };
    const once = mergeSettingsHooks({}, fragment);
    const twice = mergeSettingsHooks(once, fragment);
    expect(twice).toEqual(once);
  });

  it("throws on a same-command, different-config collision rather than overwriting", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "node foo.mjs", timeout: 30 }],
          },
        ],
      },
    };
    expect(() =>
      mergeSettingsHooks(existing, {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "node foo.mjs", timeout: 60 }],
          },
        ],
      }),
    ).toThrow(/merge collision/);
  });
});

describe("mergePackageScripts", () => {
  it("adds new scripts and leaves existing ones alone", () => {
    const { scripts, collisions } = mergePackageScripts(
      { build: "tsc" },
      { lint: "eslint ." },
    );
    expect(scripts).toEqual({ build: "tsc", lint: "eslint ." });
    expect(collisions).toEqual([]);
  });

  it("treats an identical existing script as a no-op, not a collision", () => {
    const { scripts, collisions } = mergePackageScripts(
      { build: "tsc" },
      { build: "tsc" },
    );
    expect(scripts).toEqual({ build: "tsc" });
    expect(collisions).toEqual([]);
  });

  it("reports a collision for a differing existing script, without overwriting it", () => {
    const { scripts, collisions } = mergePackageScripts(
      { build: "tsc" },
      { build: "webpack" },
    );
    expect(scripts["build"]).toBe("tsc");
    expect(collisions).toEqual([
      { name: "build", existing: "tsc", incoming: "webpack" },
    ]);
  });

  it("treats an undefined existing scripts block as empty", () => {
    const { scripts } = mergePackageScripts(undefined, { build: "tsc" });
    expect(scripts).toEqual({ build: "tsc" });
  });
});

describe("mergeVerifySteps", () => {
  it("appends a new step to an empty or missing existing array", () => {
    const step = {
      id: "file-budget",
      group: "build",
      name: "x",
      cmd: ["node", "y.mjs"],
    };
    expect(mergeVerifySteps(undefined, [step])).toEqual([step]);
    expect(mergeVerifySteps([], [step])).toEqual([step]);
  });

  it("is idempotent -- merging the identical step twice yields one entry", () => {
    const step = {
      id: "file-budget",
      group: "build",
      name: "x",
      cmd: ["node", "y.mjs"],
    };
    const once = mergeVerifySteps([], [step]);
    const twice = mergeVerifySteps(once, [step]);
    expect(twice).toEqual([step]);
  });

  it("throws on a same-id, different-config collision", () => {
    const existing = [
      { id: "file-budget", group: "build", name: "x", cmd: ["node", "y.mjs"] },
    ];
    expect(() =>
      mergeVerifySteps(existing, [
        { id: "file-budget", group: "test", name: "x", cmd: ["node", "y.mjs"] },
      ]),
    ).toThrow(/merge collision/);
  });

  // Confirmatory regression tests for deepEqual's array-comparison branches
  // (deepEqual itself is not exported; these exercise it indirectly through
  // mergeVerifySteps, whose `cmd` field is a natural array fixture). Per the
  // dispatch, deepEqual's existing implementation is believed to already
  // handle these correctly -- these are PASS-today tests proving that belief,
  // not a RED-phase fix.
  it("throws a collision when a same-id step's cmd array differs only in LENGTH", () => {
    const existing = [
      { id: "x-gate", group: "build", name: "x", cmd: ["node", "a.mjs"] },
    ];
    expect(() =>
      mergeVerifySteps(existing, [
        {
          id: "x-gate",
          group: "build",
          name: "x",
          cmd: ["node", "a.mjs", "--extra"],
        },
      ]),
    ).toThrow(/merge collision/);
  });

  it("throws a collision when a same-id, same-length cmd array differs at some index", () => {
    const existing = [
      { id: "x-gate", group: "build", name: "x", cmd: ["node", "a.mjs"] },
    ];
    expect(() =>
      mergeVerifySteps(existing, [
        { id: "x-gate", group: "build", name: "x", cmd: ["node", "b.mjs"] },
      ]),
    ).toThrow(/merge collision/);
  });
});

describe("mergeSettingsTopLevel", () => {
  const statusLine = {
    type: "command",
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/statusline.mjs"',
    padding: 1,
  };

  it("appends a new top-level key after the existing ones, preserving $schema and hooks in order", () => {
    const merged = mergeSettingsTopLevel(
      { $schema: "https://example.com/schema.json", hooks: { Stop: [] } },
      { statusLine },
    );
    expect(Object.keys(merged)).toEqual(["$schema", "hooks", "statusLine"]);
    expect(merged["statusLine"]).toEqual(statusLine);
    expect(merged["hooks"]).toEqual({ Stop: [] });
  });

  it("creates the settings object from scratch when there is nothing to merge into", () => {
    expect(mergeSettingsTopLevel(undefined, { statusLine })).toEqual({
      statusLine,
    });
  });

  it("is idempotent: merging the same fragment twice equals merging it once", () => {
    const once = mergeSettingsTopLevel({ hooks: {} }, { statusLine });
    expect(mergeSettingsTopLevel(once, { statusLine })).toEqual(once);
  });

  it("throws on a same-key-different-value collision instead of overwriting", () => {
    expect(() =>
      mergeSettingsTopLevel(
        { statusLine: { type: "command", command: "other.sh" } },
        { statusLine },
      ),
    ).toThrow(/collision.*"statusLine"/);
  });

  it("treats a key explicitly set to null as already defined, so it collides instead of being overwritten", () => {
    expect(() =>
      mergeSettingsTopLevel({ statusLine: null }, { statusLine }),
    ).toThrow(/collision/);
  });

  it("does not mistake an inherited property name for an existing key", () => {
    // `constructor` is excluded here: it is now one of the three keys the
    // merge guard rejects outright (CWE-1321, see the dedicated
    // "prototype-key guard" describe block below). `toString` is an
    // inherited Object.prototype member that stays an ordinary, acceptable
    // fragment key, so it is still the right fixture for this test's actual
    // claim: Object.hasOwn, not inherited-property presence, decides
    // whether a key already exists.
    const merged = mergeSettingsTopLevel({}, { toString: "x" });
    expect(Object.hasOwn(merged, "toString")).toBe(true);
  });

  it("rejects a fragment key of hooks, which mergeSettingsHooks owns", () => {
    expect(() => mergeSettingsTopLevel({}, { hooks: { Stop: [] } })).toThrow(
      /mergeSettingsHooks/,
    );
  });

  it("does not mutate the existing settings object", () => {
    const existing = { hooks: {} };
    mergeSettingsTopLevel(existing, { statusLine });
    expect(existing).toEqual({ hooks: {} });
  });

  // Confirmatory regression test for deepEqual's object-comparison branch:
  // same key COUNT, different key NAMES must not be mistaken for equal
  // objects just because `Object.keys(a).length === Object.keys(b).length`.
  // Believed-correct existing behavior, not a RED-phase fix -- expected to
  // PASS today.
  it("throws a collision on same-key-count-different-key-names configs, not a false idempotent no-op", () => {
    expect(() =>
      mergeSettingsTopLevel({ config: { a: 1 } }, { config: { b: 1 } }),
    ).toThrow(/collision/);
  });

  it("treats a value with a different key insertion order as identical, not a collision", () => {
    // Same content, different key order -- a JSON.stringify-based equality
    // check would see these as different strings and wrongly throw a hard
    // collision even though the merge should be a semantic no-op.
    const existing = { config: { a: 1, b: 2 } };
    const fragment = { config: { b: 2, a: 1 } };
    expect(() => mergeSettingsTopLevel(existing, fragment)).not.toThrow();
    expect(mergeSettingsTopLevel(existing, fragment)).toEqual(existing);
  });
});

describe("prototype-key guard (CWE-1321)", () => {
  const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"] as const;

  /**
   * Builds an object whose OWN key is literally `key`, via JSON.parse rather
   * than object-literal syntax. `{ __proto__: value }` and
   * `obj["__proto__"] = value` both invoke the Annex B exotic setter, which
   * reassigns the target object's own [[Prototype]] internal slot rather
   * than creating a data property -- JSON.parse (like the real
   * pack-fragment files this module reads) does not, so this is the only
   * way to reproduce an attacker-controlled fragment that actually carries
   * a dangerous key as an own, enumerable property.
   */
  function buildOwnKeyFragment<T>(key: string, value: T): Record<string, T> {
    return JSON.parse(`{"${key}":${JSON.stringify(value)}}`) as Record<
      string,
      T
    >;
  }

  afterEach(() => {
    // Unconditional, not gated on a prior failure: `not.toHaveProperty`
    // can't prove own-key absence (it falls back to `in`, walking the
    // prototype chain), so a leaked `polluted` property on Object.prototype
    // from one test's probe would otherwise silently poison every later
    // test's `({}).polluted` check in this file and any file run after it.
    Reflect.deleteProperty(Object.prototype, "polluted");
  });

  // The toThrow(key) assertions are the proof; the Object.prototype checks
  // are only a regression tripwire, since the old code swapped the merge
  // result's own prototype rather than polluting Object.prototype.
  it.each(DANGEROUS_KEYS)(
    "mergeSettingsTopLevel rejects a %s fragment key instead of writing it",
    (key) => {
      const fragment = buildOwnKeyFragment(key, { polluted: "yes" });
      expect(() => mergeSettingsTopLevel({}, fragment)).toThrow(key);
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    },
  );

  it.each(DANGEROUS_KEYS)(
    "mergeSettingsHooks rejects a %s fragment event key instead of writing it",
    (key) => {
      const fragment = buildOwnKeyFragment(key, [
        { hooks: [{ type: "command", command: "node malicious.mjs" }] },
      ]);
      expect(() => mergeSettingsHooks({}, fragment)).toThrow(key);
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    },
  );

  it.each(DANGEROUS_KEYS)(
    "mergePackageScripts rejects a %s addition name by throwing, not reporting a collision",
    (key) => {
      const additions = buildOwnKeyFragment(key, "node malicious.mjs");
      expect(() => mergePackageScripts({}, additions)).toThrow(key);
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    },
  );

  it("carries an own __proto__ key already present in existing data through unaltered, without touching any prototype", () => {
    const existing = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"a":1}',
    ) as Record<string, unknown>;

    const merged = mergeSettingsTopLevel(existing, { b: 2 });

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(merged, "__proto__")?.value).toEqual(
      { polluted: "yes" },
    );
    expect(merged["a"]).toBe(1);
    expect(merged["b"]).toBe(2);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
