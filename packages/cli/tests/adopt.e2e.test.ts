// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The adopt-mode acceptance test: builds a realistic pre-existing project,
 * runs the real built CLI against it, and asserts the one guarantee that
 * matters most -- nothing outside `.groundwork/` and
 * `.claude/skills/customize/` changes. No mocks.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Inventory } from "../src/inventory.js";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      const relPath = relative(root, absPath);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      snapshot.set(
        relPath,
        createHash("sha256").update(readFileSync(absPath)).digest("hex"),
      );
    }
  };
  visit(root);
  return snapshot;
}

function buildFixtureProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "existing-project",
        version: "1.0.0",
        type: "commonjs",
        scripts: { test: "jest", build: "tsc" },
        devDependencies: { typescript: "^5.2.0", jest: "^29.7.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "tsconfig.base.json"),
    JSON.stringify({ compilerOptions: { strict: false } }, null, 2),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "./tsconfig.base.json",
        compilerOptions: { noImplicitReturns: true },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, ".eslintrc.cjs"),
    'module.exports = { extends: ["eslint:recommended"] };\n',
  );
  writeFileSync(join(dir, "jest.config.js"), "module.exports = {};\n");
  writeFileSync(join(dir, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
  writeFileSync(
    join(dir, "CLAUDE.md"),
    "# existing-project\n\n## Setup\n\nRun `npm install`.\n",
  );
  writeFileSync(join(dir, "CONTRIBUTING.md"), "# Contributing\n\nOpen a PR.\n");

  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "agents", "foo.md"),
    "---\nmodel: opus\n---\n# foo\n",
  );
}

