// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The publishing pack's acceptance test: bootstrap a throwaway project with
 * `--pack publishing` using the built CLI and confirm its release-pipeline
 * files land correctly token-substituted (or byte-identical where the
 * source carries no `__PROJECT_NAME__` token), that its two package scripts
 * and two verify steps are wired (check-publish-version.mjs is invoked
 * directly from release.yml's `pack` job instead -- not a wired verify
 * step, see the pack's own adoptNotes), that the former supply-chain half
 * (gitleaks.yml, scorecard.yml, .gitleaks.toml -- now the separate
 * `supply-chain` pack, see packs-supply-chain.e2e.test.ts) is absent from a
 * publishing-only install, and that the emitted project's own `pnpm
 * verify` -- including the pack's two new gates -- passes cleanly on a
 * fresh, `private: true` baseline once the pack's two required one-time
 * setup steps (see `pack.json`'s `adoptNotes`) are carried out first:
 * installing `@changesets/cli` as a devDependency (the wiring contract only
 * extends `package.json`'s scripts, never its dependencies, so knip's
 * unlisted-binaries check fails without it), and running
 * `bin/check-license-headers.mjs --fix` to backfill the SPDX header this
 * pack's new `license-headers` gate requires on every pre-existing baseline
 * file -- with every file the CLI emitted, including both of that fix step's
 * rewrites, staged in the git index before `pnpm verify` runs.
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
  "publishing",
  "files",
);

const PROJECT_NAME = "publishing-e2e-project";

/**
 * Compares an emitted file's content against its pack source: byte-identical
 * if the source carries no `__PROJECT_NAME__` token, or identical modulo
 * every occurrence of that token replaced by the bootstrapped project's name
 * otherwise.
 */
function expectEmittedMatchesSource(targetDir: string, relPath: string): void {
  const sourceContent = readFileSync(join(packSourceRoot, relPath), "utf8");
  const emittedPath = join(targetDir, relPath);
  expect(existsSync(emittedPath)).toBe(true);
  const emittedContent = readFileSync(emittedPath, "utf8");
  if (sourceContent.includes("__PROJECT_NAME__")) {
    expect(emittedContent).toBe(
      sourceContent.split("__PROJECT_NAME__").join(PROJECT_NAME),
    );
  } else {
    expect(emittedContent).toBe(sourceContent);
  }
}

describe("publishing pack end-to-end", () => {
  it("installs the release pipeline files with __PROJECT_NAME__ substituted, wires both package scripts and both verify steps, invokes check-publish-version.mjs directly from release.yml, omits the supply-chain half, and passes the emitted project's own pnpm verify once @changesets/cli is installed and the license-headers backfill has run", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "m3l-groundwork-publishing-e2e-"),
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
        ],
        { stdio: "inherit" },
      );

      const filesToCheck = [
        join(".github", "workflows", "release.yml"),
        join(".github", "release-tools", "package.json"),
        join(".changeset", "config.json"),
        "REUSE.toml",
        join("bin", "check-publish-version.mjs"),
        join("bin", "check-dts-deps.mjs"),
      ];
      for (const relPath of filesToCheck) {
        expectEmittedMatchesSource(targetDir, relPath);
      }

      // The supply-chain half moved to its own pack -- a publishing-only
      // install must not carry gitleaks.yml, scorecard.yml or
      // .gitleaks.toml. See packs-supply-chain.e2e.test.ts for that pack's
      // own acceptance test.
      expect(
        existsSync(join(targetDir, ".github", "workflows", "gitleaks.yml")),
      ).toBe(false);
      expect(
        existsSync(join(targetDir, ".github", "workflows", "scorecard.yml")),
      ).toBe(false);
      expect(existsSync(join(targetDir, ".gitleaks.toml"))).toBe(false);

      // check-publish-version.mjs is deliberately not a wired verify step
      // (see the pack's adoptNotes) -- confirm release.yml's `pack` job
      // still invokes it directly, right before packing.
      const releaseWorkflow = readFileSync(
        join(targetDir, ".github", "workflows", "release.yml"),
        "utf8",
      );
      expect(releaseWorkflow).toContain("node bin/check-publish-version.mjs");

      const pkg = JSON.parse(
        readFileSync(join(targetDir, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts["changeset"]).toBe("changeset");
      expect(pkg.scripts["version:packages"]).toBe(
        "changeset version && pnpm install --lockfile-only",
      );
      // The baseline's own pre-existing scripts must still be present
      // alongside the two the pack adds.
      expect(typeof pkg.scripts["build"]).toBe("string");
      expect(pkg.scripts["build"]?.length).toBeGreaterThan(0);
      expect(typeof pkg.scripts["test"]).toBe("string");
      expect(pkg.scripts["test"]?.length).toBeGreaterThan(0);
      expect(typeof pkg.scripts["verify"]).toBe("string");
      expect(pkg.scripts["verify"]?.length).toBeGreaterThan(0);

      const steps = JSON.parse(
        readFileSync(
          join(targetDir, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as Array<{ id: string }>;
      expect(steps).toHaveLength(2);
      expect(steps.map((step) => step.id).sort()).toEqual([
        "dts-deps",
        "license-headers",
      ]);

      // Stage every emitted file so the license-headers gate's `git
      // ls-files` read actually has something to check, rather than
      // vacuously passing on an empty index right after `git init -q`.
      execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "inherit" });

      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // Required one-time setup step 1 (see pack.json's adoptNotes): the
      // wiring contract only extends package.json's scripts, never its
      // dependencies, so the wired `changeset`/`version:packages` scripts
      // reference a binary knip's unlisted-binaries check flags as missing
      // until @changesets/cli is actually installed.
      execFileSync(
        "pnpm",
        ["add", "-D", "@changesets/cli", "--prefer-offline"],
        { cwd: targetDir, stdio: "inherit" },
      );

      // Required one-time setup step 2 (see pack.json's adoptNotes):
      // templates/core has never had a license-header gate before this
      // pack, so every one of its own pre-existing baseline files is
      // missing the SPDX header the pack's new license-headers verify step
      // now requires -- --fix backfills all of them in one pass.
      execFileSync("node", ["bin/check-license-headers.mjs", "--fix"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // Re-stage everything the fix step just rewrote.
      execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "inherit" });

      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
