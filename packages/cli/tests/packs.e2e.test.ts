/**
 * The packs acceptance test: bootstrap a throwaway project with
 * `--pack harness-extras` using the built CLI and run its real scripts,
 * including the pack's own gate. No mocks -- this is what "a pack installs
 * correctly" has to mean, mirroring bootstrap.e2e.test.ts for the baseline.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

describe("harness-extras pack end-to-end", () => {
  it("installs alongside the baseline and the emitted project's own pnpm verify passes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-pack-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "pack-e2e-project",
          "--skip-install",
          "--pack",
          "harness-extras",
        ],
        { stdio: "inherit" },
      );

      // The pack's own files landed.
      expect(
        existsSync(
          join(targetDir, ".claude", "agents", "type-design-analyzer.md"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(targetDir, ".claude", "hooks", "write-compact-handoff.mjs"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(targetDir, ".claude", "hooks", "reinject-compact-handoff.mjs"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(targetDir, ".claude", "hooks", "guard-readonly-bash.mjs"),
        ),
      ).toBe(true);
      expect(existsSync(join(targetDir, "bin", "check-file-budget.mjs"))).toBe(
        true,
      );

      // settings.json still parses and carries both the baseline's original
      // ten registrations and the pack's three new ones.
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      };
      const allCommands = Object.values(settings.hooks).flatMap((entries) =>
        entries.flatMap((e) => e.hooks.map((h) => h.command)),
      );
      // The baseline registers 15 hook commands (1 UserPromptSubmit + 2
      // PreToolUse[Bash] + 6 PreToolUse[Write|Edit] + 6 PostToolUse, one per
      // Write/Edit x .ts/.mts/.cts); the pack adds 3 more.
      expect(allCommands).toHaveLength(18);
      expect(
        allCommands.some((c) => c.includes("write-compact-handoff.mjs")),
      ).toBe(true);
      expect(
        allCommands.some((c) => c.includes("reinject-compact-handoff.mjs")),
      ).toBe(true);
      expect(
        allCommands.some((c) => c.includes("guard-readonly-bash.mjs")),
      ).toBe(true);
      // The baseline's own PreToolUse[Bash] guards are still present.
      expect(
        allCommands.some((c) => c.includes("guard-git-push-signed.mjs")),
      ).toBe(true);

      // The pack's gate step landed in the pack-steps file, keyed to the
      // "build" group.
      const packSteps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as { id: string; group: string }[];
      expect(packSteps).toEqual([
        {
          id: "file-budget",
          group: "build",
          name: "Check file budget",
          cmd: ["node", "bin/check-file-budget.mjs"],
        },
      ]);

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The "build" group runs the baseline's build/exports/node-version
      // steps AND the pack's file-budget gate, via one --group call --
      // confirming the group-keyed seam actually wires a pack gate in.
      execFileSync("node", ["bin/verify.mjs", "--group", "build"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The emitted project's own full gate, pack included.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
