// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { RULES } from "../../src/toolchain/rules.js";
import type { ToolchainSnapshot } from "../../src/toolchain/rules.js";

const rule = RULES.find((r) => r.id === "gate-wiring");

function snapshot(commands: string[][]): ToolchainSnapshot {
  return {
    packageJson: { scripts: { build: "tsc" } },
    scripts: { build: "tsc" },
    nodeVersion: undefined,
    tsconfigFiles: new Map(),
    tsconfigLinks: [],
    chains: [],
    eslint: { flatFile: undefined, source: undefined, legacy: [] },
    vitest: { file: undefined, source: undefined },
    gates: {
      stepsFile: "bin/lib/verify-steps.mjs",
      groups: [],
      steps: commands.map((cmd, i) => ({
        id: `s${String(i)}`,
        group: undefined,
        cmd,
      })),
      packs: undefined,
    },
    lanes: [],
    projectFiles: new Set(),
  };
}

describe("gate-wiring: inherited Object.prototype members are not scripts", () => {
  it("exists", () => {
    expect(rule).toBeDefined();
  });

  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
    "reports `pnpm %s` as missing when package.json has no such own script",
    (name) => {
      const result = rule?.check(snapshot([["pnpm", name]]));
      expect(result?.failures.map((f) => f.message)).toEqual([
        `runs \`pnpm ${name}\`, but package.json has no "${name}" script`,
      ]);
    },
  );

  it("resolves `pnpm run <inherited>` the same way", () => {
    const result = rule?.check(snapshot([["pnpm", "run", "toString"]]));
    expect(result?.failures).toHaveLength(1);
  });

  it("does not report a real own script", () => {
    const result = rule?.check(snapshot([["pnpm", "build"]]));
    expect(result?.failures).toEqual([]);
    expect(result?.checked).toBe(1);
  });
});
