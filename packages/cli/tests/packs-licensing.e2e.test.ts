// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The licensing pack's acceptance test: bootstrap a throwaway project with
 * `--pack licensing` using the built CLI, confirm the gate script and
 * `REUSE.toml` land token-substituted and that nothing of the release
 * pipeline (`publishing`) comes with them, that exactly one verify step
 * (`license-headers`, lint group) is wired, then follow the pack's required
 * one-time setup steps (see `pack.json`'s `setupSteps`: stage everything,
 * `--fix`, stage again) and show the gate then passes, and finally that the
 * emitted project's own `pnpm verify` passes. The license-header gate was
 * carved out of `publishing` (see packs-publishing.e2e.test.ts, which asserts
 * a publishing-only install no longer carries it).
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");
const packSourceRoot = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "licensing",
  "files",
);

const PROJECT_NAME = "licensing-e2e-project";

/** Expects an emitted file to equal its pack source modulo the name token. */
function expectEmittedMatchesSource(targetDir: string, relPath: string): void {
  const sourceContent = readFileSync(join(packSourceRoot, relPath), "utf8");
  const emittedPath = join(targetDir, relPath);
  expect(existsSync(emittedPath)).toBe(true);
  const emittedContent = readFileSync(emittedPath, "utf8");
  if (sourceContent.includes("__PROJECT_NAME__")) {
    expect(emittedContent).toBe(
      sourceContent.split("__PROJECT_NAME__").join(PROJECT_NAME),
    );
    expect(emittedContent).not.toContain("__PROJECT_NAME__");
  } else {
    expect(emittedContent).toBe(sourceContent);
  }
}

function git(targetDir: string, args: string[]): void {
  execFileSync("git", args, { cwd: targetDir, stdio: "inherit" });
}

describe("licensing pack end-to-end", () => {
  it("installs the gate and REUSE.toml with __PROJECT_NAME__ substituted, wires only the license-headers lint step, omits the release pipeline, passes the gate after the setupSteps backfill, and passes the emitted project's own pnpm verify", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-licensing-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          PROJECT_NAME,
          "--skip-install",
          "--pack",
          "licensing",
        ],
        { stdio: "inherit" },
      );

      for (const relPath of [
        join("bin", "check-license-headers.mjs"),
        "REUSE.toml",
      ]) {
        expectEmittedMatchesSource(targetDir, relPath);
      }

      // None of publishing's release pipeline comes along.
      expect(existsSync(join(targetDir, ".changeset"))).toBe(false);
      expect(
        existsSync(join(targetDir, ".github", "workflows", "release.yml")),
      ).toBe(false);
      expect(existsSync(join(targetDir, "tools", "release"))).toBe(false);

      const steps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as Array<{ id: string; group: string }>;
      expect(steps.map((step) => [step.id, step.group])).toEqual([
        ["license-headers", "lint"],
      ]);

      // The pack adds no package scripts of its own.
      const pkg = JSON.parse(
        readFileSync(join(targetDir, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts).not.toHaveProperty("changeset");
      expect(pkg.scripts).not.toHaveProperty("version:packages");

      // setupSteps, in order: stage everything so the gate's `git ls-files`
      // read has something to check, backfill the header, stage again.
      git(targetDir, ["add", "-A"]);

      // Before the backfill the baseline's own files carry no header, so the
      // gate must fail -- proving the --fix step below is what fixes it.
      const before = spawnSync("node", ["bin/check-license-headers.mjs"], {
        cwd: targetDir,
        encoding: "utf8",
      });
      expect(before.status).not.toBe(0);
      // Fails for the right reason: header-eligible files missing the header,
      // not the uncovered-file path or a crash. The gate prints to stderr.
      expect(before.stderr).toMatch(/missing an SPDX header/);
      expect(before.stderr).not.toMatch(/neither header-eligible/);

      execFileSync("node", ["bin/check-license-headers.mjs", "--fix"], {
        cwd: targetDir,
        stdio: "inherit",
      });
      git(targetDir, ["add", "-A"]);

      const after = spawnSync("node", ["bin/check-license-headers.mjs"], {
        cwd: targetDir,
        encoding: "utf8",
      });
      expect(after.status).toBe(0);

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("backfills the header-less supply-chain workflows when installed beside supply-chain, so the gate still passes", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-licensing-sc-e2e-"),
    );
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          PROJECT_NAME,
          "--skip-install",
          "--pack",
          "licensing",
          "--pack",
          "supply-chain",
        ],
        { stdio: "inherit" },
      );

      const workflows = join(targetDir, ".github", "workflows");
      expect(readdirSync(workflows)).toEqual(
        expect.arrayContaining(["gitleaks.yml", "scorecard.yml"]),
      );

      git(targetDir, ["add", "-A"]);
      execFileSync("node", ["bin/check-license-headers.mjs", "--fix"], {
        cwd: targetDir,
        stdio: "inherit",
      });
      git(targetDir, ["add", "-A"]);

      for (const file of ["gitleaks.yml", "scorecard.yml"]) {
        expect(readFileSync(join(workflows, file), "utf8")).toMatch(
          /^# SPDX-FileCopyrightText:/mu,
        );
      }
      const result = spawnSync("node", ["bin/check-license-headers.mjs"], {
        cwd: targetDir,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
