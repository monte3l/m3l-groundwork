// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * e2e coverage of `--update` through the built bin (needs `pnpm build`; no
 * network, no `pnpm install`): a real bootstrap with the `quality` pack and
 * a git repository, an older release simulated for a few files, then the
 * staged update -- exit 0, the staged layout, the plan, nothing outside
 * `.groundwork/update/` changed, a clean `git status`, and a second run
 * replacing the staging with the same plan.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotTree } from "./add-pack-fixtures.js";
import { readLockOrThrow, simulateOlder } from "./update-classify-fixtures.js";
import { parseLock } from "../src/lock.js";
import type { UpdatePlan } from "./update-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const binPath = join(packageDir, "bin", "m3l-groundwork.mjs");
const cliVersion = (
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    version: string;
  }
).version;

function run(args: string[], cwd?: string) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    ...(cwd === undefined ? {} : { cwd }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(dir: string, args: string[]) {
  return spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

const swapFirstLine = (text: string, line: string): string =>
  [line, ...text.split("\n").slice(1)].join("\n");

describe.skipIf(process.platform === "win32")("--update (built bin)", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "update-e2e-"));
    dir = join(root, "acme");
    const boot = run([dir, "--skip-install", "--pack", "quality"]);
    expect(boot.status).toBe(0);

    const read = (path: string): string =>
      readFileSync(join(dir, path), "utf8");
    // Clean text merge: upstream changed the first line, the owner the last.
    const eslint = read("eslint.config.js");
    const eslintBase = swapFirstLine(eslint, "// old header");
    simulateOlder(
      dir,
      "eslint.config.js",
      eslintBase,
      `${eslintBase}// mine\n`,
    );
    // Text conflict: both changed the first line.
    const vitest = read("vitest.config.ts");
    simulateOlder(
      dir,
      "vitest.config.ts",
      swapFirstLine(vitest, "// base line"),
      swapFirstLine(vitest, "// my line"),
    );
    // Clean per-key JSON merge: the owner bumped a dependency.
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
    };
    const baseText = `${JSON.stringify({ ...pkg, oldUpstream: 1 }, null, 2)}\n`;
    const [depName] = Object.keys(pkg.devDependencies);
    const bumped = {
      ...pkg,
      oldUpstream: 1,
      devDependencies: {
        ...pkg.devDependencies,
        [depName as string]: "99.99.99",
      },
    };
    simulateOlder(
      dir,
      "package.json",
      baseText,
      `${JSON.stringify(bumped, null, 2)}\n`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const outside = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(snapshotTree(dir)).filter(
        ([key]) =>
          key !== ".groundwork/update" &&
          !key.startsWith(".groundwork/update/") &&
          !key.startsWith(".git/"),
      ),
    );

  const plan = (): UpdatePlan =>
    JSON.parse(
      readFileSync(join(dir, ".groundwork/update/plan.json"), "utf8"),
    ) as UpdatePlan;

  it("stages the update with exit 0, writing nothing outside .groundwork/update/", () => {
    const before = outside();
    const result = run([dir, "--update"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`-> ${cliVersion}`);
    expect(result.stdout).toMatch(/^next: /m);
    expect(outside()).toEqual(before);

    const p = plan();
    expect(p).toMatchObject({
      schemaVersion: 1,
      kind: "m3l-groundwork/update-plan",
      merge: { tool: "git-merge-file" },
    });
    const action = (path: string): string | undefined =>
      p.files.find((f) => f.path === path)?.action;
    expect(action("eslint.config.js")).toBe("merge");
    expect(action("vitest.config.ts")).toBe("conflict");
    expect(action("package.json")).toBe("merge");

    const base = join(dir, ".groundwork/update");
    expect(existsSync(join(base, "merged/eslint.config.js.staged"))).toBe(true);
    expect(
      readFileSync(join(base, "merged/vitest.config.ts.staged"), "utf8"),
    ).toContain("<<<<<<< yours");
    const merged = JSON.parse(
      readFileSync(join(base, "merged/package.json.staged"), "utf8"),
    ) as { devDependencies: Record<string, string>; oldUpstream?: number };
    expect(Object.values(merged.devDependencies)).toContain("99.99.99");
    expect(merged.oldUpstream).toBeUndefined();

    const lockNext = parseLock(
      readFileSync(join(base, "lock-next.json"), "utf8"),
    );
    expect(lockNext.baseVersion).toBe(cliVersion);
    expect(lockNext.via).toBe("update");
    expect(readLockOrThrow(dir).baseVersion).toBe("1.0.0");
    expect(p.staged.files.map((f) => f.staged)).toContain("lock-next.json");
  });

  it("keeps git status clean once the update is staged", () => {
    git(dir, ["add", "-A"]);
    git(dir, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "baseline",
    ]);
    expect(git(dir, ["status", "--porcelain"]).stdout).toBe("");
    expect(run([dir, "--update"]).status).toBe(0);
    expect(existsSync(join(dir, ".groundwork/update/plan.json"))).toBe(true);
    expect(git(dir, ["status", "--porcelain"]).stdout).toBe("");
  });

  it("replaces the staging on a second run and yields the same plan", () => {
    expect(run([dir, "--update"]).status).toBe(0);
    const first = plan();
    writeFileSync(join(dir, ".groundwork/update/stale.staged"), "stale");
    expect(run([dir, "--update"]).status).toBe(0);
    const second = plan();
    const strip = (p: UpdatePlan): unknown => ({ ...p, generatedAt: "" });
    expect(strip(second)).toEqual(strip(first));
    expect(existsSync(join(dir, ".groundwork/update/stale.staged"))).toBe(
      false,
    );
  });

  it("refuses --update with --check-update (exit 2) and creates nothing", () => {
    const before = snapshotTree(dir);
    const result = run([dir, "--update", "--check-update"]);
    expect(result.status).toBe(2);
    expect(snapshotTree(dir)).toEqual(before);
  });
});
