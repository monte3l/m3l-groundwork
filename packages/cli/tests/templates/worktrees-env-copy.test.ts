// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `working-in-worktrees` skill's `start` mode copies gitignored `.env`
 * files into a worktree it created by hand. The baseline denies `Read(./.env)`,
 * so the step must copy without reading, and must stop rather than work around
 * a denied copy. Files under `templates/**` are read as text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packFiles = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "worktrees",
  "files",
);
const skill = readFileSync(
  join(packFiles, ".claude", "skills", "working-in-worktrees", "SKILL.md"),
  "utf8",
);

const startStart = skill.indexOf("### start");
const startEnd = skill.indexOf("### status");
const startMode = skill.slice(startStart, startEnd);
const step =
  startMode.split(/^(?=\d+\. )/m).find((s) => s.includes(".worktreeinclude")) ??
  "";

describe("working-in-worktrees start: .env copy step", () => {
  it("is found inside the start mode", () => {
    expect(startStart).toBeGreaterThan(-1);
    expect(startEnd).toBeGreaterThan(startStart);
    expect(step).not.toBe("");
  });

  it("copies with cp -n so an existing file is never overwritten", () => {
    expect(step).toContain("cp -n");
  });

  it("says it never reads or prints the contents, and never uses cat", () => {
    expect(step).toMatch(/never (read|print|cat)/i);
    expect(step).not.toContain("cat .env");
    expect(step).not.toContain("cat <");
  });

  it("warns the baseline Read(./.env) deny rules may block the copy", () => {
    expect(step).toMatch(/permissions\.deny|deny/);
    expect(step).toContain(".env");
  });

  it("stops and asks the owner to copy when denied, never working around it", () => {
    expect(step).toMatch(/never work(s)? around/i);
    expect(step).toMatch(/owner/);
  });

  it("locates the main checkout with git worktree list --porcelain", () => {
    expect(step).toContain("git worktree list --porcelain");
  });

  it("distinguishes a missing file from a denial and copies from the main checkout", () => {
    expect(step).toContain("not a denial");
    expect(step).toContain("cp -n <main-checkout>/");
  });

  it.each([".env", ".env.local", ".env.*.local"])("still lists %s", (name) => {
    expect(step).toContain(`\`${name}\``);
  });

  it("keeps the .worktreeinclude comment saying the skill copies these by hand", () => {
    const include = readFileSync(join(packFiles, ".worktreeinclude"), "utf8");
    expect(include).toMatch(/copies these same files by hand/);
  });
});
