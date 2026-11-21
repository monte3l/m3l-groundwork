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
  statSync,
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

/** The only directories `--upgrade` may write under, besides nothing else. */
const UPGRADE_WRITE_ROOTS = [
  ".groundwork/upgrade",
  ".claude/skills/upgrade",
  ".groundwork/upgrade-skill",
];
const skillSourceDir = join(here, "..", "..", "plugin", "skills", "upgrade");
const SKILL_FILES = ["SKILL.md", "step-3-conflicts.md"] as const;

/** Every file outside `.git/` and the three directories `--upgrade` owns, path to content hash. */
function snapshot(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (rel === ".git" || UPGRADE_WRITE_ROOTS.includes(rel)) continue;
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

  describe("the /upgrade skill install", () => {
    const withProject = (body: (projectDir: string) => void): void => {
      const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
      const projectDir = join(base, "app");
      try {
        const bootstrap = run([projectDir, "--skip-install"]);
        expect(bootstrap.status, bootstrap.output).toBe(0);
        body(projectDir);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    };
    const claudeSkill = (projectDir: string, name: string): string =>
      join(projectDir, ".claude", "skills", "upgrade", name);
    const fallbackSkill = (projectDir: string, name: string): string =>
      join(projectDir, ".groundwork", "upgrade-skill", name);

    it("installs the plugin's /upgrade skill byte-for-byte into .claude/skills/upgrade/", () => {
      withProject((projectDir) => {
        const result = run([projectDir, "--upgrade"]);
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          "installed the /upgrade skill into .claude/skills/upgrade (2 files)",
        );
        for (const name of SKILL_FILES) {
          expect(readFileSync(claudeSkill(projectDir, name)), name).toEqual(
            readFileSync(join(skillSourceDir, name)),
          );
        }
        expect(
          existsSync(join(projectDir, ".groundwork", "upgrade-skill")),
        ).toBe(false);
      });
    });

    it("writes only under .groundwork/upgrade/, .claude/skills/upgrade/ and .groundwork/upgrade-skill/, leaving the manifest alone", () => {
      withProject((projectDir) => {
        const before = snapshot(projectDir);
        expect(run([projectDir, "--upgrade"]).status).toBe(0);
        expect(snapshot(projectDir)).toEqual(before);
        expect(existsSync(claudeSkill(projectDir, "SKILL.md"))).toBe(true);
      });
    });

    it("keeps a project-owned different SKILL.md untouched and installs the copy under .groundwork/upgrade-skill/", () => {
      withProject((projectDir) => {
        mkdirSync(join(projectDir, ".claude", "skills", "upgrade"), {
          recursive: true,
        });
        writeFileSync(claudeSkill(projectDir, "SKILL.md"), "# mine\n");

        const result = run([projectDir, "--upgrade"]);

        expect(result.status, result.output).toBe(0);
        expect(readFileSync(claudeSkill(projectDir, "SKILL.md"), "utf8")).toBe(
          "# mine\n",
        );
        expect(existsSync(claudeSkill(projectDir, "step-3-conflicts.md"))).toBe(
          false,
        );
        for (const name of SKILL_FILES) {
          expect(readFileSync(fallbackSkill(projectDir, name)), name).toEqual(
            readFileSync(join(skillSourceDir, name)),
          );
        }
        expect(result.output).toContain(
          "installed the /upgrade skill into .groundwork/upgrade-skill (2 files)",
        );
      });
    });

    it("prints the already-present line and writes no skill file when re-run over an identical copy", () => {
      withProject((projectDir) => {
        expect(run([projectDir, "--upgrade"]).status).toBe(0);
        const mtimes = SKILL_FILES.map(
          (name) => statSync(claudeSkill(projectDir, name)).mtimeMs,
        );

        const second = run([projectDir, "--upgrade"]);

        expect(second.status, second.output).toBe(0);
        expect(second.output).toContain(
          "the /upgrade skill is already present in .claude/skills/upgrade",
        );
        expect(second.output).not.toContain("installed the /upgrade skill");
        expect(
          SKILL_FILES.map(
            (name) => statSync(claudeSkill(projectDir, name)).mtimeMs,
          ),
        ).toEqual(mtimes);
      });
    });

    it("keeps .groundwork/upgrade-skill/ across the next --upgrade run without warning about it", () => {
      withProject((projectDir) => {
        mkdirSync(join(projectDir, ".claude", "skills", "upgrade"), {
          recursive: true,
        });
        writeFileSync(claudeSkill(projectDir, "SKILL.md"), "# mine\n");
        expect(run([projectDir, "--upgrade"]).status).toBe(0);

        const second = run([projectDir, "--upgrade"]);

        expect(second.status, second.output).toBe(0);
        for (const name of SKILL_FILES) {
          expect(readFileSync(fallbackSkill(projectDir, name)), name).toEqual(
            readFileSync(join(skillSourceDir, name)),
          );
        }
        expect(second.output).not.toMatch(/discarded/);
        expect(second.output).not.toContain("upgrade-skill from");
      });
    });

    it("does not install the skill when --upgrade refuses a project with no manifest", () => {
      const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
      const projectDir = join(base, "legacy");
      try {
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, "package.json"), '{"name":"legacy"}\n');
        expect(run([projectDir, "--upgrade"]).status).toBe(2);
        expect(existsSync(join(projectDir, ".claude"))).toBe(false);
        expect(existsSync(join(projectDir, ".groundwork"))).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
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
  describe("--upgrade --stamp", () => {
    const sha = (text: string | Buffer): string =>
      createHash("sha256").update(text).digest("hex");

    it("records a hand-applied safe-update in the manifest and changes no project file", () => {
      const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
      const projectDir = join(base, "app");
      try {
        expect(run([projectDir, "--skip-install"]).status).toBe(0);
        const file = join(projectDir, "commitlint.config.js");
        const fresh = readFileSync(file, "utf8");
        const old = "// the old commitlint config\n";
        // Simulate an upstream change: the project and the manifest hold the old bytes.
        writeFileSync(file, old);
        const manifestPath = join(projectDir, ".groundwork", "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          cliVersion: string;
          files: Record<string, { sha256: string; origin: string }>;
        };
        manifest.files["commitlint.config.js"] = {
          sha256: sha(old),
          origin: "emitted",
        };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const planned = run([projectDir, "--upgrade"]);
        expect(planned.status, planned.output).toBe(0);
        expect(
          existsSync(
            join(
              projectDir,
              ".groundwork",
              "upgrade",
              "staged",
              "commitlint.config.js.staged",
            ),
          ),
        ).toBe(true);

        // Apply by hand, as the report says.
        writeFileSync(file, fresh);
        const before = snapshot(projectDir);

        const stamped = run([projectDir, "--upgrade", "--stamp"]);

        expect(stamped.status, stamped.output).toBe(0);
        expect(stamped.stdout).toMatch(
          /stamped \.groundwork\/manifest\.json at \S+: 1 updated, \d+ kept, 0 dropped/,
        );
        const after = snapshot(projectDir);
        const changed = [...new Set([...before.keys(), ...after.keys()])]
          .filter((path) => before.get(path) !== after.get(path))
          .sort();
        expect(changed).toEqual([".groundwork/manifest.json"]);
        const stampedManifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as typeof manifest;
        expect(stampedManifest.files["commitlint.config.js"]).toEqual({
          sha256: sha(fresh),
          origin: "emitted",
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it("says nothing needs applying, and --upgrade --stamp then records the new release", () => {
      const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
      const projectDir = join(base, "app");
      try {
        expect(run([projectDir, "--skip-install"]).status).toBe(0);
        const manifestPath = join(projectDir, ".groundwork", "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          cliVersion: string;
        };
        const release = manifest.cliVersion;
        manifest.cliVersion = "0.0.1";
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const planned = run([projectDir, "--upgrade"]);
        expect(planned.status, planned.output).toBe(0);
        expect(planned.stdout).toContain(
          "Next: nothing to apply -- run --upgrade --stamp to record the new release in the manifest",
        );

        const stamped = run([projectDir, "--upgrade", "--stamp"]);
        expect(stamped.status, stamped.output).toBe(0);
        const after = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          cliVersion: string;
        };
        expect(after.cliVersion).toBe(release);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it("exits 2 for --stamp without --upgrade", () => {
      const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
      const projectDir = join(base, "app");
      try {
        expect(run([projectDir, "--skip-install"]).status).toBe(0);
        const result = run([projectDir, "--stamp"]);
        expect(result.status, result.output).toBe(2);
        expect(result.output).toMatch(/needs --upgrade/);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it("exits 2 with 'no plan to stamp' when no plan was staged", () => {
      const base = mkdtempSync(join(tmpdir(), "m3l-upgrade-e2e-"));
      const projectDir = join(base, "app");
      try {
        expect(run([projectDir, "--skip-install"]).status).toBe(0);
        const result = run([projectDir, "--upgrade", "--stamp"]);
        expect(result.status, result.output).toBe(2);
        expect(result.output).toContain(
          "no plan to stamp -- run --upgrade first",
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
