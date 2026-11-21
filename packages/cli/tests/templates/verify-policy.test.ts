// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Contract: `templates/core/bin/lib/verify-policy.json` is a plain-JSON policy
 * (`{"version":1,"testsBlocking":true,"ciSkipGroups":[]}`) read by the emitted
 * `bin/verify.mjs` (through `bin/lib/verify-steps.mjs`). `testsBlocking:false`
 * downgrades a failing `test`-group step to a warning; `ciSkipGroups` (only
 * "test" is allowed) skips that group when `CI` is truthy. A missing file means the defaults; a
 * present-but-malformed one is a hard failure naming `verify-policy.json`.
 *
 * The REAL emitted bin/ is copied into a sandbox and run with a stub `pnpm`
 * first on PATH (exit code driven by FAKE_PNPM_FAIL), so no real pnpm command
 * runs. Only pnpm-only groups (`format`, `test`) are run individually, so no
 * `node bin/check-*.mjs` step executes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = join(here, "..", "..", "..", "..", "templates", "core");
const policyPath = join(coreDir, "bin", "lib", "verify-policy.json");

const DEFAULTS = { version: 1, testsBlocking: true, ciSkipGroups: [] };
const ALL_GROUPS = ["format", "lint", "typecheck", "build", "test"];
const NON_TEST_GROUPS = ["format", "lint", "typecheck", "build"];

// Stub pnpm: prints its argv; exits 1 when argv[0] equals FAKE_PNPM_FAIL.
const PNPM_STUB = `#!/usr/bin/env node
console.log("PNPM_RAN " + process.argv.slice(2).join(" "));
if (process.argv[2] === process.env.FAKE_PNPM_FAIL) {
  if (process.env.FAKE_PNPM_SIGNAL) process.kill(process.pid, process.env.FAKE_PNPM_SIGNAL);
  process.exit(1);
}
process.exit(0);
`;

let sandbox = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "verify-policy-"));
  cpSync(join(coreDir, "bin"), join(sandbox, "bin"), { recursive: true });
  mkdirSync(join(sandbox, "stub"));
  writeFileSync(join(sandbox, "stub", "pnpm"), PNPM_STUB);
  chmodSync(join(sandbox, "stub", "pnpm"), 0o755);
  // Start from "no policy file" in every test; each test opts in.
  rmSync(join(sandbox, "bin", "lib", "verify-policy.json"), { force: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function writePolicy(policy: unknown): void {
  writeFileSync(
    join(sandbox, "bin", "lib", "verify-policy.json"),
    typeof policy === "string" ? policy : JSON.stringify(policy),
  );
}

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; out: string; err: string } {
  const base = { ...process.env };
  delete base["CI"];
  delete base["FAKE_PNPM_FAIL"];
  delete base["FAKE_PNPM_SIGNAL"];
  const result = spawnSync(
    process.execPath,
    [join(sandbox, "bin", "verify.mjs"), ...args],
    {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...base,
        PATH: `${join(sandbox, "stub")}${delimiter}${process.env["PATH"] ?? ""}`,
        ...env,
      },
    },
  );
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("shipped verify-policy.json", () => {
  it("exists, parses, and equals the defaults", () => {
    expect(existsSync(policyPath)).toBe(true);
    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual(DEFAULTS);
  });

  it.each(["check-harness.mjs", "check-toolchain.mjs"])(
    "%s still passes against templates/core with the file present",
    (script) => {
      expect(existsSync(policyPath)).toBe(true);
      const result = spawnSync("node", [join(coreDir, "bin", script)], {
        cwd: coreDir,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    },
  );
});

describe("missing policy file", () => {
  it("behaves as the defaults: a failing test step fails the run", () => {
    const r = run(["--group", "test"], { FAKE_PNPM_FAIL: "test:coverage" });
    expect(r.status).toBe(1);
  });

  it("behaves as the defaults: CI does not skip any group", () => {
    const r = run(["--group", "format"], { CI: "true" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("PNPM_RAN format:check");
  });
});

describe("testsBlocking", () => {
  it("true: a failing test-group step fails the group run", () => {
    writePolicy(DEFAULTS);
    const r = run(["--group", "test"], { FAKE_PNPM_FAIL: "test:coverage" });
    expect(r.status).toBe(1);
  });

  it("false: a failing test-group step warns and exits 0", () => {
    writePolicy({ ...DEFAULTS, testsBlocking: false });
    const r = run(["--group", "test"], { FAKE_PNPM_FAIL: "test:coverage" });
    expect(r.out).toContain("PNPM_RAN test:coverage");
    expect(r.status).toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/warn/i);
  });

  it("false: --step test is still warn-only", () => {
    writePolicy({ ...DEFAULTS, testsBlocking: false });
    const r = run(["--step", "test"], { FAKE_PNPM_FAIL: "test:coverage" });
    expect(r.status).toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/warn/i);
  });

  it("false: a failing step in another group still fails", () => {
    writePolicy({ ...DEFAULTS, testsBlocking: false });
    const r = run(["--group", "format"], { FAKE_PNPM_FAIL: "format:check" });
    expect(r.status).toBe(1);
  });

  it("false: prints a final warning-only summary with the downgraded count", () => {
    writePolicy({ ...DEFAULTS, testsBlocking: false });
    const r = run(["--group", "test"], { FAKE_PNPM_FAIL: "test:coverage" });
    expect(r.status).toBe(0);
    const lines = `${r.out}\n${r.err}`
      .split("\n")
      .filter((line) => /warning only/i.test(line));
    expect(lines.some((line) => /\b1\b/.test(line))).toBe(true);
  });

  it("false: a test step that cannot be spawned still fails, naming the reason", () => {
    writePolicy({ ...DEFAULTS, testsBlocking: false });
    const emptyBin = join(sandbox, "empty-bin");
    mkdirSync(emptyBin);
    const r = run(["--group", "test"], { PATH: emptyBin });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/ENOENT|not found|spawn/i);
  });

  it.each(["SIGKILL", "SIGTERM"])(
    "false: a test step killed by %s still fails, naming the signal",
    (signal) => {
      writePolicy({ ...DEFAULTS, testsBlocking: false });
      const r = run(["--group", "test"], {
        FAKE_PNPM_FAIL: "test:coverage",
        FAKE_PNPM_SIGNAL: signal,
      });
      expect(r.status).toBe(1);
      expect(r.err).toContain(`killed by ${signal}`);
    },
  );

  it("false: a passing test step is not reported as a warning", () => {
    writePolicy({ ...DEFAULTS, testsBlocking: false });
    const r = run(["--group", "test"]);
    expect(r.status).toBe(0);
    expect(`${r.out}${r.err}`).not.toMatch(/warn/i);
    expect(`${r.out}${r.err}`).not.toMatch(/warning only/i);
  });
});

describe("ciSkipGroups", () => {
  it("skips the group with a notice and succeeds when CI is truthy", () => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test"] });
    const r = run(["--group", "test"], {
      CI: "true",
      FAKE_PNPM_FAIL: "test:coverage",
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("PNPM_RAN");
    expect(`${r.out}${r.err}`).toMatch(/skip/i);
  });

  it("still runs the group locally (CI unset)", () => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test"] });
    const r = run(["--group", "test"], { FAKE_PNPM_FAIL: "test:coverage" });
    expect(r.out).toContain("PNPM_RAN test:coverage");
    expect(r.status).toBe(1);
  });

  it.each(["", "false", "0"])("treats CI=%j as not in CI", (ci) => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test"] });
    const r = run(["--group", "test"], { CI: ci });
    expect(r.out).toContain("PNPM_RAN test:coverage");
  });

  it.each(["true", "1", "yes"])("treats CI=%j as in CI", (ci) => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test"] });
    const r = run(["--group", "test"], { CI: ci });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("PNPM_RAN");
  });

  it("does not skip a group that is not listed", () => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: [] });
    const r = run(["--group", "test"], { CI: "true" });
    expect(r.out).toContain("PNPM_RAN test:coverage");
  });

  it("--step is unaffected by ciSkipGroups", () => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test"] });
    const r = run(["--step", "test"], {
      CI: "true",
      FAKE_PNPM_FAIL: "test:coverage",
    });
    expect(r.out).toContain("PNPM_RAN test:coverage");
    expect(r.status).toBe(1);
  });

  it("--step still honours testsBlocking under CI skip of the test group", () => {
    writePolicy({ testsBlocking: false, version: 1, ciSkipGroups: ["test"] });
    const r = run(["--step", "test"], {
      CI: "true",
      FAKE_PNPM_FAIL: "test:coverage",
    });
    expect(r.out).toContain("PNPM_RAN test:coverage");
    expect(r.status).toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/warn/i);
  });

  it("duplicate entries are harmless", () => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test", "test"] });
    const r = run(["--group", "test"], {
      CI: "true",
      FAKE_PNPM_FAIL: "test:coverage",
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("PNPM_RAN");
  });

  it("does not skip the format group when only test is listed", () => {
    writePolicy({ ...DEFAULTS, ciSkipGroups: ["test"] });
    const r = run(["--group", "format"], { CI: "true" });
    expect(r.out).toContain("PNPM_RAN format:check");
  });
});

