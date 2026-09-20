/**
 * Regression test for the baseline's PreToolUse guards under a symlinked path.
 * `import.meta.url` is symlink-resolved by Node's ESM loader but
 * `process.argv[1]` is not, so a guard that gates its body on comparing the two
 * never runs when the project sits under a symlinked directory (a symlinked
 * home or workspace on Linux, `/tmp` and `/var` on macOS) -- it exits 0, and
 * for a blocking hook exit 0 means "allow". Each case below runs a guard
 * through such a path with a payload it must block, and fails against the old
 * check. `templates/**` is excluded from this repo's vitest discovery, so the
 * hooks are run by path rather than imported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "core",
  ".claude",
  "hooks",
);

function run(
  script: string,
  payload: unknown,
): { status: number | null; stderr: string } {
  const result = spawnSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("baseline guards run through a symlinked hooks directory", () => {
  let scratch: string;
  let linkedHooks: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "core-hooks-symlink-"));
    linkedHooks = join(scratch, "linked-hooks");
    symlinkSync(hooksDir, linkedHooks, "dir");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("guard-no-commonjs still blocks a require() call", () => {
    const { status, stderr } = run(join(linkedHooks, "guard-no-commonjs.mjs"), {
      tool_name: "Write",
      tool_input: {
        file_path: join(scratch, "x.js"),
        content: 'const fs = require("fs");',
      },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("CommonJS");
  });

  it("guard-secret-writes still blocks writing a dotenv file", () => {
    const { status } = run(join(linkedHooks, "guard-secret-writes.mjs"), {
      tool_name: "Write",
      tool_input: { file_path: join(scratch, ".env"), content: "FOO=bar" },
    });
    expect(status).toBe(2);
  });

  it("guard-branch-isolation (which shells out to git) still blocks a src write on main", () => {
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...args: string[]): void => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "init");

    const { status, stderr } = run(
      join(linkedHooks, "guard-branch-isolation.mjs"),
      {
        tool_name: "Write",
        tool_input: { file_path: join(repo, "src", "a.ts"), content: "" },
      },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("main");
  });
});
