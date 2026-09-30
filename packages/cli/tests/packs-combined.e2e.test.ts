// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Co-installability acceptance test for `publishing` + `worktrees` together:
 * each pack passes its own solo e2e test (`packs-publishing.e2e.test.ts`,
 * `packs-worktrees.e2e.test.ts`), but the two were never proven to install
 * onto the SAME baseline in one bootstrap. That combination surfaced a real
 * gap: `publishing`'s `license-headers` verify step (`bin/check-license-
 * headers.mjs`) requires every tracked file to be either header-eligible (an
 * extension in `HEADER_EXTENSIONS`) or matched by a `REUSE.toml` glob, and
 * `worktrees`' own `.worktreeinclude` -- a dotfile with no extension -- was
 * neither, so the gate failed only once both packs were present together.
 * This test bootstraps with both `--pack` flags, confirms both packs' files
 * land, confirms the `REUSE.toml` fix actually discriminates the bug (the
 * gate fails again if the fix's glob is reverted, proven against a mutated
 * COPY of the emitted project's own `REUSE.toml`, never the template), and
 * confirms `release.yml`'s tag-lookup fix (`gh release view` against both
 * `v<version>` and `<name>@<version>` candidates, not a bare guessed-tag
 * upload) is present -- then runs the emitted project's own real `pnpm
 * verify` after the same one-time setup steps `packs-publishing.e2e.test.ts`
 * performs.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");
const publishingSourceRoot = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "publishing",
  "files",
);

const PROJECT_NAME = "combined-e2e-project";

/**
 * Runs the emitted project's own `bin/check-license-headers.mjs` in
 * `--check` mode (never `--fix`) without throwing on a non-zero exit, so a
 * deliberately-broken `REUSE.toml` variant can be asserted to fail rather
 * than crashing the test harness itself.
 */
function runLicenseHeadersCheck(targetDir: string): {
  status: number | null;
  stderr: string;
} {
  const result = spawnSync(
    "node",
    ["bin/check-license-headers.mjs", "--check"],
    { cwd: targetDir, encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr };
}

describe("publishing + worktrees packs co-installed end-to-end", () => {
  it("lands both packs' files, keeps .changeset/config.json public and .worktreeinclude's .env.*.local line, fixes release.yml's tag lookup, discriminates the REUSE.toml fix, and passes the emitted project's own pnpm verify", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-combo-e2e-"));
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
          "worktrees",
        ],
        { stdio: "inherit" },
      );

      // Both packs' signature files land.
      const worktreeIncludePath = join(targetDir, ".worktreeinclude");
      const skillPath = join(
        targetDir,
        ".claude",
        "skills",
        "working-in-worktrees",
        "SKILL.md",
      );
      const changesetConfigPath = join(targetDir, ".changeset", "config.json");
      const releaseWorkflowPath = join(
        targetDir,
        ".github",
        "workflows",
        "release.yml",
      );
      for (const path of [
        worktreeIncludePath,
        skillPath,
        changesetConfigPath,
        releaseWorkflowPath,
      ]) {
        expect(existsSync(path)).toBe(true);
      }

      // .changeset/config.json still declares a public package.
      const changesetConfig = JSON.parse(
        readFileSync(changesetConfigPath, "utf8"),
      ) as { access: string };
      expect(changesetConfig.access).toBe("public");

      // .worktreeinclude still carries worktrees' .env.*.local line.
      const worktreeInclude = readFileSync(worktreeIncludePath, "utf8");
      expect(worktreeInclude).toMatch(/^\.env\.\*\.local$/mu);

      // release.yml's release-asset step looks up the Release under both
      // candidate tag spellings rather than uploading to a bare guessed tag.
      const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
      expect(releaseWorkflow).toContain("gh release view");
      expect(releaseWorkflow).toContain('"v${version}"');
      expect(releaseWorkflow).toContain('"${name}@${version}"');
      expect(releaseWorkflow).toContain('gh release upload "$tag"');
      expect(releaseWorkflow).not.toMatch(
        /gh release upload "\$\{name\}@\$\{version\}"/u,
      );

      // Stage every emitted file so the license-headers gate's `git
      // ls-files` read (and the probes below) has something to check.
      execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "inherit" });

      // Required one-time setup step (see publishing's pack.json
      // adoptNotes): backfill the SPDX header the license-headers gate now
      // requires on every pre-existing baseline file. This is a plain node
      // script with no dependencies, so it runs fine before `pnpm install`.
      execFileSync("node", ["bin/check-license-headers.mjs", "--fix"], {
        cwd: targetDir,
        stdio: "inherit",
      });
      execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "inherit" });

      // The fix: with both packs installed, the baseline backfilled, and
      // REUSE.toml as emitted, the license-headers gate passes --
      // .worktreeinclude is covered by its glob.
      const withFix = runLicenseHeadersCheck(targetDir);
      expect(withFix.status).toBe(0);

      // Discriminate the fix: revert the glob on a COPY of the emitted
      // project's own REUSE.toml (never the template under templates/packs/
      // publishing/files/), re-stage, and confirm the gate fails again,
      // flagging .worktreeinclude specifically as neither header-eligible
      // nor REUSE-covered -- proving this test's assertion actually
      // exercises the REUSE.toml glob rather than passing for an unrelated
      // reason.
      const reuseTomlPath = join(targetDir, "REUSE.toml");
      const originalReuseToml = readFileSync(reuseTomlPath, "utf8");
      const sourceReuseToml = readFileSync(
        join(publishingSourceRoot, "REUSE.toml"),
        "utf8",
      );
      expect(
        originalReuseToml.split("__PROJECT_NAME__").join(PROJECT_NAME),
      ).toBe(sourceReuseToml.split("__PROJECT_NAME__").join(PROJECT_NAME));
      const revertedReuseToml = originalReuseToml
        .split("\n")
        .filter((line) => line.trim() !== '".worktreeinclude",')
        .join("\n");
      expect(revertedReuseToml).not.toBe(originalReuseToml);
      try {
        writeFileSync(reuseTomlPath, revertedReuseToml);
        execFileSync("git", ["add", "-A"], {
          cwd: targetDir,
          stdio: "inherit",
        });
        const withoutFix = runLicenseHeadersCheck(targetDir);
        expect(withoutFix.status).not.toBe(0);
        expect(withoutFix.stderr).toContain(".worktreeinclude");
        expect(withoutFix.stderr).toContain(
          "neither header-eligible nor matched by a REUSE.toml annotation",
        );
      } finally {
        // Restore the emitted project's REUSE.toml to its real, fixed
        // content before continuing -- the template itself was never
        // touched.
        writeFileSync(reuseTomlPath, originalReuseToml);
        execFileSync("git", ["add", "-A"], {
          cwd: targetDir,
          stdio: "inherit",
        });
      }
      const restoredCheck = runLicenseHeadersCheck(targetDir);
      expect(restoredCheck.status).toBe(0);

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
