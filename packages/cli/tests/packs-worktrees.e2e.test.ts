// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The worktrees pack's acceptance test: bootstrap a throwaway project with
 * `--pack worktrees` using the built CLI and confirm the skill and all
 * three hooks land byte-identical, the skill's frontmatter parses,
 * settings.json gains the SessionStart/PreToolUse/PostToolUse wiring,
 * `.worktreeinclude` is emitted at the project root, and the emitted
 * project's own real `pnpm install` + `pnpm verify` both pass -- this pack
 * has hooks and settings/`.claude` wiring (closer to `packs.e2e.test.ts`'s
 * harness-extras shape than `packs-github.e2e.test.ts`'s pure file drop), so
 * it follows that pattern: one bootstrap, one real install, one real
 * verify.
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
  "worktrees",
  "files",
);

/**
 * Extracts the `---`-delimited frontmatter block from a skill file's raw
 * text -- same deliberately simple regex-based parse as
 * `packs-github.e2e.test.ts`'s `extractFrontmatter`, not a dependency on the
 * harness grader's own `parseFrontmatter`.
 */
function extractFrontmatter(content: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    throw new Error("no frontmatter block found");
  }
  return match[1] ?? "";
}

describe("worktrees pack end-to-end", () => {
  it("installs the skill and all three hooks byte-identical, wires SessionStart/PreToolUse/PostToolUse, emits .worktreeinclude, and the emitted project's own pnpm verify passes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-wt-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "worktrees-e2e-project",
          "--skip-install",
          "--pack",
          "worktrees",
        ],
        { stdio: "inherit" },
      );

      // The skill file lands byte-identical, and its frontmatter parses with
      // a name/description matching the skill's own directory name.
      const skillEmittedPath = join(
        targetDir,
        ".claude",
        "skills",
        "working-in-worktrees",
        "SKILL.md",
      );
      const skillSourcePath = join(
        packSourceRoot,
        ".claude",
        "skills",
        "working-in-worktrees",
        "SKILL.md",
      );
      expect(existsSync(skillEmittedPath)).toBe(true);
      const skillContent = readFileSync(skillEmittedPath, "utf8");
      expect(skillContent).toBe(readFileSync(skillSourcePath, "utf8"));
      const frontmatter = extractFrontmatter(skillContent);
      expect(frontmatter).toMatch(/^name: working-in-worktrees$/mu);
      expect(frontmatter).toMatch(/^description:\s*\S/mu);

      // All three hook files land byte-identical.
      for (const hookName of [
        "guard-worktree-only.mjs",
        "ensure-worktree-deps.mjs",
        "repair-core-bare.mjs",
      ]) {
        const emittedHookPath = join(targetDir, ".claude", "hooks", hookName);
        const sourceHookPath = join(
          packSourceRoot,
          ".claude",
          "hooks",
          hookName,
        );
        expect(existsSync(emittedHookPath)).toBe(true);
        expect(readFileSync(emittedHookPath, "utf8")).toBe(
          readFileSync(sourceHookPath, "utf8"),
        );
      }

      // .worktreeinclude lands at the project root, byte-identical.
      const worktreeIncludePath = join(targetDir, ".worktreeinclude");
      expect(existsSync(worktreeIncludePath)).toBe(true);
      expect(readFileSync(worktreeIncludePath, "utf8")).toBe(
        readFileSync(join(packSourceRoot, ".worktreeinclude"), "utf8"),
      );

      // settings.json gains a SessionStart[startup|resume] entry (carrying
      // both ensure-worktree-deps.mjs and repair-core-bare.mjs), a
      // PreToolUse[Write|Edit] entry, and a
      // PostToolUse[EnterWorktree|ExitWorktree|Agent] entry, alongside the
      // baseline's own registrations.
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      };
      const sessionStart = settings.hooks["SessionStart"] ?? [];
      expect(
        sessionStart.some(
          (entry) =>
            entry.matcher === "startup|resume" &&
            entry.hooks.some((h) =>
              h.command.includes("ensure-worktree-deps.mjs"),
            ) &&
            entry.hooks.some((h) => h.command.includes("repair-core-bare.mjs")),
        ),
      ).toBe(true);
      const preToolUse = settings.hooks["PreToolUse"] ?? [];
      expect(
        preToolUse.some(
          (entry) =>
            entry.matcher === "Write|Edit" &&
            entry.hooks.some((h) =>
              h.command.includes("guard-worktree-only.mjs"),
            ),
        ),
      ).toBe(true);
      const postToolUse = settings.hooks["PostToolUse"] ?? [];
      expect(
        postToolUse.some(
          (entry) =>
            entry.matcher === "EnterWorktree|ExitWorktree|Agent" &&
            entry.hooks.some((h) => h.command.includes("repair-core-bare.mjs")),
        ),
      ).toBe(true);

      // The pack registers no package scripts or verify steps.
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

      // The emitted project's own full gate -- its ESLint and Prettier run
      // over the three new hooks here, catching a syntax/lint mistake in the
      // pack's own shipped hook source the same way it would for any other
      // baseline file.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
