// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--pack` in adopt mode, end to end: runs the real built CLI against a
 * temp existing project and asserts the survey is narrowed to the named
 * packs, an unknown pack fails before touching `.groundwork/`, and no
 * project file changes. No mocks.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Inventory } from "../src/inventory.js";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      snapshot.set(
        relative(root, absPath),
        createHash("sha256").update(readFileSync(absPath)).digest("hex"),
      );
    }
  };
  visit(root);
  return snapshot;
}

function buildProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "existing-project", version: "1.0.0" }, null, 2),
  );
  writeFileSync(join(dir, "CLAUDE.md"), "# existing-project\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.js"), "export const x = 1;\n");
}

function run(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("node", [binPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

describe("adopt mode --pack end-to-end", () => {
  it("narrows the survey to the named pack and changes no project file", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "m3l-adopt-pack-e2e-"));
    try {
      buildProject(projectDir);
      const before = snapshotTree(projectDir);

      const result = run([projectDir, "--pack", "harness-extras"]);
      expect(result.status, result.output).toBe(0);

      const after = snapshotTree(projectDir);
      for (const [relPath, hash] of before) {
        expect(after.get(relPath)).toBe(hash);
      }

      const inventory = JSON.parse(
        readFileSync(join(projectDir, ".groundwork", "inventory.json"), "utf8"),
      ) as Inventory;
      expect(inventory.packs.map((p) => p.name)).toEqual(["harness-extras"]);
      expect(inventory.stagedPacks.map((p) => p.name)).toEqual([
        "harness-extras",
      ]);
      expect(readdirSync(join(projectDir, ".groundwork", "packs"))).toEqual([
        "harness-extras",
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("exits 2 on an unknown pack and creates nothing under .groundwork/", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "m3l-adopt-pack-e2e-"));
    try {
      buildProject(projectDir);
      const before = snapshotTree(projectDir);

      const result = run([projectDir, "--pack", "nope"]);

      expect(result.status).toBe(2);
      expect(result.output).toContain('unknown pack "nope"');
      expect(existsSync(join(projectDir, ".groundwork"))).toBe(false);
      expect(snapshotTree(projectDir)).toEqual(before);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
