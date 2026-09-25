// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The end-to-end acceptance test: actually bootstrap a throwaway project
 * into a temp directory with the built CLI and run its real scripts. No
 * mocks -- this is what "the CLI works" has to mean.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

describe("bootstrap end-to-end", () => {
  it("emits a project whose own install, lint, typecheck, and test pass", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-e2e-"));
    try {
      execFileSync(
        "node",
        [binPath, targetDir, "--name", "e2e-test-project", "--skip-install"],
        { stdio: "inherit" },
      );

      expect(existsSync(join(targetDir, "package.json"))).toBe(true);
      expect(existsSync(join(targetDir, ".git"))).toBe(true);
      expect(
        existsSync(
          join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        ),
      ).toBe(true);

      // A warm pnpm store makes this fast and avoids registry flakiness in
      // a constrained network environment; the store itself still needs to
      // have every dependency this project's package.json names.
      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The emitted project's own gate, not a re-derivation of it here --
      // if this passes, the baseline genuinely works standalone.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
