// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--upgrade` end to end: the real built CLI bootstraps a project, then plans
 * an upgrade against it. The plan is staged under `.groundwork/upgrade/` and
 * nothing else in the project changes. No mocks; needs `pnpm build`.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

function run(args: string[]): {
  status: number | null;
  stdout: string;
  output: string;
} {
  const result = spawnSync("node", [binPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

/** Every file outside `.git/` and `.groundwork/upgrade/`, path to content hash. */
function snapshot(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (rel === ".git" || rel === ".groundwork/upgrade") continue;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel);
      else
        found.set(
          rel,
          createHash("sha256")
            .update(readFileSync(join(dir, entry.name)))
            .digest("hex"),
        );
    }
  };
  visit(root, "");
  return found;
}

describe("--upgrade end-to-end", () => {
  it("stages a plan for a fresh project and changes nothing else", () => {
    const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
    const projectDir = join(base, "app");
    try {
      const bootstrap = run([projectDir, "--skip-install"]);
      expect(bootstrap.status, bootstrap.output).toBe(0);
      const before = snapshot(projectDir);

      const result = run([projectDir, "--upgrade"]);

      expect(result.status, result.output).toBe(0);
      expect(result.stdout).toContain(".groundwork/upgrade/");
      const upgradeDir = join(projectDir, ".groundwork", "upgrade");
      expect(existsSync(join(upgradeDir, "plan.json"))).toBe(true);
      expect(existsSync(join(upgradeDir, "upgrade-report.md"))).toBe(true);
      const plan = JSON.parse(
        readFileSync(join(upgradeDir, "plan.json"), "utf8"),
      ) as { files: { class: string }[]; legacy: boolean };
      expect(plan.legacy).toBe(false);
      expect(plan.files.length).toBeGreaterThan(50);
      expect(plan.files.every((e) => e.class === "current")).toBe(true);
      expect(snapshot(projectDir)).toEqual(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("exits 2 for --upgrade --json, with a message", () => {
    const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
    const projectDir = join(base, "app");
    try {
      expect(run([projectDir, "--skip-install"]).status).toBe(0);
      const result = run([projectDir, "--upgrade", "--json"]);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain("--json");
      expect(result.output).toMatch(/not available yet/);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report["schema"]).toBe("groundwork.report");
      expect(report["status"]).toBe("usage");
      expect(report["exitCode"]).toBe(2);
      expect(existsSync(join(projectDir, ".groundwork", "upgrade"))).toBe(
        false,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("exits 2 for --upgrade --adopt", () => {
    const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
    const projectDir = join(base, "app");
    try {
      expect(run([projectDir, "--skip-install"]).status).toBe(0);
      const result = run([projectDir, "--upgrade", "--adopt"]);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain("mutually exclusive");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("exits 2 with the adopt advice for a directory with no manifest, writing nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
    const projectDir = join(base, "legacy");
    try {
      mkdirSync(projectDir);
      writeFileSync(join(projectDir, "package.json"), '{"name":"legacy"}\n');
      const before = snapshot(projectDir);

      const result = run([projectDir, "--upgrade"]);

      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain("manifest");
      expect(result.output).toContain("npx @monte3l/groundwork .");
      expect(snapshot(projectDir)).toEqual(before);
      expect(existsSync(join(projectDir, ".groundwork"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
