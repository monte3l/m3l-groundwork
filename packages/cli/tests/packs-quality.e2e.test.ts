// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The quality pack's acceptance test: bootstrap a throwaway project with
 * `--pack quality` using the built CLI and confirm its two signature files
 * (the type-design-analyzer agent and the check-file-budget.mjs gate, plus
 * its baseline JSON) land byte-identical to their pack sources, the
 * file-budget verify step is the only one merged into
 * `bin/lib/verify-steps.packs.json`, `.claude/settings.json` is left
 * untouched (this pack registers no hooks and no top-level settings keys),
 * and the emitted project's own `pnpm verify` passes -- including the gate
 * this pack wires. `quality` was carved out of `harness-extras` (see
 * packs.e2e.test.ts's own updated assertions that harness-extras alone no
 * longer ships either artifact), mirroring the same split
 * packs-publishing-supply-chain.e2e.test.ts already exercises for
 * publishing/supply-chain. A second test in this file co-installs
 * `harness-extras` + `quality` together, confirming both packs' artifacts
 * land on the same baseline and the combination still passes `pnpm verify`.
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
  "quality",
  "files",
);

describe("quality pack end-to-end", () => {
  it("installs the agent and gate byte-identical, merges exactly the file-budget step, leaves settings.json untouched, and passes the emitted project's own pnpm verify", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-quality-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "quality-e2e-project",
          "--skip-install",
          "--pack",
          "quality",
        ],
        { stdio: "inherit" },
      );

      const relPaths = [
        join(".claude", "agents", "type-design-analyzer.md"),
        join("bin", "check-file-budget.mjs"),
        join("bin", "file-budget-baseline.json"),
      ];
      for (const relPath of relPaths) {
        const emittedPath = join(targetDir, relPath);
        const sourcePath = join(packSourceRoot, relPath);
        expect(existsSync(emittedPath)).toBe(true);
        expect(readFileSync(emittedPath, "utf8")).toBe(
          readFileSync(sourcePath, "utf8"),
        );
      }

      // The pack registers no hooks and no top-level settings keys -- the
      // baseline's own settings.json comes through completely untouched.
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(settings)).toEqual(["$schema", "hooks"]);

      const steps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as Array<{ id: string; group: string; cmd: string[] }>;
      expect(steps).toEqual([
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

      // The "build" group runs the baseline's own build/exports/node-version
      // steps AND the pack's file-budget gate, via one --group call.
      execFileSync("node", ["bin/verify.mjs", "--group", "build"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("harness-extras + quality packs co-installed end-to-end", () => {
  it("lands both packs' files on the same baseline -- harness-extras's hooks/statusline wiring and quality's agent/gate -- and passes the emitted project's own pnpm verify", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-harness-extras-quality-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "harness-extras-quality-e2e-project",
          "--skip-install",
          "--pack",
          "harness-extras",
          "--pack",
          "quality",
        ],
        { stdio: "inherit" },
      );

      // harness-extras's own signature files.
      for (const relPath of [
        join(".claude", "hooks", "write-compact-handoff.mjs"),
        join(".claude", "hooks", "reinject-compact-handoff.mjs"),
        join(".claude", "hooks", "guard-readonly-bash.mjs"),
        join(".claude", "hooks", "statusline.mjs"),
      ]) {
        expect(existsSync(join(targetDir, relPath))).toBe(true);
      }

      // quality's own signature files.
      for (const relPath of [
        join(".claude", "agents", "type-design-analyzer.md"),
        join("bin", "check-file-budget.mjs"),
      ]) {
        expect(existsSync(join(targetDir, relPath))).toBe(true);
      }

      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<string, unknown[]>;
        statusLine?: { command: string };
      };
      // harness-extras's settings wiring landed (PreCompact/SessionStart/
      // PreToolUse plus the two statusline top-level keys) even with
      // quality installed alongside it.
      expect(Object.keys(settings.hooks).sort()).toEqual([
        "PostToolUse",
        "PreCompact",
        "PreToolUse",
        "SessionStart",
        "UserPromptSubmit",
      ]);
      expect(settings.statusLine?.command).toContain("statusline.mjs");

      // quality's file-budget step is the only one wired -- harness-extras
      // itself contributes none.
      const steps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as Array<{ id: string }>;
      expect(steps.map((step) => step.id)).toEqual(["file-budget"]);

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