describe("malformed policy is a hard failure naming verify-policy.json", () => {
  const cases: [string, unknown][] = [
    ["invalid JSON", "{ not json"],
    ["a JSON array", []],
    ["null", "null"],
    ["version 2", { ...DEFAULTS, version: 2 }],
    ["missing version", { testsBlocking: true, ciSkipGroups: [] }],
    ["testsBlocking not boolean", { ...DEFAULTS, testsBlocking: "no" }],
    ["ciSkipGroups not an array", { ...DEFAULTS, ciSkipGroups: "test" }],
    [
      "ciSkipGroups with unknown group",
      { ...DEFAULTS, ciSkipGroups: ["nope"] },
    ],
    ["ciSkipGroups with non-string", { ...DEFAULTS, ciSkipGroups: [1] }],
    ["unknown extra key", { ...DEFAULTS, extra: true }],
    [
      "ciSkipGroups listing all five groups",
      { ...DEFAULTS, ciSkipGroups: ALL_GROUPS },
    ],
    ["a constructor key", { ...DEFAULTS, constructor: {} }],
    [
      "a __proto__ key",
      '{"version":1,"testsBlocking":true,"ciSkipGroups":[],"__proto__":{}}',
    ],
    ...NON_TEST_GROUPS.map((group): [string, unknown] => [
      `ciSkipGroups with the ${group} group`,
      { ...DEFAULTS, ciSkipGroups: [group] },
    ]),
  ];

  it.each(cases)("%s", (_name, policy) => {
    writePolicy(policy);
    const r = run(["--group", "format"]);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("PNPM_RAN");
    expect(r.err).toContain("verify-policy.json");
  });

  it("reports the version problem before an unknown key", () => {
    writePolicy({ ...DEFAULTS, version: 2, extra: true });
    const r = run(["--group", "format"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("verify-policy.json");
    expect(r.err).toMatch(/version/i);
    expect(r.err).not.toMatch(/extra/);
  });

  it("is also fatal when running a single step", () => {
    writePolicy("{ not json");
    const r = run(["--step", "format"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("verify-policy.json");
  });
});
