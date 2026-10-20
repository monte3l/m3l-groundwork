// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Hardening contract for `guard-readonly-bash.mjs` (fix contract groups A-D):
 * fail-closed classification, the `node` form, substitution holes and
 * argument guards on allowlisted verbs.
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

function expectBlocked(command: string, reason?: RegExp): void {
  const verdict = guard.classify(command);
  expect(verdict.blocked).toBe(true);
  if (reason !== undefined) expect(verdict.reason).toMatch(reason);
}

function expectAllowed(command: string): void {
  expect(guard.classify(command).blocked).toBe(false);
}

const deepNested =
  "$(".repeat(1900) + "true" + ")".repeat(1900) + "; rm -rf src";

describe("A4 -- opaque words fail closed", () => {
  it.each([
    "node $'-e' 'require(\"fs\").rmSync(\"src\")'",
    "find . $'-delete'",
    "sed $'-i' s/a/b/ f",
    "sort $'-o' out f",
    "git diff $'--output=out.txt'",
    "eslint $'--fix' .",
    "grep $'\\t' f",
  ])("blocks %s", (command) => {
    expectBlocked(command);
  });

  it("explains that the quoting could not be read", () => {
    expectBlocked("sort $'-o' out f", /quoting could not be read/);
  });
});

describe("A2/A3 -- depth and size caps", () => {
  it("blocks 1,900 nested substitutions without throwing", () => {
    expect(() => guard.classify(deepNested)).not.toThrow();
    expectBlocked(deepNested, /deeply/);
  });

  it("blocks 5,000 repeated npx wrappers without throwing", () => {
    const command = "npx ".repeat(5000) + "rm x";
    expect(() => guard.classify(command)).not.toThrow();
    expectBlocked(command);
  });

  it("blocks 3,000 nested process substitutions without throwing", () => {
    const command = "<(cat ".repeat(3000) + ")".repeat(3000) + "; rm x";
    expect(() => guard.classify(command)).not.toThrow();
    expectBlocked(command);
  });

  it("blocks a 70,000 character command as too long", () => {
    const command = "echo " + "a".repeat(70000);
    expect(() => guard.classify(command)).not.toThrow();
    expectBlocked(command, /too long/);
  });

  it("allows a harmless 60,000 character command", () => {
    const command = "echo " + "a".repeat(60000);
    expect(() => guard.classify(command)).not.toThrow();
    expectAllowed(command);
  });
});

describe("A1 -- entry point fails closed on a classifier crash", () => {
  const payload = (agentType: string) => ({
    agent_type: agentType,
    tool_input: { command: deepNested },
  });

  it("exits 2 with a Blocked message for a read-only spoke", () => {
    const run = guard.runHook(payload("code-reviewer"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Blocked");
  });

  it("exits 0 for a writer spoke, which is never restricted", () => {
    expect(guard.runHook(payload("code-implementer")).status).toBe(0);
  });
});

describe("B -- node only as `node [SAFE_FLAGS] <script> [args]`", () => {
  it.each([
    "node bin/check-harness.mjs",
    "node --test x.mjs",
    "node --no-warnings bin/x.mjs --flag",
    "node bin/x.mjs -e foo",
    "node --version",
    "node -v",
    "node --stack-trace-limit=50 bin/x.mjs",
  ])("allows %s", (command) => {
    expectAllowed(command);
  });

  it.each([
    'node <<<\'require("fs").rmSync("x")\'',
    'node -C dev -e "1"',
    'node --title t -e "1"',
    "node --run format",
    "node --run lint -- --fix",
    "NODE_OPTIONS=--import=./x.mjs node bin/check-harness.mjs",
    "node --import ./x.mjs bin/a.mjs",
    "node --version x",
    "node -v extra",
    "node --loader x bin/a.mjs",
    "node -p 1",
    "node",
    "node <script.mjs",
  ])("blocks %s", (command) => {
    expectBlocked(command);
  });

  it("names the flag that is not on the allowlist", () => {
    expectBlocked("node --import ./x.mjs bin/a.mjs", /--import/);
  });
});

describe("C1 -- nested backticks", () => {
  it("blocks an escaped nested backtick body", () => {
    expectBlocked("echo `echo \\`rm -rf x\\``");
  });

  it.each(["echo `date`", 'echo "`date`"'])("allows %s", (command) => {
    expectAllowed(command);
  });
});

describe("C2 -- comments", () => {
  it("blocks a substitution on the line after a comment with an apostrophe", () => {
    expectBlocked("echo hi # don't\necho $(rm y)");
  });

  it.each(["echo a#b", 'echo "x # y"', "grep '#' f", "echo hi # a comment"])(
    "allows %s",
    (command) => {
      expectAllowed(command);
    },
  );
});

describe("C3 -- here-documents and here-strings", () => {
  it("blocks a here-doc whose body hides a substitution", () => {
    expectBlocked("cat <<true\necho '$(rm x)'\ntrue");
  });

  it.each(["cat <<EOF\nhello\nEOF", 'grep x <<<"$v"'])(
    "blocks %s with a here-document reason",
    (command) => {
      expectBlocked(command, /here-document/);
    },
  );

  it.each(['echo "<<"', "echo '<<<'"])("allows quoted %s", (command) => {
    expectAllowed(command);
  });
});

describe("C4 -- arithmetic expansion", () => {
  it.each(['echo "$((rm x)|(cat))"', "echo $(( $(rm x) ))"])(
    "blocks %s",
    (command) => {
      expectBlocked(command);
    },
  );

  it.each(["echo $((1+2))", "echo $((a + b))", "echo $(( $(date +%s) + 1 ))"])(
    "allows %s",
    (command) => {
      expectAllowed(command);
    },
  );
});

describe("D -- argument guards on allowlisted verbs", () => {
  it.each([
    "rg --pre rm x .",
    "rg --pre=rm x .",
    "rg --pre-glob '*.x' x .",
    "rg --hostname-bin x y .",
    "tree -o out.txt",
    "tree -do out.txt",
    "tree --output out.txt",
    "eslint -o out.txt .",
    "eslint --output-file out.txt .",
    "eslint --output-file=out.txt .",
    "eslint --init",
    "knip --fix",
    "knip --fix-type x",
    "file -C -m m",
    "file --compile",
    "vitest -u",
    "vitest --update",
    "tsc",
    "tsc src/x.ts",
    "tsc --outFile x",
    "tsc --init",
    "date -s x",
    "date --set x",
    "hostname",
    "hostname x",
  ])("blocks %s", (command) => {
    expectBlocked(command);
  });

  it.each([
    "rg -n foo",
    "rg -o foo",
    "tree -L 2",
    "eslint .",
    "eslint --format json .",
    "knip",
    "file x",
    "file -b x",
    "vitest run",
    "vitest run --coverage",
    "tsc --noEmit",
    "tsc -b",
    "tsc --build --force",
    "date",
    "date +%s",
  ])("allows %s", (command) => {
    expectAllowed(command);
  });
});
