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

// Only npm's own dependency tree needs these two. This file names them as
// data, so scancode-config.yml ignores it; policies.yml does not approve them.
const NPM_ONLY = ["Artistic-2.0", "CC-BY-3.0"];

// The permissive licenses the scaffold's own toolchain brings in, so a new
// project's first lockfile does not fail Dependency Review on them.
const TOOLCHAIN = ["BlueOak-1.0.0", "Python-2.0", "BSD-2-Clause-Views"];

describe("the dependency-review template's license allow-list", () => {
  it.each(TOOLCHAIN)(
    "accepts %s, which the scaffold's own toolchain brings in",
    (license) => {
      expect(template).toContain(license);
    },
  );

  it.each(template)(
    "allows %s only because this repository's own workflow vets it too",
    (license) => {
      expect(own).toContain(license);
    },
  );

  it.each(NPM_ONLY)(
    "does not copy %s, which only npm's own dependency tree needs",
    (license) => {
      expect(template).not.toContain(license);
    },
  );
});

function exemptions(path: string): string[] {
  const text = readFileSync(join(root, path), "utf8");
  return text
    .split("\n")
    .filter((l) => /^\s+-\s+pkg:/.test(l))
    .map((l) => l.replace(/^\s+-\s+/, "").trim());
}

describe("the starter dependency-review config", () => {
  const starter = exemptions(
    join("templates", "core", ".github", "dependency-review-config.yml"),
  );

  it("exempts lightningcss, a build-time tool, by package URL", () => {
    expect(starter).toContain("pkg:npm/lightningcss");
  });

  it("exempts the lightningcss platform builds the toolchain installs", () => {
    const platforms = starter.filter((p) =>
      p.startsWith("pkg:npm/lightningcss-"),
    );
    expect(platforms.length).toBeGreaterThan(0);
  });

  it.each(starter)("%s names a package without pinning a version", (purl) => {
    expect(purl).not.toMatch(/@\d/);
    expect(purl).not.toContain("*");
  });

  it("exempts nothing but the lightningcss family", () => {
    for (const purl of starter) {
      expect(purl).toMatch(/^pkg:npm\/lightningcss(-[a-z0-9-]+)?$/);
    }
  });
});
