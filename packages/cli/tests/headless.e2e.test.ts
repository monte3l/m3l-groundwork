// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * End-to-end `--json` contract through the real bin script: stdout is exactly
 * one JSON document, the human text is on stderr, exit codes are 0/1/2, and a
 * child process's stdout (a fake `pnpm`/`git` on PATH) never leaks onto
 * stdout. Needs `pnpm build` first; run via `pnpm test:e2e`.
 */
import { describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");
const cliVersion = (
  JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

interface Spawned {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Spawned {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** stdout must be one line of JSON plus its newline, and nothing else. */
function onlyDocument(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(stdout) as Record<string, unknown>;
}

const NO_ARTIFACTS = {
  plan: null,
  pending: null,
  commitMsg: null,
  prBody: null,
};

function withTmp<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("--json through bin/m3l-groundwork.mjs", () => {
  it("fresh --skip-install: stdout is one ok/apply report, human text on stderr, exit 0", () => {
    withTmp("hl-fresh-", (dir) => {
      const target = join(dir, "acme");
      const { status, stdout, stderr } = run([
        target,
        "--skip-install",
        "--json",
      ]);

      expect(status).toBe(0);
      expect(onlyDocument(stdout)).toEqual({
        schema: "groundwork.report",
        schemaVersion: 1,
        cliVersion,
        mode: "fresh",
        phase: "apply",
        dryRun: false,
        status: "ok",
        exitCode: 0,
        target,
        artifacts: { inventory: null, ...NO_ARTIFACTS },
        changes: [],
        pending: [],
        handoff: [],
        drift: [],
        setupSteps: [],
        warnings: [],
        nextStep: null,
        error: null,
      });
      expect(stderr).toContain("is ready at");
      expect(stderr).toContain("initialized git repository");
    });
  });

  it("fresh with a pack: setupSteps land in the report", () => {
    withTmp("hl-pack-", (dir) => {
      const { status, stdout } = run([
        join(dir, "acme"),
        "--skip-install",
        "--pack",
        "publishing",
        "--json",
      ]);
      expect(status).toBe(0);
      const report = onlyDocument(stdout) as {
        setupSteps: { pack: string; steps: string[] }[];
      };
      expect(report.setupSteps.map((s) => s.pack)).toContain("publishing");
    });
  });

  it.skipIf(process.platform === "win32")(
    "fresh without --skip-install: a fake pnpm/git printing to stdout never reaches stdout",
    () => {
      withTmp("hl-fake-", (dir) => {
        const bin = join(dir, "fakebin");
        mkdirSync(bin);
        for (const [name, marker] of [
          ["pnpm", "FAKE-PNPM-STDOUT"],
          ["git", "FAKE-GIT-STDOUT"],
        ] as const) {
          const file = join(bin, name);
          writeFileSync(
            file,
            `#!/bin/sh\necho ${marker}\necho ${marker}-ERR >&2\nexit 0\n`,
          );
          chmodSync(file, 0o755);
        }
        const { status, stdout, stderr } = run([join(dir, "acme"), "--json"], {
          PATH: bin,
        });

        expect(status).toBe(0);
        expect(stdout).not.toContain("FAKE-");
        expect(onlyDocument(stdout)).toMatchObject({
          status: "ok",
          mode: "fresh",
        });
        // The children's stdout was redirected to stderr, not dropped.
        expect(stderr).toContain("FAKE-PNPM-STDOUT");
        expect(stderr).toContain("FAKE-GIT-STDOUT");
      });
    },
  );

  it("adopt survey: stdout is one ok/survey report naming the relative inventory", () => {
    withTmp("hl-adopt-", (dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "acme", type: "module" }),
      );
      const { status, stdout, stderr } = run([dir, "--json"]);

      expect(status).toBe(0);
      const report = onlyDocument(stdout) as Record<string, unknown> & {
        nextStep: string;
      };
      expect(report).toMatchObject({
        schema: "groundwork.report",
        schemaVersion: 1,
        cliVersion,
        mode: "adopt",
        phase: "survey",
        status: "ok",
        exitCode: 0,
        target: dir,
        artifacts: { inventory: ".groundwork/inventory.json", ...NO_ARTIFACTS },
        error: null,
      });
      expect(report.nextStep).toMatch(/^Next: /);
      expect(stderr).toContain("adopt mode");
      expect(stderr).toContain(report.nextStep);
    });
  });

  it("usage error from parseArgs: exit 2, usage envelope on stdout, message on stderr, written once", () => {
    const { status, stdout, stderr } = run(["--bogus", "--json"]);

    expect(status).toBe(2);
    const report = onlyDocument(stdout) as {
      error: { message: string; chain: string[] };
    };
    expect(report).toMatchObject({
      schema: "groundwork.report",
      schemaVersion: 1,
      cliVersion,
      mode: null,
      phase: null,
      status: "usage",
      exitCode: 2,
      target: null,
    });
    expect(report.error.message).toContain("unrecognized option: --bogus");
    expect(report.error.chain[0]).toBe(report.error.message);
    expect(stderr).toContain("unrecognized option: --bogus");
  });

  it("runtime error (--fresh onto a non-empty dir without --force): exit 1, error envelope", () => {
    withTmp("hl-err-", (dir) => {
      writeFileSync(join(dir, "package.json"), "{}");
      const { status, stdout, stderr } = run([
        dir,
        "--fresh",
        "--skip-install",
        "--json",
      ]);

      expect(status).toBe(1);
      const report = onlyDocument(stdout) as {
        error: { message: string; chain: string[] };
      };
      expect(report).toMatchObject({
        status: "error",
        exitCode: 1,
        mode: null,
        phase: null,
      });
      expect(report.error.message.length).toBeGreaterThan(0);
      expect(stderr).toContain(report.error.message);
    });
  });

  it("without --json a failing run prints no JSON on stdout", () => {
    const { status, stdout } = run(["--bogus"]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
  });

  it("--version --json prints one groundwork.version document", () => {
    const { status, stdout } = run(["--version", "--json"]);
    expect(status).toBe(0);
    expect(onlyDocument(stdout)).toEqual({
      schema: "groundwork.version",
      schemaVersion: 1,
      cliVersion,
    });
  });

  it("--list-packs --json prints one groundwork.packs document", () => {
    const { status, stdout } = run(["--list-packs", "--json"]);
    expect(status).toBe(0);
    const doc = onlyDocument(stdout) as { packs: { name: string }[] };
    expect(doc).toMatchObject({ schema: "groundwork.packs", schemaVersion: 1 });
    expect(doc.packs.map((p) => p.name)).toContain("publishing");
  });

  it("--help --json prints the usage text, not JSON", () => {
    const { status, stdout } = run(["--help", "--json"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^usage: m3l-groundwork/);
  });
});
