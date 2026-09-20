import { describe, expect, it } from "vitest";
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
    const merged = mergeSettingsTopLevel({}, { constructor: "x" });
    expect(Object.hasOwn(merged, "constructor")).toBe(true);
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
});
