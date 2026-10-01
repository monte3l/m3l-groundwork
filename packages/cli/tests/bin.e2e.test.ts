// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * e2e-light coverage of `bin/m3l-groundwork.mjs`'s error reporting -- the one
 * thing that can't be unit-tested, since the bin script delegates straight to
 * the built `dist/main.js`. Needs `pnpm build` first (hence the `.e2e.`
 * naming -- excluded from the default `pnpm test` run the same way
 * `bootstrap.e2e.test.ts` is, see `vitest.config.ts`; run via
 * `pnpm test:e2e`). Narrower and faster than `bootstrap.e2e.test.ts`: no
 * `pnpm install`/`pnpm verify` child process, just the CLI's own exit code
 * and stderr.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

interface RunResult {
  status: number | null;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    execFileSync("node", [binPath, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const { status, stderr } = error as {
      status: number | null;
      stderr: Buffer;
    };
    return { status, stderr: stderr.toString("utf8") };
  }
}

describe("bin/m3l-groundwork.mjs error reporting", () => {
  it("exits 2 and names the unknown pack for an invalid --pack in fresh mode", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "bin-pack-"));
    try {
      const { status, stderr } = run([
        targetDir,
        "--pack",
        "nope",
        "--skip-install",
      ]);
      expect(status).toBe(2);
      expect(stderr).toContain("nope");
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("exits 1 and mentions the symlink when .groundwork is a symlink in adopt mode", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "bin-adopt-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "bin-adopt-outside-"));
    try {
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "acme", type: "module" }),
      );
      mkdirSync(outsideDir, { recursive: true });
      symlinkSync(outsideDir, join(projectDir, ".groundwork"), "dir");

      const { status, stderr } = run([projectDir]);
      expect(status).toBe(1);
      expect(stderr).toContain("symlink");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // Exercises formatErrorChain end to end through the real bin script,
  // rather than unit-testing it against a hand-built Error (format-error.test.ts
  // already covers the formatting rules in isolation, including the
  // dedupe rule this particular scenario doesn't happen to exercise -- its
  // parent and cause messages here are never substrings of one another).
  // Skipped on win32: fresh mode refuses Windows outright before git is ever
  // invoked (see main.ts's runFresh), so this scenario has no equivalent
  // there.
  it.skipIf(process.platform === "win32")(
    "prints a chained 'caused by:' line when git init fails during fresh mode, with the underlying system message appearing exactly once",
    () => {
      const targetDir = mkdtempSync(join(tmpdir(), "bin-chain-"));
      try {
        let result: RunResult;
        try {
          // process.execPath (an absolute path) is used for the outer spawn
          // so resolving "node" itself doesn't depend on PATH -- only the
          // CHILD process (the CLI, which looks up "git" by bare name) is
          // starved of PATH, forcing gitInit's execFileSync to fail ENOENT.
          execFileSync(
            process.execPath,
            [binPath, targetDir, "--skip-install"],
            {
              stdio: ["ignore", "ignore", "pipe"],
              env: { ...process.env, PATH: "" },
            },
          );
          result = { status: 0, stderr: "" };
        } catch (error) {
          const { status, stderr } = error as {
            status: number | null;
            stderr: Buffer;
          };
          result = { status, stderr: stderr.toString("utf8") };
        }

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("caused by:");
        // The underlying ENOENT system message is chained exactly once --
        // never duplicated by the wrapping error's own message.
        const occurrences = result.stderr.split("ENOENT").length - 1;
        expect(occurrences).toBe(1);
      } finally {
        rmSync(targetDir, { recursive: true, force: true });
      }
    },
  );
});
