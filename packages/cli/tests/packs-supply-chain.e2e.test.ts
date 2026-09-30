// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The supply-chain pack's acceptance test: bootstrap a throwaway project
 * with `--pack supply-chain` using the built CLI and confirm it is a pure
 * file drop -- both workflow files and `.gitleaks.toml` land
 * byte-identical to their pack sources (no `__PROJECT_NAME__` token
 * substitution, since these files carry none -- see the pack's own
 * pack.json), settings.json and verify-steps.packs.json come through
 * completely untouched since the pack registers no hooks, no top-level
 * settings keys, no package scripts and no gate, and the emitted project's
 * own `pnpm verify` passes. Kept apart from packs.e2e.test.ts for the same
 * reason packs-github.e2e.test.ts is -- a pure file drop needs no
 * one-time setup steps the way packs-publishing.e2e.test.ts's supply-chain
 * half used to.
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
  "supply-chain",
  "files",
);

describe("supply-chain pack end-to-end", () => {
  it("installs both workflows and .gitleaks.toml byte-identical, carrying no __PROJECT_NAME__ token, leaves settings/verify-steps untouched, and passes the emitted project's own pnpm verify", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-supply-chain-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "supply-chain-e2e-project",
          "--skip-install",
          "--pack",
          "supply-chain",
        ],
        { stdio: "inherit" },
      );

      const relPaths = [
        join(".github", "workflows", "gitleaks.yml"),
        join(".github", "workflows", "scorecard.yml"),
        ".gitleaks.toml",
      ];
      for (const relPath of relPaths) {
        const emittedPath = join(targetDir, relPath);
        const sourcePath = join(packSourceRoot, relPath);
        expect(existsSync(emittedPath)).toBe(true);
        const emittedContent = readFileSync(emittedPath, "utf8");
        const sourceContent = readFileSync(sourcePath, "utf8");
        expect(emittedContent).toBe(sourceContent);
        // No token substitution should have occurred -- these files carry
        // no __PROJECT_NAME__ token in the first place (the pack's own
        // adoptNotes explain why: unlike publishing's copies, the leading
        // SPDX header lines that carried the token were dropped when the
        // supply-chain half was carved out, since adopt mode never
        // substitutes tokens and the header would stay literal).
        expect(emittedContent).not.toContain("__PROJECT_NAME__");
      }

      // The pack registers no hooks/settings/scripts, so the baseline's own
      // settings.json and empty verify-steps.packs.json must come through
      // completely untouched.
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(settings)).toEqual(["$schema", "hooks"]);
      expect(
        JSON.parse(
          readFileSync(
            join(targetDir, "bin", "lib", "verify-steps.packs.json"),
            "utf8",
          ),
        ),
      ).toEqual([]);

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
