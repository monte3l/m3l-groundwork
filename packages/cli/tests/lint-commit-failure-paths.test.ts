// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Failure-path contract of bin/lint-commit.mjs and its behavioural twin in
 * templates/core: ANY failure prints only `✗`-prefixed lines to stderr,
 * nothing to stdout, never a stack trace, and exits with code exactly 1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const targets = [
  {
    name: "root",
    cwd: repoRoot,
    script: join(repoRoot, "bin", "lint-commit.mjs"),
  },
  {
    name: "twin",
    cwd: join(repoRoot, "templates", "core"),
    script: join(repoRoot, "templates", "core", "bin", "lint-commit.mjs"),
  },
];

const SIGNED = "feat: add y\n\nSigned-off-by: A Dev <a@example.com>\n";
// eslint-disable-next-line no-control-regex -- strips ANSI SGR colour codes
const ANSI = /\u001B\[[0-9;]*m/g;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cwd: string, script: string, args: string[]): Run {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr.replace(ANSI, ""),
  };
}

function expectCleanFailure(r: Run, mention: string): void {
  expect(r.status).toBe(1);
  expect(r.stdout).toBe("");
  const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.startsWith("✗")).toBe(true);
  }
  expect(r.stderr).not.toMatch(/^\s+at /m);
  expect(r.stderr).not.toContain("node:internal");
  expect(r.stderr).toContain(mention);
}

describe.each(targets)("lint-commit failure paths ($name)", (t) => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lint-commit-fail-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function msgFile(text: string): string {
    const file = join(dir, "COMMIT_EDITMSG");
    writeFileSync(file, text);
    return file;
  }

  it("fails cleanly when cwd has no commitlint.config.js", () => {
    expectCleanFailure(
      run(dir, t.script, ["--edit", msgFile(SIGNED)]),
      "commitlint.config.js",
    );
  });

  it("fails cleanly when commitlint.config.js has a syntax error", () => {
    writeFileSync(join(dir, "commitlint.config.js"), "const = {{ rules: ;\n");
    expectCleanFailure(
      run(dir, t.script, ["--edit", msgFile(SIGNED)]),
      "commitlint.config.js",
    );
  });

  it("fails cleanly when --edit points at a missing file", () => {
    expectCleanFailure(
      run(t.cwd, t.script, ["--edit", join(dir, "does-not-exist")]),
      "could not read the commit message file",
    );
  });

  it("fails cleanly when --edit is the last argument with no value", () => {
    expectCleanFailure(run(t.cwd, t.script, ["--edit"]), "--edit needs a path");
  });

  it("prints a forbidden Claude trailer failure as a leading-cross line", () => {
    const text = `feat: add y\n\nClaude-Model: x\nSigned-off-by: A Dev <a@example.com>\n`;
    expectCleanFailure(
      run(t.cwd, t.script, ["--edit", msgFile(text)]),
      "forbidden Claude-*",
    );
  });

  it.each([
    ["export default {};", "empty object"],
    ["export default { extends: [] };", "empty extends"],
  ])("rejects a config with no rules (%s) instead of passing", (config) => {
    writeFileSync(join(dir, "commitlint.config.js"), config + "\n");
    const r = run(dir, t.script, ["bad message"]);
    expectCleanFailure(r, "no rules");
    expect(r.stdout).not.toContain("✓");
  });

  it("blames the broken rule name, not git, when a rule is unknown", () => {
    writeFileSync(
      join(dir, "commitlint.config.js"),
      'export default { rules: { "no-such-rule": [2, "always"] } };\n',
    );
    const r = run(dir, t.script, ["bad message"]);
    expectCleanFailure(r, "no-such-rule");
    expect(r.stderr).not.toContain("git on PATH");
  });

  it("positive control: valid config and signed message exits 0", () => {
    const r = run(t.cwd, t.script, ["--edit", msgFile(SIGNED)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "✓ commit message is a valid Conventional Commit",
    );
    expect(r.stderr).toBe("");
  });
});