describe("adopt mode end-to-end", () => {
  it("surveys a pre-existing project and writes only .groundwork/ and .claude/skills/customize/", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-adopt-e2e-"));
    try {
      buildFixtureProject(projectDir);
      const before = snapshotTree(projectDir);

      execFileSync(
        "node",
        [binPath, projectDir, "--name", "existing-project"],
        {
          stdio: "inherit",
        },
      );

      const after = snapshotTree(projectDir);

      // Every file that existed before the run is byte-identical after it.
      for (const [relPath, hash] of before) {
        expect(after.get(relPath)).toBe(hash);
      }

      // Every new file lives under .groundwork/ or .claude/skills/customize/.
      const customizePrefix = join(".claude", "skills", "customize");
      for (const relPath of after.keys()) {
        if (before.has(relPath)) continue;
        const isGroundwork =
          relPath.startsWith(".groundwork" + "/") || relPath === ".groundwork";
        const isCustomizeSkill = relPath.startsWith(customizePrefix);
        expect(isGroundwork || isCustomizeSkill).toBe(true);
      }

      const inventoryPath = join(projectDir, ".groundwork", "inventory.json");
      expect(existsSync(inventoryPath)).toBe(true);
      const inventory = JSON.parse(
        readFileSync(inventoryPath, "utf8"),
      ) as Inventory;

      expect(inventory.schemaVersion).toBe(5);
      expect(inventory.survey.toolchain.testRunner.tool).toBe("jest");
      expect(
        inventory.survey.harness.agents.some(
          (a: { name: string }) => a.name === "foo",
        ),
      ).toBe(true);
      expect(
        inventory.survey.docs.files.some((f: { path: string }) =>
          f.path.endsWith("CONTRIBUTING.md"),
        ),
      ).toBe(true);

      // Every pack under templates/packs/ is surveyed regardless of any
      // --pack flag (none was passed here) and staged, unapplied.
      expect(inventory.packs.some((p) => p.name === "harness-extras")).toBe(
        true,
      );
      expect(
        existsSync(
          join(
            projectDir,
            ".groundwork",
            "packs",
            "harness-extras",
            "pack.json",
          ),
        ),
      ).toBe(true);

      const reportPath = join(projectDir, ".groundwork", "adoption-report.md");
      const report = readFileSync(reportPath, "utf8");
      expect(report).toContain("package.json");
      expect(report).toContain("## Could not be determined");
      expect(report).toContain("## Available packs");
      expect(report).toContain("harness-extras");

      // The fixture's foo agent has frontmatter but no `name`/`description`:
      // the harness grade must surface that as a wiring finding, in both the
      // inventory /customize reads and the report a human reads.
      expect(
        inventory.harnessGrade.findings.map((f) => `${f.ruleId}:${f.subject}`),
      ).toContain("agent-shape:.claude/agents/foo.md");
      expect(inventory.harnessGrade.structural.failed).toBeGreaterThan(0);
      expect(report).toContain("## Harness grade");
      expect(report).toContain("[agent-shape] .claude/agents/foo.md");
      expect(report).not.toContain(
        "Nothing -- every file the survey looked at parsed cleanly.",
      );

      // The toolchain grade: the fixture's legacy .eslintrc.cjs and its
      // non-strict tsconfig chain surface as rubric findings, and -- because
      // absence is never a defect -- the missing vitest config and verify
      // steps produce none.
      const toolchainIds = inventory.toolchainGrade.findings.map(
        (f) => `${f.ruleId}:${f.subject}`,
      );
      expect(toolchainIds).toContain("eslint-flat-config:.eslintrc.cjs");
      expect(toolchainIds).toContain("strict-flags:tsconfig.json");
      expect(toolchainIds.some((id) => id.startsWith("coverage-gate:"))).toBe(
        false,
      );
      expect(inventory.toolchainGrade.structural.failed).toBe(0);
      expect(inventory.toolchainConformance.divergent).toBeGreaterThan(0);
      expect(report).toContain("## Toolchain grade");
      expect(report).toContain("[eslint-flat-config] .eslintrc.cjs");

      // Absent-file staging: eslint.config.js is a real templates/core file
      // the fixture never created (it ships .eslintrc.cjs instead), so the
      // conflict plan marks it "absent" and it must be staged; package.json
      // already exists in the fixture (a key-level conflict, never
      // "absent") and must NOT be staged.
      expect(
        inventory.conflicts.find((c) => c.relPath === "eslint.config.js")
          ?.status,
      ).toBe("absent");
      expect(
        inventory.conflicts.find((c) => c.relPath === "package.json")?.status,
      ).not.toBe("absent");

      expect(inventory.stagedBaseline.dir).toBe(".groundwork/baseline");
      expect(inventory.stagedBaseline.suffix).toBe(".staged");
      expect(inventory.stagedBaseline.files.length).toBeGreaterThan(0);
      const stagedPaths = inventory.stagedBaseline.files.map((f) => f.path);
      expect(stagedPaths).toContain("eslint.config.js");
      expect(stagedPaths).not.toContain("package.json");
      for (const file of inventory.stagedBaseline.files) {
        expect(file.staged).toBe(`${file.path}.staged`);
        const stagedAbsPath = join(
          projectDir,
          ".groundwork",
          "baseline",
          file.staged,
        );
        expect(existsSync(stagedAbsPath)).toBe(true);
        expect(file.sha256).toBe(
          createHash("sha256")
            .update(readFileSync(stagedAbsPath))
            .digest("hex"),
        );
      }

      // Neutral naming: every staged file ends ".staged" and none ends in a
      // bare toolchain-globbed extension (checked on the full staged name,
      // which is only reachable via the suffix) -- so no toolchain anywhere
      // (this fixture's own jest config included) ever globs the staged
      // tree as source/test files.
      const baselineDir = join(projectDir, ".groundwork", "baseline");
      const staged: string[] = [];
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const absPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            visit(absPath);
            continue;
          }
          staged.push(relative(baselineDir, absPath));
        }
      };
      visit(baselineDir);
      expect(staged.length).toBeGreaterThan(0);
      for (const name of staged) {
        expect(name.endsWith(".staged")).toBe(true);
        expect(name).not.toMatch(/\.(ts|tsx|js|mjs|cjs|json|jsonc|md|ya?ml)$/);
      }
      // The fixture's own CLAUDE.md differs from the baseline's (a
      // "divergent" conflict, never "absent"), so it must NOT be staged --
      // only a file the fixture genuinely lacks (eslint.config.js) is.
      expect(staged.find((n) => n === "CLAUDE.md.staged")).toBeUndefined();
      expect(staged.find((n) => n === "eslint.config.js.staged")).toBeDefined();

      // A test-discovery glob (test files, toolchain configs, harness
      // frontmatter files, CI workflows) run over the WHOLE project,
      // including .groundwork/, must never match anything under
      // .groundwork/baseline/ -- every staged name there carries the
      // ".staged" suffix, which none of these patterns end in.
      const discoveryPattern =
        /(\.test\.ts|vitest\.config\.\w+|tsconfig[^/]*\.json|eslint\.config\.\w+|SKILL\.md|CLAUDE\.md|\.ya?ml)$/;
      const discoveryMatchesUnderBaseline: string[] = [];
      const visitProject = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          const absPath = join(dir, entry.name);
          const relPath = relative(projectDir, absPath);
          if (entry.isDirectory()) {
            visitProject(absPath);
            continue;
          }
          if (
            relPath.startsWith(join(".groundwork", "baseline") + "/") &&
            discoveryPattern.test(entry.name)
          ) {
            discoveryMatchesUnderBaseline.push(relPath);
          }
        }
      };
      visitProject(projectDir);
      expect(discoveryMatchesUnderBaseline).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
