// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Allowlist contract for `guard-readonly-bash.mjs`: Rule 1 (verb allowlist),
 * Rule 4 (command and process substitution) and Rule 5 (`node`).
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

describe("Rule 1 -- verbs off the allowlist block", () => {
  it.each([
    "awk '{print $1}' f",
    "python3 x.py",
    "ruby x.rb",
    "perl x.pl",
    "deno run x.ts",
    "gh pr list",
    "curl https://example.com",
    "wget https://example.com",
    "ln -s a b",
    "install a b",
    "patch -p1 < x.diff",
    "rsync -a a/ b/",
    "tar tf x.tar",
    "make test",
    "cargo build",
  ])("blocks %s with an allowlist reason", (command) => {
    const verdict = guard.classify(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/allowlist/);
  });

  it("blocks curl -o out.txt https://example.com", () => {
    expect(guard.classify("curl -o out.txt https://example.com").blocked).toBe(
      true,
    );
  });

  it("names the verb in the reason", () => {
    expect(guard.classify("rsync -a a/ b/").reason).toContain('"rsync"');
  });

  it.each(["bash script.sh", "sh", "zsh script.zsh", "sudo python3 x.py"])(
    "blocks %s (shell without -c, or prefix hiding an unlisted verb)",
    (command) => {
      expect(guard.classify(command).blocked).toBe(true);
    },
  );
});

describe("Rule 1 -- a verb built through expansion blocks", () => {
  it.each([
    "$X -rf x",
    "X=rm; $X -rf x",
    "r$(echo m) -rf x",
    "`echo rm` -rf x",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });
});

describe("Rule 1 -- allowlisted verbs stay allowed", () => {
  it.each([
    "cat f",
    "jq .a f",
    "[ -f x ]",
    "printf hi",
    "tree src",
    "tsc --noEmit",
    "git status",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
});

describe("Rule 4 -- command and process substitution", () => {
  it.each([
    "echo $(rm x)",
    "echo `rm x`",
    'echo "$(rm x)"',
    'echo "`rm x`"',
    "echo $(echo $(rm x))",
    "cat <(rm x)",
    "echo hi >(cat)",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it("names the substitution in the reason", () => {
    expect(guard.classify("echo $(rm x)").reason).toMatch(/substitution/i);
  });

  it.each(["echo $(date", "echo `date"])(
    "fails closed on unbalanced %s",
    (command) => {
      expect(guard.classify(command).blocked).toBe(true);
    },
  );

  it.each([
    "echo $(date)",
    "echo `date`",
    "echo '$(rm x)'",
    'git log --since="$(date -d yesterday)"',
    "cat <(ls)",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
});

describe("Rule 5 -- node", () => {
  it.each([
    'node -e "1"',
    "node --eval 1",
    "node -p 1",
    "node --print 1",
    "node -pe 1",
    "node -r x.js y.js",
    "node --import x.mjs y.mjs",
    "node -i",
    "node",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it.each(["node bin/check-harness.mjs", "node --test x.mjs"])(
    "allows %s",
    (command) => {
      expect(guard.classify(command).blocked).toBe(false);
    },
  );
});

describe("Amendment -- harmless shell builtins are on the allowlist", () => {
  it.each([
    "cd packages/cli && git diff",
    'while read l; do echo "$l"; done',
    "exit 0",
    ": > /dev/null",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });

  it("blocks : > out via the redirect rule, not the allowlist", () => {
    const verdict = guard.classify(": > out");
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).not.toMatch(/allowlist/);
  });

  it.each([
    "export X=1",
    "source f",
    ". f",
    "eval x",
    "exec x",
    "alias a=b",
    "unset X",
    "set -e",
  ])("blocks %s (a shell builtin that stays off the allowlist)", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });
});
