// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `loadMigrations(path?)`, `applicableMigrations` and the shipped
 * `data/migrations.json`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateMigrationsPath } from "../src/assets.js";
import { applicableMigrations, loadMigrations } from "../src/migrations.js";
import type { Migration } from "../src/migrations.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migrations-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function load(content: unknown): ReturnType<typeof loadMigrations> {
  const path = join(root, "migrations.json");
  writeFileSync(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return loadMigrations(path);
}

describe("loadMigrations", () => {
  it("loads a valid file", () => {
    const migrations = [
      {
        id: "rename-lefthook",
        since: "1.6.0",
        renames: [{ from: "lefthook.yml", to: ".config/lefthook.yml" }],
        removedWiring: [{ pack: "quality", item: "file-budget" }],
      },
      { id: "bare", since: "1.7.0" },
    ];
    expect(load(migrations)).toEqual({ migrations });
  });

  it("loads an empty list", () => {
    expect(load([])).toEqual({ migrations: [] });
  });

  it("returns a note, never throwing, for a missing file", () => {
    const result = loadMigrations(join(root, "nope.json"));
    expect(result).toHaveProperty("note");
  });

  it("returns a note for invalid JSON and for a non-array top level", () => {
    expect(load("{ nope")).toHaveProperty("note");
    expect(load({ migrations: [] })).toHaveProperty("note");
  });

  it.each([
    [
      "a duplicate id",
      [
        { id: "a", since: "1.0.0" },
        { id: "a", since: "1.1.0" },
      ],
    ],
    ["a missing id", [{ since: "1.0.0" }]],
    ["an empty id", [{ id: "", since: "1.0.0" }]],
    ["a missing since", [{ id: "a" }]],
    ["a two-part since", [{ id: "a", since: "1.2" }]],
    ["a v-prefixed since", [{ id: "a", since: "v1.2.3" }]],
    ["a prerelease since", [{ id: "a", since: "1.2.3-beta.1" }]],
    ["an unknown entry that is not an object", ["a"]],
    [
      "renames that is not an array",
      [{ id: "a", since: "1.0.0", renames: {} }],
    ],
    [
      "a rename without to",
      [{ id: "a", since: "1.0.0", renames: [{ from: "x" }] }],
    ],
    [
      "an absolute rename path",
      [{ id: "a", since: "1.0.0", renames: [{ from: "/etc/x", to: "y" }] }],
    ],
    [
      "a .. rename path",
      [{ id: "a", since: "1.0.0", renames: [{ from: "x", to: "../y" }] }],
    ],
    [
      "a backslash rename path",
      [{ id: "a", since: "1.0.0", renames: [{ from: "a\\\\b", to: "y" }] }],
    ],
    [
      "a colon rename path",
      [{ id: "a", since: "1.0.0", renames: [{ from: "C:x", to: "y" }] }],
    ],
    [
      "a __proto__ path segment",
      [
        {
          id: "a",
          since: "1.0.0",
          renames: [{ from: "a/__proto__", to: "y" }],
        },
      ],
    ],
    [
      "a constructor path segment",
      [
        {
          id: "a",
          since: "1.0.0",
          renames: [{ from: "constructor", to: "y" }],
        },
      ],
    ],
    [
      "removedWiring without item",
      [{ id: "a", since: "1.0.0", removedWiring: [{ pack: "q" }] }],
    ],
    [
      "removedWiring with a prototype pack",
      [
        {
          id: "a",
          since: "1.0.0",
          removedWiring: [{ pack: "prototype", item: "x" }],
        },
      ],
    ],
  ])("returns a note for %s", (_name, content) => {
    const result = load(content);
    expect(result).toHaveProperty("note");
    expect(result).not.toHaveProperty("migrations");
  });

  it("rejects a prototype-sensitive key in an entry (parsed from JSON)", () => {
    const result = load('[{"id":"a","since":"1.0.0","__proto__":{"x":1}}]');
    expect(result).toHaveProperty("note");
  });
});

describe("applicableMigrations", () => {
  const m = (id: string, since: string): Migration => ({ id, since });
  const all = [m("a", "1.5.0"), m("b", "1.6.0"), m("c", "1.10.0")];

  it("selects those with base < since <= running", () => {
    expect(
      applicableMigrations(all, "1.5.0", "1.10.0").map(({ id }) => id),
    ).toEqual(["b", "c"]);
  });

  it("includes since == running and excludes since == base", () => {
    expect(
      applicableMigrations(all, "1.4.0", "1.5.0").map(({ id }) => id),
    ).toEqual(["a"]);
    expect(applicableMigrations(all, "1.5.0", "1.5.0")).toEqual([]);
  });

  it("compares numerically, not lexically", () => {
    expect(
      applicableMigrations(all, "1.9.0", "1.10.0").map(({ id }) => id),
    ).toEqual(["c"]);
  });

  it("returns nothing when base is at or above running", () => {
    expect(applicableMigrations(all, "2.0.0", "1.6.0")).toEqual([]);
  });
});

describe("the shipped migrations file", () => {
  it("is located by templateMigrationsPath beside the template history", () => {
    const path = templateMigrationsPath();
    expect(path.endsWith(join("data", "migrations.json"))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("loads, with unique ids", () => {
    const result = loadMigrations();
    expect(result).toHaveProperty("migrations");
    const { migrations } = result as { migrations: Migration[] };
    const ids = migrations.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
