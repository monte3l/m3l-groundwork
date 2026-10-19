// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Co-installability acceptance test for `publishing` + `supply-chain`
 * together -- the two packs that used to be one (`publishing` shipped both
 * halves before the supply-chain half was carved out into its own pack; see
 * packs-publishing.e2e.test.ts and packs-supply-chain.e2e.test.ts for each
 * pack's own solo acceptance test). This test bootstraps with both `--pack`
 * flags, confirms both packs' signature files land on the same baseline,
 * and confirms the combination still passes the emitted project's own real
 * `pnpm verify` after the same one-time setup step
 * packs-publishing.e2e.test.ts performs (installing `@changesets/cli`). The
 * SPDX license-header gate is no longer part of either pack -- it lives in
 * the `licensing` pack (see packs-licensing.e2e.test.ts).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

const PROJECT_NAME = "publishing-supply-chain-e2e-project";

describe("publishing + supply-chain packs co-installed end-to-end", () => {
  it("lands both packs' files, and passes the emitted project's own pnpm verify once @changesets/cli is installed", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-pub-supply-chain-e2e-"),
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
          "publishing",
          "--pack",
          "supply-chain",
        ],
        { stdio: "inherit" },
      );

      // publishing's own signature file.
      const releaseWorkflowPath = join(
        targetDir,
        ".github",
        "workflows",
        "release.yml",
      );
      // supply-chain's own signature files.
      const gitleaksWorkflowPath = join(
        targetDir,
        ".github",
        "workflows",
        "gitleaks.yml",
      );
      const scorecardWorkflowPath = join(
        targetDir,
        ".github",
        "workflows",
        "scorecard.yml",
      );
      const gitleaksTomlPath = join(targetDir, ".gitleaks.toml");
      for (const path of [
        releaseWorkflowPath,
        gitleaksWorkflowPath,
        scorecardWorkflowPath,
        gitleaksTomlPath,
      ]) {
        expect(existsSync(path)).toBe(true);
      }

      const pkg = JSON.parse(
        readFileSync(join(targetDir, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts["changeset"]).toBe("changeset");
      expect(pkg.scripts["version:packages"]).toBe(
        "changeset version && pnpm install --lockfile-only",
      );

      const steps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as Array<{ id: string }>;
      // supply-chain wires no verify step -- only publishing's one.
      expect(steps.map((step) => step.id)).toEqual(["dts-deps"]);

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // Required one-time setup step (see publishing's pack.json
      // adoptNotes): the wiring contract only extends package.json's
      // scripts, never its dependencies, so the wired `changeset`/
      // `version:packages` scripts reference a binary knip's own
      // unlisted-binaries check flags as missing until this is installed.
      execFileSync(
        "pnpm",
        ["add", "-D", "@changesets/cli", "--prefer-offline"],
        { cwd: targetDir, stdio: "inherit" },
      );

      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
