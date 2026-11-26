// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The end-to-end acceptance test: actually bootstrap a throwaway project
 * into a temp directory with the built CLI and run its real scripts. No
 * mocks -- this is what "the CLI works" has to mean.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

describe("bootstrap end-to-end", () => {
  it("emits a project whose own install, lint, typecheck, and test pass", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-e2e-"));
    try {
      execFileSync(
        "node",
        [binPath, targetDir, "--name", "e2e-test-project", "--skip-install"],
        { stdio: "inherit" },
      );

      expect(existsSync(join(targetDir, "package.json"))).toBe(true);
      expect(existsSync(join(targetDir, ".git"))).toBe(true);
      expect(
        existsSync(
          join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        ),
      ).toBe(true);

      // A warm pnpm store makes this fast and avoids registry flakiness in
      // a constrained network environment; the store itself still needs to
      // have every dependency this project's package.json names.
      execFileSync("pnpm", ["install", "--prefer-offline"], {
        cwd: targetDir,
        stdio: "inherit",
      });

      // The emitted project's own gate, not a re-derivation of it here --
      // if this passes, the baseline genuinely works standalone.
      execFileSync("pnpm", ["verify"], { cwd: targetDir, stdio: "inherit" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("records a lock, a base snapshot and a ledger that match what was bootstrapped", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-lock-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "lock-e2e",
          "--pack",
          "quality",
          "--pack",
          "statusline",
          "--skip-install",
        ],
        { stdio: "pipe" },
      );
      const sha = (bytes: Buffer): string =>
        createHash("sha256").update(bytes).digest("hex");
      const groundwork = join(targetDir, ".groundwork");
      expect(readdirSync(groundwork).sort()).toEqual([
        "base",
        "groundwork.lock.json",
        "installed-packs.json",
      ]);

      const lock = JSON.parse(
        readFileSync(join(groundwork, "groundwork.lock.json"), "utf8"),
      ) as {
        schemaVersion: number;
        kind: string;
        origin: string;
        via: string;
        files: {
          path: string;
          source: string;
          baseSha256: string | null;
          status: string;
        }[];
      };
      expect(lock.schemaVersion).toBe(1);
      expect(lock.kind).toBe("m3l-groundwork/lock");
      expect(lock.origin).toBe("fresh");
      expect(lock.via).toBe("fresh");
      expect(lock.files.find((f) => f.path === "package.json")?.source).toBe(
        "core",
      );
      const sources = new Set(lock.files.map((f) => f.source));
      expect(sources).toContain("skill");
      expect(sources).toContain("pack:quality");
      expect(sources).toContain("pack:statusline");
      for (const f of lock.files) {
        expect(f.status).toBe("installed");
        const projectBytes = readFileSync(join(targetDir, f.path));
        const baseBytes = readFileSync(
          join(groundwork, "base", `${f.path}.base`),
        );
        expect(f.baseSha256, f.path).toBe(sha(projectBytes));
        expect(sha(baseBytes), f.path).toBe(f.baseSha256);
      }

      // Nothing under base/ may carry a lintable extension, and no staged
      // file may exist anywhere in the project.
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
        );
      for (const file of walk(join(groundwork, "base"))) {
        expect(file.endsWith(".base"), file).toBe(true);
      }
      expect(
        walk(targetDir).filter(
          (f) =>
            !f.includes(`${join(targetDir, ".git")}/`) && f.endsWith(".staged"),
        ),
      ).toEqual([]);

      const ledger = JSON.parse(
        readFileSync(join(groundwork, "installed-packs.json"), "utf8"),
      ) as { schemaVersion: number; packs: Record<string, unknown>[] };
      expect(ledger.schemaVersion).toBe(1);
      expect(ledger.packs.map((p) => p["name"]).sort()).toEqual([
        "quality",
        "statusline",
      ]);
      for (const entry of ledger.packs) {
        expect(entry["via"]).toBe("fresh");
        expect(entry["manifestSha256"]).toMatch(/^[0-9a-f]{64}$/);
      }

      const listing = execFileSync(
        "node",
        [binPath, "--list-packs", targetDir],
        {
          encoding: "utf8",
        },
      );
      for (const name of ["quality", "statusline"]) {
        const line =
          listing
            .split("\n")
            .find((l) => l.trimStart().startsWith(`${name} (`)) ?? "";
        expect(line, name).toContain("[installed]");
        expect(line, name).toContain("(ledger)");
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  // Regression guard for the .groundwork/base/**.base copies: the licensing
  // pack's REUSE.toml must cover them, and the project's .prettierignore must
  // match every tracked file under .groundwork/.
  it("keeps the .groundwork record clear of the license-header and prettier gates", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "m3l-groundwork-gates-e2e-"));
    try {
      execFileSync(
        "node",
        [
          binPath,
          targetDir,
          "--name",
          "gates-e2e",
          "--pack",
          "licensing",
          "--skip-install",
        ],
        { stdio: "pipe" },
      );
      execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "pipe" });

      const sha = (file: string): string =>
        createHash("sha256")
          .update(readFileSync(join(targetDir, file)))
          .digest("hex");
      const trackedFiles = (): string[] =>
        execFileSync("git", ["ls-files", ".groundwork"], {
          cwd: targetDir,
          encoding: "utf8",
        })
          .split("\n")
          .filter((line) => line !== "");
      const recordBefore = new Map(trackedFiles().map((f) => [f, sha(f)]));
      expect(recordBefore.size).toBeGreaterThan(0);

      // The pack's setupSteps: a one-time backfill of the baseline's headers.
      const fix = spawnSync(
        "node",
        [join("bin", "check-license-headers.mjs"), "--fix"],
        { cwd: targetDir, encoding: "utf8" },
      );
      expect(fix.status, `${fix.stdout}${fix.stderr}`).toBe(0);
      execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "pipe" });

      const gate = spawnSync(
        "node",
        [join("bin", "check-license-headers.mjs")],
        { cwd: targetDir, encoding: "utf8" },
      );
      expect(gate.status, `${gate.stdout}${gate.stderr}`).toBe(0);

      // --fix must not have touched anything under .groundwork/.
      const recordAfter = new Map(trackedFiles().map((f) => [f, sha(f)]));
      expect(recordAfter).toEqual(recordBefore);

      const tracked = execFileSync("git", ["ls-files", ".groundwork"], {
        cwd: targetDir,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line !== "");
      expect(tracked.length).toBeGreaterThan(0);
      const ignoreRules = readFileSync(
        join(targetDir, ".prettierignore"),
        "utf8",
      )
        .split("\n")
        .map((line) => line.trim());
      expect(ignoreRules).toContain(".groundwork/");
      for (const file of tracked) {
        expect(file.startsWith(".groundwork/"), file).toBe(true);
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
