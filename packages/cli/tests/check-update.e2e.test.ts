// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * e2e coverage of `--check-update` through the built bin (needs
 * `pnpm build`; no network, no `pnpm install`): a fresh bootstrap with the
 * `quality` pack, then the three outcomes, each leaving the tree untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotTree } from "./add-pack-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const binPath = join(packageDir, "bin", "m3l-groundwork.mjs");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const runningVersion = (
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const history = JSON.parse(
  readFileSync(join(packageDir, "data", "template-history.json"), "utf8"),
) as { versions: Record<string, unknown> };
const oldest = Object.keys(history.versions)[0] as string;

/**
 * Makes `dir` look installed from an older release: the lock records
 * `baseVersion`, and `lefthook.yml` is untouched since that release's
 * (older) text, so an update would take the current one.
 */
function installFromOlderRelease(dir: string, baseVersion: string): void {
  const lockPath = join(dir, ".groundwork", "groundwork.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    baseVersion: string;
    files: { path: string; baseSha256: string | null }[];
  };
  const older = "older: true\n";
  writeFileSync(join(dir, ".groundwork", "base", "lefthook.yml.base"), older);
  writeFileSync(join(dir, "lefthook.yml"), older);
  for (const file of lock.files) {
    if (file.path === "lefthook.yml") {
      file.baseSha256 = createHash("sha256").update(older).digest("hex");
    }
  }
  lock.baseVersion = baseVersion;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

describe.skipIf(process.platform === "win32")(
  "--check-update (built bin)",
  () => {
    let root: string;
    let dir: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "check-update-e2e-"));
      dir = join(root, "acme");
      const boot = run([dir, "--skip-install", "--pack", "quality"]);
      expect(boot.status).toBe(0);
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("exits 0 and says 'up to date' for an untouched bootstrap, writing nothing", () => {
      const before = snapshotTree(dir);
      const result = run([dir, "--check-update"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("up to date");
      expect(snapshotTree(dir)).toEqual(before);
    });

    it("exits 3 and reports changed files once the lock records an older release", () => {
      installFromOlderRelease(dir, oldest);
      const before = snapshotTree(dir);
      const result = run([dir, "--check-update"]);
      expect(result.status).toBe(3);
      expect(result.stdout).toContain(
        `base ${oldest} (lock), CLI ${runningVersion}`,
      );
      expect(result.stdout).toMatch(/\d+ file\(s\) changed upstream/);
      expect(result.stdout).toContain("update available");
      expect(snapshotTree(dir)).toEqual(before);
    });

    it("exits 0 when ONLY the lock's baseVersion is lowered: every file already matches the new templates", () => {
      const lockPath = join(dir, ".groundwork", "groundwork.lock.json");
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf8").replace(
          `"baseVersion": "${runningVersion}"`,
          `"baseVersion": "${oldest}"`,
        ),
      );
      const result = run([dir, "--check-update"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("already matches or keeps them");
      expect(result.stdout).not.toContain("update available");
    });

    it("previews what an update would do to this project's files", () => {
      const read = (rel: string): string =>
        readFileSync(join(dir, rel), "utf8");
      const lockPath = join(dir, ".groundwork", "groundwork.lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        baseVersion: string;
        files: { path: string; baseSha256: string | null }[];
      };
      const older = "older: true\n";
      const baseFile = (rel: string): string =>
        join(dir, ".groundwork", "base", `${rel}.base`);
      // lefthook.yml: installed from an older release, untouched since.
      writeFileSync(baseFile("lefthook.yml"), older);
      writeFileSync(join(dir, "lefthook.yml"), older);
      // eslint.config.js: older release, edited locally since.
      const oldEslint = "export default [];\n";
      writeFileSync(baseFile("eslint.config.js"), oldEslint);
      writeFileSync(join(dir, "eslint.config.js"), `${oldEslint}// mine\n`);
      const hash = (text: string): string =>
        createHash("sha256").update(text).digest("hex");
      for (const file of lock.files) {
        if (file.path === "lefthook.yml") file.baseSha256 = hash(older);
        if (file.path === "eslint.config.js") file.baseSha256 = hash(oldEslint);
      }
      lock.baseVersion = oldest;
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      expect(read("lefthook.yml")).toBe(older);

      const before = snapshotTree(dir);
      const result = run([dir, "--check-update"]);
      expect(result.status).toBe(3);
      expect(result.stdout).toContain(
        "if you update: 1 update cleanly, 1 need a merge",
      );
      expect(snapshotTree(dir)).toEqual(before);
    });

    it("exits 2 for a malformed --base-version, writing nothing", () => {
      const before = snapshotTree(dir);
      const result = run([dir, "--check-update", "--base-version", "latest"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--base-version");
      expect(snapshotTree(dir)).toEqual(before);
    });
  },
);
