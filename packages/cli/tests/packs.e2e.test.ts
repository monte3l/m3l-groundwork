// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The packs acceptance test: bootstrap a throwaway project with
 * `--pack harness-extras` using the built CLI and run its real scripts. No
 * mocks -- this is what "a pack installs correctly" has to mean, mirroring
 * bootstrap.e2e.test.ts for the baseline. This file bootstraps once,
 * installs once, and runs one `pnpm install` + one `pnpm verify`. The
 * type-design-analyzer agent and the file-budget gate were carved out into
 * their own `quality` pack (see packs-quality.e2e.test.ts), and the status
 * line into the `statusline` pack (see packs-statusline.e2e.test.ts) -- this
 * file asserts harness-extras installs WITHOUT them.
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

      // The type-design-analyzer agent and the file-budget gate moved to
      // the new quality pack -- harness-extras alone must not ship them.
      expect(
        existsSync(
          join(targetDir, ".claude", "agents", "type-design-analyzer.md"),
        ),
      ).toBe(false);
      expect(existsSync(join(targetDir, "bin", "check-file-budget.mjs"))).toBe(
        false,
      );

      // The status line moved to the statusline pack -- harness-extras
      // alone must not ship its three scripts.
      const hooksDir = join(targetDir, ".claude", "hooks");
      for (const file of [
        "statusline.mjs",
        "statusline-layout.mjs",
        "subagent-statusline.mjs",
      ]) {
        expect(existsSync(join(hooksDir, file))).toBe(false);
      }

      // settings.json still parses, carries both the baseline's original
      // fifteen registrations and the pack's three new ones, and gains no
      // top-level key (no statusLine/subagentStatusLine).
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      };
      expect(Object.keys(settings)).toEqual([
        "$schema",
        "permissions",
        "hooks",
      ]);
      const allCommands = Object.values(settings.hooks).flatMap((entries) =>
        entries.flatMap((e) => e.hooks.map((h) => h.command)),
      );
      // The baseline registers 16 hook commands (1 UserPromptSubmit + 3
      // PreToolUse[Bash] + 6 PreToolUse[Write|Edit] + 6 PostToolUse, one per
      // Write/Edit x .ts/.mts/.cts); this pack's wiring.settings adds 3 more
      // (PreCompact, SessionStart, PreToolUse[Bash]) for 19 total.
      expect(allCommands).toHaveLength(19);
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

      // harness-extras wires no verify step of its own (that gate moved to
      // the quality pack) -- the baseline's own empty pack-steps file comes
      // through untouched.
      const packSteps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as { id: string; group: string }[];
      expect(packSteps).toEqual([]);

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The "build" group runs cleanly with no pack-contributed step --
      // harness-extras alone wires no gate.
      execFileSync("node", ["bin/verify.mjs", "--group", "build"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The emitted project's own full gate, pack included -- its ESLint and
      // Prettier run over the pack's hook scripts.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
