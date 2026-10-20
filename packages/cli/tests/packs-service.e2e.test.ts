// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The service pack's acceptance test: bootstrap a throwaway project with
 * `--pack service` using the built CLI and confirm it is a pure file drop --
 * the performance-analyzer agent and the api-doc skill (with its openapi-template.yaml) land byte-identical to their
 * sources, settings.json and verify-steps.packs.json come through untouched
 * (the pack wires nothing), and the emitted project's own harness grader
 * passes.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");
const packSourceRoot = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "service",
  "files",
);

describe("service pack end-to-end", () => {
  it("installs the agent, skill and skill template byte-identical, leaves settings and verify-steps untouched, and passes the emitted harness grader", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-service-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "service-e2e-project",
          "--skip-install",
          "--pack",
          "service",
        ],
        { stdio: "inherit" },
      );

      for (const relPath of [
        join(".claude", "agents", "performance-analyzer.md"),
        join(".claude", "skills", "api-doc", "SKILL.md"),
        join(".claude", "skills", "api-doc", "openapi-template.yaml"),
      ]) {
        const emittedPath = join(targetDir, relPath);
        expect(existsSync(emittedPath)).toBe(true);
        expect(readFileSync(emittedPath, "utf8")).toBe(
          readFileSync(join(packSourceRoot, relPath), "utf8"),
        );
      }

      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as { permissions: { deny: string[] } } & Record<string, unknown>;
      expect(Object.keys(settings)).toEqual([
        "$schema",
        "permissions",
        "hooks",
      ]);
      expect(settings.permissions.deny.length).toBeGreaterThan(0);
      expect(
        JSON.parse(
          readFileSync(
            join(targetDir, "bin", "lib", "verify-steps.packs.json"),
            "utf8",
          ),
        ),
      ).toEqual([]);

      execFileSync("node", ["bin/check-harness.mjs"], {
        cwd: targetDir,
        stdio: "inherit",
      });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
