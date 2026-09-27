// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The packs acceptance test: bootstrap a throwaway project with
 * `--pack harness-extras` using the built CLI and run its real scripts,
 * including the pack's own gate and its three folded-in statusline scripts.
 * No mocks -- this is what "a pack installs correctly" has to mean,
 * mirroring bootstrap.e2e.test.ts for the baseline. `harness-extras` is one
 * pack now (statusline was folded into it), so this file bootstraps once,
 * installs once, and runs one `pnpm install` + one `pnpm verify`.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

// A minimal but realistic statusLine stdin payload (code.claude.com/docs/en/
// statusline). `resets_at` is Unix epoch seconds, so it is built from "now".
function payload(currentDir: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    session_name: "feat-statusline",
    model: { id: "claude-opus-5", display_name: "Opus" },
    effort: { level: "high" },
    workspace: { current_dir: currentDir },
    context_window: {
      used_percentage: 72,
      remaining_percentage: 28,
      total_input_tokens: 144000,
      context_window_size: 200000,
    },
    cost: { total_cost_usd: 0.42, total_duration_ms: 450000 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: nowSec + 7800 },
    },
  });
}

/** Strips SGR/OSC-8 escape sequences so assertions read plain text. */
function plain(text: string): string {
  const esc = String.fromCharCode(27);
  return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

function render(script: string, input: string, columns: string): string {
  return execFileSync("node", [script], {
    input,
    env: { ...process.env, COLUMNS: columns },
    encoding: "utf8",
  });
}

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

      // The three statusline scripts, folded into this pack, also landed.
      const hooksDir = join(targetDir, ".claude", "hooks");
      for (const file of [
        "statusline.mjs",
        "statusline-layout.mjs",
        "subagent-statusline.mjs",
      ]) {
        expect(existsSync(join(hooksDir, file))).toBe(true);
      }

      // settings.json still parses, carries both the baseline's original
      // fifteen registrations and the pack's three new ones, and gains
      // exactly the two statusline top-level keys.
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
        statusLine: { type: string; command: string };
        subagentStatusLine: { type: string; command: string };
      };
      expect(Object.keys(settings)).toEqual([
        "$schema",
        "hooks",
        "statusLine",
        "subagentStatusLine",
      ]);
      const allCommands = Object.values(settings.hooks).flatMap((entries) =>
        entries.flatMap((e) => e.hooks.map((h) => h.command)),
      );
      // The baseline registers 15 hook commands (1 UserPromptSubmit + 2
      // PreToolUse[Bash] + 6 PreToolUse[Write|Edit] + 6 PostToolUse, one per
      // Write/Edit x .ts/.mts/.cts); this pack's wiring.settings adds 3 more
      // (PreCompact, SessionStart, PreToolUse[Bash]) for 18 total.
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
      expect(settings.statusLine.command).toContain("statusline.mjs");
      expect(settings.subagentStatusLine.command).toContain(
        "subagent-statusline.mjs",
      );

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

      // Actually run the emitted statusline scripts.
      const statusline = join(hooksDir, "statusline.mjs");
      const wide = plain(render(statusline, payload(targetDir), "120"));
      const wideRows = wide.trimEnd().split("\n");
      expect(wideRows).toHaveLength(5);
      expect(wideRows.map((row) => row.split(/\s/)[0])).toEqual([
        "session",
        "model",
        "context",
        "quota",
        "work",
      ]);
      expect(wide).toContain("feat-statusline");
      expect(wide).toContain("72%");
      expect(wide).toContain("$0.42");
      // Memory renders on both macOS and Linux (process.availableMemory()), not
      // only on the platform whose os.freemem() happens to be meaningful.
      expect(wide).toMatch(/\d+(\.\d+)?\/\d+(\.\d+)?G free/);

      // A narrow terminal drops segments rather than wrapping: still five
      // rows, none wider than the terminal.
      const narrow = plain(render(statusline, payload(targetDir), "40"));
      const narrowRows = narrow.trimEnd().split("\n");
      expect(narrowRows).toHaveLength(5);
      for (const row of narrowRows) {
        expect([...row].length).toBeLessThanOrEqual(40);
      }

      // Malformed input falls back to one minimal line and still exits 0.
      expect(render(statusline, "not json", "120").trim()).toBe("ctx --%");

      // The subagent renderer emits one {id, content} JSON line per task and
      // leaves a nameless task on Claude Code's default rendering.
      const subagentOut = render(
        join(hooksDir, "subagent-statusline.mjs"),
        JSON.stringify({
          columns: 100,
          tasks: [
            {
              id: "t1",
              name: "code-reviewer",
              effort: "high",
              tokenCount: 12000,
              contextWindowSize: 200000,
              startTime: Date.now() - 60_000,
            },
            { id: "t2" },
          ],
        }),
        "100",
      );
      const subagentLines = subagentOut
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; content: string });
      expect(subagentLines).toHaveLength(1);
      expect(subagentLines[0]?.id).toBe("t1");
      expect(plain(subagentLines[0]?.content ?? "")).toContain("code-reviewer");

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

      // The emitted project's own full gate, pack included -- its ESLint and
      // Prettier run over the three statusline scripts here and nowhere else.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
