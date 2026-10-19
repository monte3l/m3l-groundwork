// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The claude-github pack's acceptance test: bootstrap a throwaway project
 * with `--pack claude-github` using the built CLI and confirm it is a pure
 * file drop -- both workflow files land byte-identical to their sources, and
 * (unlike harness-extras) settings.json and verify-steps.packs.json come
 * through completely untouched, since the pack registers no hooks, no
 * top-level settings keys, no package scripts and no gate. Kept apart from
 * packs.e2e.test.ts for the same reason packs-github.e2e.test.ts is.
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
  "claude-github",
  "files",
);

describe("claude-github pack end-to-end", () => {
  it("installs both workflow files byte-identical and leaves settings/verify-steps untouched while the emitted project's own pnpm verify passes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-ca-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "claude-github-e2e-project",
          "--skip-install",
          "--pack",
          "claude-github",
        ],
        { stdio: "inherit" },
      );

      const workflowPath = join(
        targetDir,
        ".github",
        "workflows",
        "claude.yml",
      );
      expect(existsSync(workflowPath)).toBe(true);
      const sourcePath = join(
        packSourceRoot,
        ".github",
        "workflows",
        "claude.yml",
      );
      expect(readFileSync(workflowPath, "utf8")).toBe(
        readFileSync(sourcePath, "utf8"),
      );

      // The pack's second workflow lands byte-identical too, same as the
      // first.
      const reviewWorkflowPath = join(
        targetDir,
        ".github",
        "workflows",
        "claude-pr-review.yml",
      );
      expect(existsSync(reviewWorkflowPath)).toBe(true);
      const reviewSourcePath = join(
        packSourceRoot,
        ".github",
        "workflows",
        "claude-pr-review.yml",
      );
      expect(readFileSync(reviewWorkflowPath, "utf8")).toBe(
        readFileSync(reviewSourcePath, "utf8"),
      );

      // The pack ships workflows only: none of the github pack's skills land.
      for (const skill of [
        "reviewing-dependabot-prs",
        "triaging-scan-alerts",
        "watching-pr-checks",
      ]) {
        expect(existsSync(join(targetDir, ".claude", "skills", skill))).toBe(
          false,
        );
      }

      // The pack registers no hooks/settings/scripts, so the baseline's own
      // settings.json and empty verify-steps.packs.json must come through
      // completely untouched.
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(settings)).toEqual([
        "$schema",
        "permissions",
        "hooks",
      ]);
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
