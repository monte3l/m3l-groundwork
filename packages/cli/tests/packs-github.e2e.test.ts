// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The github pack's acceptance test: bootstrap a throwaway project with
 * `--pack github` using the built CLI and confirm it is a pure file drop --
 * both workflow files and all three skill files land byte-identical to
 * their sources, each skill's frontmatter parses with a non-empty
 * `name`/`description`, and (unlike harness-extras) settings.json and
 * verify-steps.packs.json come through completely untouched, since the pack
 * registers no hooks, no top-level settings keys, no package scripts and no
 * gate. Kept apart from packs.e2e.test.ts for the same reason
 * harness-extras's own statusline scripts are exercised there instead of
 * here.
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
  "github",
  "files",
);

/**
 * Extracts the `---`-delimited frontmatter block from a skill file's raw
 * text, as a plain string -- a deliberately simple regex-based parse, not a
 * dependency on the harness grader's own `parseFrontmatter`.
 */
function extractFrontmatter(content: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    throw new Error("no frontmatter block found");
  }
  return match[1] ?? "";
}

describe("github pack end-to-end", () => {
  it("installs both workflow files and all three skills byte-identical, each skill's frontmatter parses with a name/description, and leaves settings/verify-steps untouched while the emitted project's own pnpm verify passes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-ca-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "github-e2e-project",
          "--skip-install",
          "--pack",
          "github",
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

      // All three skill files land byte-identical, and each one's
      // frontmatter parses with a non-empty name/description matching the
      // skill's own directory name.
      const skillNames = [
        "reviewing-dependabot-prs",
        "triaging-scan-alerts",
        "watching-pr-checks",
      ];
      for (const skillName of skillNames) {
        const emittedPath = join(
          targetDir,
          ".claude",
          "skills",
          skillName,
          "SKILL.md",
        );
        const skillSourcePath = join(
          packSourceRoot,
          ".claude",
          "skills",
          skillName,
          "SKILL.md",
        );
        expect(existsSync(emittedPath)).toBe(true);
        const emittedContent = readFileSync(emittedPath, "utf8");
        expect(emittedContent).toBe(readFileSync(skillSourcePath, "utf8"));

        const frontmatter = extractFrontmatter(emittedContent);
        expect(frontmatter).toMatch(new RegExp(`^name: ${skillName}$`, "mu"));
        expect(frontmatter).toMatch(/^description:\s*\S/mu);
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
