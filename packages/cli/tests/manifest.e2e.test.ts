// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The install manifest end to end: the real built CLI bootstraps a project
 * with one pack, `.groundwork/manifest.json` records what was emitted, and a
 * later adopt run leaves it byte-identical. No mocks; needs `pnpm build`.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

interface ManifestOnDisk {
  schemaVersion: number;
  cliVersion: string;
  tokens: Record<string, string>;
  packs: string[];
  files: Record<string, { sha256: string; origin: string }>;
  jsonKeys: Record<string, Record<string, string>>;
}

function run(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("node", [binPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (rel === ".groundwork" || rel === ".git") continue;
      if (entry.isDirectory()) visit(join(current, entry.name), rel);
      else found.push(rel);
    }
  };
  visit(root, "");
  return found.sort();
}

describe("install manifest end-to-end", () => {
  it("records a fresh bootstrap with one pack, and adopt leaves it byte-identical", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "m3l-manifest-e2e-"));
    try {
      const fresh = run([
        projectDir,
        "--name",
        "manifest-e2e",
        "--skip-install",
        "--pack",
        "harness-extras",
      ]);
      expect(fresh.status, fresh.output).toBe(0);
      expect(fresh.output).toContain("wrote .groundwork/manifest.json");

      const manifestPath = join(projectDir, ".groundwork", "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as ManifestOnDisk;

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.packs).toEqual(["harness-extras"]);
      expect(manifest.tokens["PROJECT_NAME"]).toBe("manifest-e2e");

      // Every emitted file is recorded, hashed from the bytes on disk. The
      // /customize skill's files are installed but deliberately not recorded.
      const recorded = Object.keys(manifest.files).sort();
      expect(recorded).toEqual(
        listFiles(projectDir).filter(
          (rel) => !rel.startsWith(".claude/skills/customize/"),
        ),
      );
      for (const [rel, entry] of Object.entries(manifest.files)) {
        expect(entry.origin).toBe("emitted");
        expect(entry.sha256).toBe(sha(join(projectDir, rel)));
      }

      // Pinned by hand: templates/core/package.json declares scripts.verify.
      expect(manifest.jsonKeys["package.json"]).toHaveProperty(
        "scripts.verify",
      );

      const before = readFileSync(manifestPath);
      const adopt = run([projectDir, "--adopt"]);
      expect(adopt.status, adopt.output).toBe(0);
      expect(
        existsSync(join(projectDir, ".groundwork", "inventory.json")),
      ).toBe(true);
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
