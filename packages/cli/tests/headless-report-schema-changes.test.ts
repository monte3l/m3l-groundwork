// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `report.v1.schema.json`'s `changes` items constrain `action` and `class` to
 * the values `ReportChange` (`headless/report.ts`) allows. Structural checks,
 * like `headless-schemas.test.ts`: the schema carries no validator dependency.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "schemas",
      "report.v1.schema.json",
    ),
    "utf8",
  ),
) as Schema;

const changes = (schema["properties"] as Record<string, Schema>)[
  "changes"
] as Schema;
const item = changes["items"] as Schema;
const itemProps = item["properties"] as Record<string, Schema>;

/** Whether the schema's own constraint lets `value` through for `key`. */
const allows = (key: string, value: unknown): boolean => {
  const constraint = itemProps[key] as Schema;
  const choices = constraint["enum"];
  return Array.isArray(choices) ? choices.includes(value) : true;
};

describe("report.v1.schema.json changes items", () => {
  it("enumerates action as ReportChange's three actions", () => {
    expect(
      [...((itemProps["action"] as Schema)["enum"] as string[])].sort(),
    ).toEqual(["install-staged", "merge-keys", "take-divergent"]);
  });

  it("enumerates class as addition and conflict", () => {
    expect(
      [...((itemProps["class"] as Schema)["enum"] as string[])].sort(),
    ).toEqual(["addition", "conflict"]);
  });

  it("rejects a change with an unknown action or class", () => {
    expect(allows("action", "delete-everything")).toBe(false);
    expect(allows("class", "mystery")).toBe(false);
  });

  it("accepts every action and class a real change carries", () => {
    for (const action of ["install-staged", "take-divergent", "merge-keys"]) {
      expect(allows("action", action)).toBe(true);
    }
    for (const klass of ["addition", "conflict"]) {
      expect(allows("class", klass)).toBe(true);
    }
  });

  it("keeps an empty changes array valid (no minItems)", () => {
    expect(changes["minItems"]).toBeUndefined();
    expect(changes["type"]).toBe("array");
  });
});
