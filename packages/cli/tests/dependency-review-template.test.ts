// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

const WORKFLOW = join(".github", "workflows", "dependency-review.yml");

function allowedLicenses(path: string): string[] {
  const text = readFileSync(join(root, path), "utf8");
  const line = text.split("\n").find((l) => /^\s*allow-licenses:/.test(l));
  if (line === undefined) {
    throw new Error(`${path} has no allow-licenses line`);
  }
  return line
    .replace(/^\s*allow-licenses:/, "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

const template = allowedLicenses(join("templates", "core", WORKFLOW));
const own = allowedLicenses(WORKFLOW);

describe("the dependency-review template's license allow-list", () => {
  it("accepts BlueOak-1.0.0, which the scaffold's own lint toolchain brings in", () => {
    expect(template).toContain("BlueOak-1.0.0");
  });

  it.each(template)(
    "allows %s only because this repository's own workflow vets it too",
    (license) => {
      expect(own).toContain(license);
    },
  );

  it("does not copy the licenses that only npm's own dependency tree needs", () => {
    expect(template).not.toContain("Artistic-2.0");
    expect(template).not.toContain("CC-BY-3.0");
  });
});
