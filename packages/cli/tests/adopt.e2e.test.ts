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

      expect(inventory.schemaVersion).toBe(4);
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
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
