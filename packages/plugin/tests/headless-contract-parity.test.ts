// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The CLI and the plugin share no import (plugin `src` is vendored verbatim
 * into the skill; the CLI has no dependencies), so the canonical CLI contract
 * is loaded by file URL here and compared with the plugin's own tuples
 * (`.claude/rules/headless-mode.md`). Same load-by-URL pattern as
 * packages/cli/tests/eval-lib.test.ts.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CI_DEPTHS,
  PROJECT_KINDS,
  RUNTIME_TARGETS,
  type CiDepth,
  type ProjectKind,
  type RuntimeTarget,
} from "../src/kind-facet-map.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const cli = (await import(
  pathToFileURL(
    join(repoRoot, "packages", "cli", "src", "headless", "contract.ts"),
  ).href
)) as {
  PROJECT_KINDS: readonly string[];
  RUNTIME_TARGETS: readonly string[];
  CI_DEPTHS: readonly string[];
  BASELINE_AGENTS: readonly string[];
};

describe("CLI contract / plugin tuple parity", () => {
  it("has the same ProjectKind tuple", () => {
    expect(cli.PROJECT_KINDS).toEqual([...PROJECT_KINDS]);
    expect(PROJECT_KINDS.length).toBeGreaterThan(0);
  });

  it("has the same RuntimeTarget tuple", () => {
    expect(cli.RUNTIME_TARGETS).toEqual([...RUNTIME_TARGETS]);
    expect(RUNTIME_TARGETS.length).toBeGreaterThan(0);
  });

  it("has the same CiDepth tuple", () => {
    expect(cli.CI_DEPTHS).toEqual([...CI_DEPTHS]);
    expect(CI_DEPTHS.length).toBeGreaterThan(0);
  });

  it("derives the plugin's union types from its tuples", () => {
    expectTypeOf<ProjectKind>().toEqualTypeOf<(typeof PROJECT_KINDS)[number]>();
    expectTypeOf<RuntimeTarget>().toEqualTypeOf<
      (typeof RUNTIME_TARGETS)[number]
    >();
    expectTypeOf<CiDepth>().toEqualTypeOf<(typeof CI_DEPTHS)[number]>();
    expectTypeOf<ProjectKind>().toEqualTypeOf<
      "library" | "cli" | "frontend" | "service" | "plugin"
    >();
  });
});

describe("BASELINE_AGENTS", () => {
  it("equals the agents templates/core ships", () => {
    const shipped = readdirSync(
      join(repoRoot, "templates", "core", ".claude", "agents"),
    )
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length))
      .sort();
    expect(shipped.length).toBeGreaterThan(0);
    expect([...cli.BASELINE_AGENTS].sort()).toEqual(shipped);
  });
});
