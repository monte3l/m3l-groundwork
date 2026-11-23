// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The statusline pack's acceptance test: bootstrap a throwaway project with
 * `--pack statusline` using the built CLI, confirm its two scripts and the
 * `subagent-rows` plugin land, `.claude/settings.json` gains exactly the one
 * top-level key (`statusLine`, and no hook
 * registration, no verify step), run the emitted scripts for real, and pass
 * the emitted project's own `pnpm verify`. The status line was carved out of
 * `harness-extras` (see packs.e2e.test.ts, which asserts harness-extras alone
 * no longer ships it).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

describe("statusline pack end-to-end", () => {
  it("installs alongside the baseline, renders its status line, and the emitted project's own pnpm verify passes", async () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-statusline-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "statusline-e2e-project",
          "--skip-install",
          "--pack",
          "statusline",
        ],
        { stdio: "inherit" },
      );

      const hooksDir = join(targetDir, ".claude", "hooks");
      for (const file of ["statusline.mjs", "statusline-layout.mjs"]) {
        expect(existsSync(join(hooksDir, file))).toBe(true);
      }
      expect(existsSync(join(hooksDir, "subagent-statusline.mjs"))).toBe(false);
      // The subagent row renderer is a project-local plugin; its dotdir
      // (.claude-plugin) must survive the install.
      const pluginDir = join(targetDir, ".claude", "skills", "subagent-rows");
      for (const rel of [
        join(".claude-plugin", "plugin.json"),
        join("hooks", "hooks.json"),
        join("hooks", "register.mjs"),
        join("hooks", "row-format.mjs"),
      ]) {
        expect(existsSync(join(pluginDir, rel))).toBe(true);
      }
      // harness-extras's files are not part of this pack.
      expect(existsSync(join(hooksDir, "write-compact-handoff.mjs"))).toBe(
        false,
      );

      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
        statusLine: { type: string; command: string };
      };
      expect(Object.keys(settings)).toEqual([
        "$schema",
        "permissions",
        "hooks",
        "statusLine",
      ]);
      // The pack registers no hook: only the baseline's own 17 commands.
      const allCommands = Object.values(settings.hooks).flatMap((entries) =>
        entries.flatMap((e) => e.hooks.map((h) => h.command)),
      );
      expect(allCommands).toHaveLength(17);
      expect(settings.statusLine.command).toContain("statusline.mjs");

      // The pack wires no verify step.
      const packSteps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as { id: string; group: string }[];
      expect(packSteps).toEqual([]);

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

      // The installed plugin's renderer produces a row body for a named
      // subagent and declines (null) for one with no usable label.
      const registerModule = (await import(
        pathToFileURL(join(pluginDir, "hooks", "register.mjs")).href
      )) as {
        renderAgentRow: (props: unknown, env: { now: number }) => string | null;
      };
      const body = registerModule.renderAgentRow(
        {
          id: "t1",
          name: "code-reviewer",
          type: "reviewer",
          effort: "high",
          tokenCount: 12000,
          contextWindowSize: 200000,
          startTime: 0,
          columns: 100,
        },
        { now: 60_000 },
      );
      expect(plain(body ?? "")).toContain("code-reviewer");
      expect(
        registerModule.renderAgentRow({ id: "t2" }, { now: 0 }),
      ).toBeNull();

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The emitted project's own full gate, pack included -- its ESLint and
      // Prettier run over the three statusline scripts here.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
