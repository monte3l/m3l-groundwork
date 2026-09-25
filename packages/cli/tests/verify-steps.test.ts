/**
 * Fix 3: `bin/verify.mjs` and `templates/core/bin/verify.mjs` silently fall
 * through to running EVERY step when `--group`/`--step` is the LAST argv
 * token (no value follows) -- `args[groupIndex + 1]` is `undefined`, which
 * is falsy, so the "unknown group" check is skipped AND the ternary that
 * picks `stepsInGroup(requestedGroup)` falls through to `VERIFY_STEPS`
 * (everything). The fix should print an error and exit non-zero instead.
 *
 * Neither script is unit-testable via import (both run top-level code
 * immediately on argv), so each is spawned as a real child process. Running
 * the REAL `bin/lib/verify-steps.mjs` would mean actually invoking `pnpm
 * format:check`/`pnpm test:coverage`/etc, which is slow and not what this
 * fix is about -- instead each script is copied into a throwaway directory
 * alongside a small, controlled `lib/verify-steps.mjs` fixture (two trivial,
 * instantly-distinguishable steps) so the only thing under test is the
 * argv-parsing/fallback logic itself.
 *
 * Fix 4: `templates/core/bin/lib/verify-steps.mjs`'s `readPackSteps` catches
 * every error reading `verify-steps.packs.json` (not just "file does not
 * exist") and silently returns `[]` either way -- so a permissions error or
 * the path being a directory is indistinguishable from "no packs installed"
 * and the failure is never surfaced. The fix should only swallow `ENOENT`
 * and rethrow anything else. Constructing a portable, non-ENOENT read error
 * without touching the repo's real `templates/core/bin/lib/verify-steps.packs.json`
 * (which already exists and must not be modified) means copying
 * `verify-steps.mjs` into a throwaway directory and making ITS sibling
 * `verify-steps.packs.json` a directory instead of a file, which reliably
 * throws EISDIR on read.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const FIXTURE_LIB = `\
export const GROUPS = ["format", "lint"];
export const VERIFY_STEPS = [
  { id: "a", group: "format", name: "Step A", cmd: ["node", "-e", "console.log('STEP_A_RAN')"] },
  { id: "b", group: "lint", name: "Step B", cmd: ["node", "-e", "console.log('STEP_B_RAN')"] },
];
export function findStep(id) { return VERIFY_STEPS.find((s) => s.id === id); }
export function stepsInGroup(group) { return VERIFY_STEPS.filter((s) => s.group === group); }
`;

/** Copies `scriptPath` plus the fixture lib into a fresh throwaway dir. */
function makeSandbox(scriptPath: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "verify-argv-"));
  mkdirSync(join(scratch, "lib"), { recursive: true });
  copyFileSync(scriptPath, join(scratch, "verify.mjs"));
  writeFileSync(join(scratch, "lib", "verify-steps.mjs"), FIXTURE_LIB);
  return scratch;
}

function runVerify(
  scratch: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [join(scratch, "verify.mjs"), ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe.each([
  ["bin/verify.mjs", join(repoRoot, "bin", "verify.mjs")],
  [
    "templates/core/bin/verify.mjs",
    join(repoRoot, "templates", "core", "bin", "verify.mjs"),
  ],
])("%s -- --group/--step with no trailing value", (_label, scriptPath) => {
  it("rejects a trailing --group with no value instead of running every step", () => {
    const scratch = makeSandbox(scriptPath);
    try {
      const { status, stdout } = runVerify(scratch, ["--group"]);
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("STEP_A_RAN");
      expect(stdout).not.toContain("STEP_B_RAN");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a trailing --step with no value instead of running every step", () => {
    const scratch = makeSandbox(scriptPath);
    try {
      const { status, stdout } = runVerify(scratch, ["--step"]);
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("STEP_A_RAN");
      expect(stdout).not.toContain("STEP_B_RAN");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still runs exactly the requested group's step when a value IS given (regression guard)", () => {
    const scratch = makeSandbox(scriptPath);
    try {
      const { status, stdout } = runVerify(scratch, ["--group", "format"]);
      expect(status).toBe(0);
      expect(stdout).toContain("STEP_A_RAN");
      expect(stdout).not.toContain("STEP_B_RAN");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("templates/core/bin/lib/verify-steps.mjs -- readPackSteps error handling", () => {
  it("propagates a non-ENOENT read error (verify-steps.packs.json is a directory) instead of silently returning no pack steps", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "verify-steps-eisdir-"));
    try {
      mkdirSync(join(scratch, "lib"), { recursive: true });
      copyFileSync(
        join(repoRoot, "templates", "core", "bin", "lib", "verify-steps.mjs"),
        join(scratch, "lib", "verify-steps.mjs"),
      );
      // A directory in place of the file reliably throws EISDIR on read,
      // cross-platform -- unlike simulating a permissions error, which is
      // not portable across CI runners.
      mkdirSync(join(scratch, "lib", "verify-steps.packs.json"));

      await expect(
        import(pathToFileURL(join(scratch, "lib", "verify-steps.mjs")).href),
      ).rejects.toBeTruthy();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
