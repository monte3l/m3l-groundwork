// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The ts-advisor pack's acceptance test: bootstrap a throwaway project with
 * `--pack ts-advisor` using the built CLI and confirm it is a pure file drop
 * -- the recommending-ts-tooling skill and both of its reference files land
 * byte-identical to their sources, the skill's frontmatter parses with a
 * non-empty `name`/`description`, and (like the github pack) settings.json
 * and verify-steps.packs.json come through completely untouched, since the
 * pack registers no hooks, no top-level settings keys, no package scripts
 * and no gate. Kept apart from packs.e2e.test.ts for the same reason the
 * github pack has its own file.
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
  "ts-advisor",
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

describe("ts-advisor pack end-to-end", () => {
  it("installs the recommending-ts-tooling skill and both reference files byte-identical, the frontmatter parses with a name/description, and leaves settings/verify-steps untouched while the emitted project's own pnpm verify passes", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-ts-advisor-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "ts-advisor-e2e-project",
          "--skip-install",
          "--pack",
          "ts-advisor",
        ],
        { stdio: "inherit" },
      );

      const skillPath = join(
        targetDir,
        ".claude",
        "skills",
        "recommending-ts-tooling",
        "SKILL.md",
      );
      const skillSourcePath = join(
        packSourceRoot,
        ".claude",
        "skills",
        "recommending-ts-tooling",
        "SKILL.md",
      );
      expect(existsSync(skillPath)).toBe(true);
      const skillContent = readFileSync(skillPath, "utf8");
      expect(skillContent).toBe(readFileSync(skillSourcePath, "utf8"));

      const frontmatter = extractFrontmatter(skillContent);
      expect(frontmatter).toMatch(/^name: recommending-ts-tooling$/mu);
      expect(frontmatter).toMatch(/^description:\s*\S/mu);

      // Both reference files land byte-identical to their sources.
      const referenceNames = ["area-catalog.md", "tooling-sources.md"];
      for (const referenceName of referenceNames) {
        const emittedPath = join(
          targetDir,
          ".claude",
          "skills",
          "recommending-ts-tooling",
          "references",
          referenceName,
        );
        const referenceSourcePath = join(
          packSourceRoot,
          ".claude",
          "skills",
          "recommending-ts-tooling",
          "references",
          referenceName,
        );
        expect(existsSync(emittedPath)).toBe(true);
        expect(readFileSync(emittedPath, "utf8")).toBe(
          readFileSync(referenceSourcePath, "utf8"),
        );
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
