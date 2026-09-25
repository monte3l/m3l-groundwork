// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The claude-action pack's acceptance test: bootstrap a throwaway project
 * with `--pack claude-action` using the built CLI and confirm it is a pure
 * file drop -- the workflow file lands byte-identical to its source, and
 * (unlike harness-extras/statusline) settings.json and verify-steps.packs.json
 * come through completely untouched, since the pack registers no hooks, no
 * top-level settings keys, no package scripts and no gate. Kept apart from
 * packs.e2e.test.ts / packs-statusline.e2e.test.ts for the same reason those
 * are split from each other.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

describe("claude-action pack end-to-end", () => {
  it("installs the workflow file, leaves settings/verify-steps untouched, and the emitted project's own pnpm verify passes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-ca-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "claude-action-e2e-project",
          "--skip-install",
          "--pack",
          "claude-action",
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
        here,
        "..",
        "..",
        "..",
        "templates",
        "packs",
        "claude-action",
        "files",
        ".github",
        "workflows",
        "claude.yml",
      );
      expect(readFileSync(workflowPath, "utf8")).toBe(
        readFileSync(sourcePath, "utf8"),
      );

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
