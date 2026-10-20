// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Allowlist contract for `guard-readonly-bash.mjs`: Rule 2 (the git
 * subcommand allowlist and the git flag guards).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGuard, type LoadedGuard } from "./guard-readonly-bash-loader.js";

let guard: LoadedGuard;

beforeAll(async () => {
  guard = await loadGuard();
});

afterAll(() => {
  guard.cleanup();
});

describe("Rule 2 -- allowed git forms stay allowed", () => {
  it.each([
    "git status",
    "git diff main..HEAD --stat",
    "git log --oneline -5",
    "git show HEAD:README.md",
    "git blame f",
    "git rev-parse HEAD",
    "git ls-files",
    "git grep -n foo",
    "git branch --show-current",
    "git tag -l",
    "git config --get user.name",
    "git worktree list",
    "git stash list",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git submodule status",
    "git ls-remote origin",
    "git version",
    "git --no-pager log -3",
    "git -C sub status",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
});

describe("Rule 2 -- git write flags block", () => {
  it.each([
    "git diff --output=out.txt",
    "git diff --output out.txt",
    "git log --output=out.txt",
    "git show --output=x HEAD",
    "git archive -o out.tar HEAD",
    "git submodule update",
    "git grep -O foo",
    "git grep -Oless foo",
    "git grep --open-files-in-pager foo",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });
});

describe("Rule 2 -- git subcommands off the allowlist block", () => {
  it.each([
    "git fetch",
    "git archive HEAD",
    "git notes add x",
    "git bisect start",
    "git update-ref HEAD x",
    "git format-patch HEAD~1",
    "git bundle create x HEAD",
    "git init",
    "git clone x y",
    "git filter-branch",
    "git difftool",
    "git mergetool",
    "git frobnicate",
    "git",
    "git remote add x y",
    "git remote remove x",
    "git submodule add x y",
    "git submodule init",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it("names an unknown subcommand, quoted, in the reason", () => {
    const verdict = guard.classify("git frobnicate");
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/["'`]frobnicate["'`]/);
  });
});

describe("Rule 2 -- existing git blocks are kept", () => {
  it.each([
    "git commit -m x",
    "git push",
    "git checkout main",
    "git reset --hard",
    "git branch newb",
    "git tag v1",
    "git stash",
    "git config user.name x",
    "git -c core.pager=evil log",
    "GIT_PAGER=evil git log",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });
});

describe("git --output position, whatchanged, grep -O, remote and submodule", () => {
  it.each([
    "git diff main --output=x",
    "git whatchanged --output=x",
    "git diff-tree --output=x HEAD",
    "git grep -n -O foo",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it("allows git diff -- f --output=x (after a bare -- it is a path)", () => {
    expect(guard.classify("git diff -- f --output=x").blocked).toBe(false);
  });

  it.each(["git remote", "git submodule status"])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });

  it("names the allowlist when blocking git remote add x y", () => {
    const verdict = guard.classify("git remote add x y");
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/allowlist/);
  });
});
