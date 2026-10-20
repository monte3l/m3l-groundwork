// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Hardening contract for `guard-readonly-bash.mjs`, group E: the git, sed and
 * find argument holes (`--output` everywhere, `ls-remote`, `grep -O`, `help`,
 * BSD `sed -I`, sed labels, `find -exec` with a non-executable first word).
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

const blocks = (rows: string[]): void => {
  it.each(rows)("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });
};

const allows = (rows: string[]): void => {
  it.each(rows)("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
};

describe("E1 -- --output on every git subcommand", () => {
  blocks([
    "git rev-list --output=x HEAD",
    "git rev-list --output x HEAD",
    "git shortlog --output=x HEAD",
    "git blame --output=x f",
    "git stash show --output=x",
    "git stash show -p --output x",
    "git log --outp=x",
    "git diff --output=x",
    "git whatchanged --output=x",
  ]);
  allows([
    "git diff --output-indicator-new=+",
    "git log --output-indicator-old=- -1",
    "git diff -- f --output=x",
    "git stash show -p",
    "git rev-list --count HEAD",
  ]);
});

describe("E2 -- git ls-remote execution flags", () => {
  blocks([
    'git ls-remote --upload-pack="touch pwn; git-upload-pack" .',
    "git ls-remote -u x .",
    "git ls-remote --exec=x .",
    "git ls-remote --upload-pa x .",
    "git ls-remote --ex=x .",
  ]);
  allows([
    "git ls-remote origin",
    "git ls-remote --heads origin",
    "git ls-remote --tags origin",
  ]);
});

describe("E3 -- git grep -O with digits in the cluster", () => {
  blocks(["git grep -5Ovim foo", "git grep -nOvim foo", "git grep -O foo"]);
  allows(["git grep -n -5 foo", "git grep -5 foo", "git grep -nI foo"]);
});

describe("E4 -- git help viewers", () => {
  blocks([
    "git help -w diff",
    "git help --web diff",
    "git help -i diff",
    "git help --info diff",
    "git help -m diff",
    "git help --man diff",
  ]);
  allows(["git help diff", "git help -a"]);
});

describe("E5 -- sed in-place (BSD -I) and label hazards", () => {
  blocks([
    "sed -I.bak s/a/b/ f",
    "sed -I '' s/a/b/ f",
    "sed -nI '' p f",
    "sed -nEI .bak p f",
    "sed 'b end w out' f",
    "sed ':a w x' f",
    "sed 't x w y' f",
    "sed -n ':a e' f",
  ]);
  allows([
    "sed ':a;N;$!ba;s/\\n/ /g' f",
    "sed -n '/x/{p;q}' f",
    "sed 's/a/b/' f",
  ]);

  it.each(['sed "/a"', "sed s", "sed y/a"])(
    "reports an unreadable script for %s without claiming a file write",
    (command) => {
      const verdict = guard.classify(command);
      expect(verdict.blocked).toBe(true);
      expect(verdict.reason).toMatch(/could not be read/);
      expect(verdict.reason).not.toContain("writes a file");
    },
  );
});

describe("E6 -- find -exec whose first word cannot be executed", () => {
  blocks([
    "find . -name '*.sh' -exec {} \\;",
    "find . -exec {} x \\;",
    "find . -exec fi rm \\;",
    "find . -exec done \\;",
    "find . -exec } \\;",
    "find . -execdir {} \\;",
    "find . -ok {} \\;",
    "find . -exec cat {} + -exec {} +",
  ]);
  allows([
    "find . -exec cat {} \\;",
    "find . -exec grep -l foo {} +",
    "find . -execdir cat {} \\;",
  ]);
});
