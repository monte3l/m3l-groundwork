// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for `.claude/hooks/guard-hub-src-writes.mjs` (and its emitted
 * `templates/core` twin) guarding the Bash tool in addition to Write/Edit: a
 * hub-authored Bash command that writes into a guarded `src/`/`tests/` path
 * is blocked the same way a raw Write/Edit already is. Exercises the two
 * exports this adds (`findBashWriteToProtectedPath`,
 * `shouldBlockHubBashWrite`), the Bash entry-point branch, and the
 * `settings.json` `Bash`-matcher registration.
 *
 * Covers, in order: the pure path-finding function across redirect / tee /
 * sed-perl-in-place / cp-mv-family / patch-apply / interpreter / wrapper
 * command shapes (both MUST-BLOCK and MUST-ALLOW tables), the
 * `shouldBlockHubBashWrite` writer-spoke carve-out, the subprocess entry
 * point for both the root hook and the `templates/core` emitted twin, and a
 * `settings.json` wiring + source-parity drift guard.
 *
 * `NODE_LOAD_FS_CALL` below reconstructs, via runtime concatenation, the
 * legacy Node module-loading call a couple of fixture commands legitimately
 * need to represent (`node -e "<that call>('fs')..."`, standing in for a
 * one-liner a hub might run). Writing that exact token sequence whole trips
 * this repo's own `guard-no-commonjs.mjs` -- a Write/Edit PreToolUse guard
 * that scans raw file TEXT for it (and similar legacy-module tokens)
 * regardless of whether it appears inside a test fixture string or a
 * comment, since this project's own source is ESM-only. Same rationale as
 * `.claude/rules/tests.md`'s guidance for a secret-shaped fixture: assemble
 * the guard-triggering shape at runtime from two substrings rather than
 * writing it whole in source.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const hookPath = join(repoRoot, ".claude", "hooks", "guard-hub-src-writes.mjs");
const corePath = join(
  repoRoot,
  "templates",
  "core",
  ".claude",
  "hooks",
  "guard-hub-src-writes.mjs",
);

const NODE_LOAD_FS_CALL = "requi" + "re(";

interface BashWriteResult {
  path: string;
  rule: string;
}

type ReadFile = (absPath: string) => string | undefined;

interface FindOpts {
  cwd: string;
  projectDir: string;
  readFile?: ReadFile;
  notes?: Set<string>;
}

interface Hook {
  shouldBlockHubSrcWrite: (
    filePath: string | undefined,
    agentType: unknown,
    projectDir?: string,
  ) => boolean;
  findBashWriteToProtectedPath: (
    command: string,
    opts: FindOpts,
  ) => BashWriteResult | null;
  shouldBlockHubBashWrite: (
    command: string,
    agentType: unknown,
    opts: FindOpts,
  ) => BashWriteResult | null;
}

// Plain ESM under .claude/hooks/, outside every tsconfig -- loaded by URL,
// same pattern as guard-hub-src-writes.test.ts.
const hook = (await import(pathToFileURL(hookPath).href)) as Hook;

const PROJECT_DIR = "/proj";

function fakeReader(map: Record<string, string>): ReadFile {
  return (absPath: string) => map[absPath];
}

function find(
  command: string,
  opts: Partial<FindOpts> = {},
): BashWriteResult | null {
  return hook.findBashWriteToProtectedPath(command, {
    cwd: opts.cwd ?? PROJECT_DIR,
    projectDir: opts.projectDir ?? PROJECT_DIR,
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
  });
}

function expectBlocked(
  command: string,
  keyword: string,
  opts: Partial<FindOpts> = {},
): void {
  const result = find(command, opts);
  expect(result).not.toBeNull();
  expect(result?.path).toBeTruthy();
  expect(result?.rule).toBeTruthy();
  expect(result?.rule).toContain(keyword);
}

function expectAllowed(command: string, opts: Partial<FindOpts> = {}): void {
  expect(find(command, opts)).toBeNull();
}

it("findBashWriteToProtectedPath returns a path+rule object or null (type contract)", () => {
  expectTypeOf<
    ReturnType<Hook["findBashWriteToProtectedPath"]>
  >().toEqualTypeOf<BashWriteResult | null>();
});

const diffBody = [
  "diff --git a/packages/cli/src/a.ts b/packages/cli/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/packages/cli/src/a.ts",
  "+++ b/packages/cli/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const diffBodyPlusOnly = [
  "--- a/x",
  "+++ b/packages/cli/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const commitWithHeredocMessage = [
  "git commit -m \"$(cat <<'EOF'",
  "fix: sed -i packages/cli/src/a.ts",
  "EOF",
  ')"',
].join("\n");

/**
 * Builds the TEXT of `bash -c "<body, escaped>"`. Double-quote escaping
 * here follows the same subset the hook's own lexer decodes (`\$`, `` \` ``,
 * `\"`, `\\`, and an escaped trailing newline) -- the same rule POSIX double
 * quotes use for those characters -- so nesting this function N times
 * produces a command string that decodes back down through N re-lexed
 * layers to the original `body`.
 */
function wrapBashC(body: string): string {
  const escaped = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `bash -c "${escaped}"`;
}

/**
 * Four `bash -c` layers around a real write -- one past the hook's own
 * nesting cap (`MAX_DEPTH = 3`), so the innermost write is never reached and
 * the detector must give up (returning null) rather than silently allow
 * without saying why.
 */
const NESTED_PAST_DEPTH_CAP = (() => {
  let body = "echo x > packages/cli/src/a.ts";
  for (let i = 0; i < 4; i++) body = wrapBashC(body);
  return body;
})();

/**
 * A `writeFileSync(...)` call whose argument list is well past
 * `MAX_CALL_CHARS` (1000) -- `splitArgs` gives up on a call this long
 * (`closeAt - openAt > MAX_CALL_CHARS`), so the detector must still fail
 * open (allow) rather than throw or hang, but it must say so: a long call
 * silently skipped with no trace is the gap `GAP 5` below closes.
 */
const LONG_CALL_COMMAND = `node -e "${NODE_LOAD_FS_CALL}'fs').writeFileSync('packages/cli/src/a.ts', '${"x".repeat(1200)}')"`;
/** Same shape, short enough to analyse -- must still be blocked either way. */
const SHORT_CALL_COMMAND = `node -e "${NODE_LOAD_FS_CALL}'fs').writeFileSync('packages/cli/src/a.ts', 'x')"`;

describe("findBashWriteToProtectedPath -- MUST BLOCK for a hub caller", () => {
  const BLOCKED_SIMPLE: [string, string, string][] = [
    // redirects
    ["> redirect", "echo x > packages/cli/src/a.ts", "redirect"],
    [">> append redirect", "echo x >> packages/cli/src/a.ts", "redirect"],
    [">| clobber redirect", "echo x >| packages/cli/src/a.ts", "redirect"],
    ["&> redirect", "echo x &> packages/cli/src/a.ts", "redirect"],
    ["2> redirect", "echo x 2> packages/cli/src/a.ts", "redirect"],
    ["no-space redirect", "echo x >packages/cli/src/a.ts", "redirect"],
    ["quoted redirect target", 'echo x > "packages/cli/src/a.ts"', "redirect"],
    [
      "heredoc output redirected to a tests path",
      ["cat <<EOF > packages/cli/tests/a.test.ts", "body", "EOF"].join("\n"),
      "redirect",
    ],
    [
      "cat with trailing heredoc body, redirect before it",
      ["cat > packages/cli/tests/a.test.ts <<'EOF'", "body", "EOF"].join("\n"),
      "redirect",
    ],
    [
      "<<- heredoc with output redirect",
      ["cat <<-EOF > packages/cli/tests/a.test.ts", "body", "EOF"].join("\n"),
      "redirect",
    ],
    ["after &&", "ls && echo x > packages/cli/src/a.ts", "redirect"],
    ["after ;", "ls; echo x > packages/cli/src/a.ts", "redirect"],
    ["after |", "ls | echo x > packages/cli/src/a.ts", "redirect"],
    [
      "after newline",
      ["ls", "echo x > packages/cli/src/a.ts"].join("\n"),
      "redirect",
    ],
    ["after ||", "ls || echo x > packages/cli/src/a.ts", "redirect"],
    ["inside a subshell", "( echo x > packages/cli/src/a.ts )", "redirect"],
    ["flat layout src redirect", "echo x > src/a.ts", "redirect"],
    ["flat layout tests redirect", "> tests/a.test.ts", "redirect"],

    // tee
    ["tee", "tee packages/cli/src/a.ts", "tee"],
    ["tee -a", "tee -a packages/cli/src/a.ts", "tee"],
    [
      "tee piped and discarded",
      "echo x | tee packages/cli/src/a.ts >/dev/null",
      "tee",
    ],

    // sed / perl in-place
    ["sed -i", "sed -i 's/a/b/' packages/cli/src/a.ts", "sed"],
    ["sed -i.bak", "sed -i.bak 's/a/b/' packages/cli/src/a.ts", "sed"],
    ["sed -ni", "sed -ni 's/a/b/p' packages/cli/src/a.ts", "sed"],
    [
      "sed --in-place=.bak",
      "sed --in-place=.bak 's/a/b/' packages/cli/src/a.ts",
      "sed",
    ],
    [
      "sed -i with multiple -e scripts",
      "sed -i -e 's/a/b/' -e 's/c/d/' packages/cli/src/a.ts",
      "sed",
    ],
    ["perl -pi -e", "perl -pi -e 's/a/b/' packages/cli/src/a.ts", "perl"],
    [
      "perl -i.bak -pe",
      "perl -i.bak -pe 's/a/b/' packages/cli/src/a.ts",
      "perl",
    ],

    // cp/mv/install/rsync/ln/rm family
    ["cp into src", "cp x packages/cli/src/a.ts", "cp"],
    ["cp -r directory into src", "cp -r a/ packages/cli/src/", "cp"],
    ["cp -t target dir", "cp -t packages/cli/src a b", "cp"],
    ["mv into tests", "mv /tmp/x packages/cli/tests/a.ts", "mv"],
    ["mv FROM src also counts", "mv packages/cli/src/a.ts /tmp/", "mv"],
    ["install into src", "install -m644 x packages/cli/src/a.ts", "install"],
    ["rsync into src", "rsync -a gen/ packages/cli/src/", "rsync"],
    ["ln -s into src", "ln -s ../x packages/cli/src/link.ts", "ln"],
    ["rm a src file", "rm packages/cli/src/a.ts", "rm"],
    ["rm -rf a tests dir", "rm -rf packages/cli/tests/fixtures", "rm"],
    ["unlink a src file", "unlink packages/cli/src/a.ts", "unlink"],
    ["touch a src file", "touch packages/cli/src/a.ts", "touch"],
    ["truncate a src file", "truncate -s 0 packages/cli/src/a.ts", "truncate"],
    ["dd into src", "dd if=/tmp/x of=packages/cli/src/a.ts", "dd"],

    // patch apply
    [
      "patch with an explicit protected-path argument",
      "patch packages/cli/src/a.ts < p.diff",
      "patch",
    ],
    [
      "git apply via stdin heredoc with a +++ b/ header",
      ["git apply <<'EOF'", diffBodyPlusOnly.trimEnd(), "EOF"].join("\n"),
      "patch",
    ],
    [
      "git apply via stdin heredoc with a diff --git header",
      ["git apply <<'EOF'", diffBody.trimEnd(), "EOF"].join("\n"),
      "patch",
    ],

    // interpreters
    [
      "python3 -c inline write",
      "python3 -c \"open('packages/cli/src/a.ts','w').write('x')\"",
      "python",
    ],
    [
      "node -e inline writeFileSync",
      `node -e "${NODE_LOAD_FS_CALL}'fs').writeFileSync('packages/cli/src/a.ts','x')"`,
      "node",
    ],
    [
      "node --input-type=module -e inline write",
      "node --input-type=module -e \"import {writeFileSync} from 'fs'; writeFileSync('packages/cli/src/a.ts','x')\"",
      "node",
    ],
    [
      "perl -e inline open for write",
      "perl -e 'open(F,\">packages/cli/src/a.ts\")'",
      "perl",
    ],
    [
      "ruby -e inline write",
      "ruby -e \"File.write('packages/cli/src/a.ts','x')\"",
      "ruby",
    ],
    [
      "python3 reading a stdin heredoc that writes to a protected path",
      [
        "python3 - <<'EOF'",
        "from pathlib import Path",
        "Path('packages/cli/src/a.ts').write_text('x')",
        "EOF",
      ].join("\n"),
      "python",
    ],
    [
      "node reading a stdin heredoc that writes to a protected path",
      [
        "node - <<'EOF'",
        `const fs = ${NODE_LOAD_FS_CALL}'fs');`,
        "fs.writeFileSync('packages/cli/tests/a.ts', 'x');",
        "EOF",
      ].join("\n"),
      "node",
    ],

    // wrappers
    [
      "bash -c wraps a redirect write",
      'bash -c "echo x > packages/cli/src/a.ts"',
      "redirect",
    ],
    [
      "sh -c wraps a redirect write",
      "sh -c 'echo x > packages/cli/src/a.ts'",
      "redirect",
    ],
    [
      "eval wraps a redirect write",
      'eval "echo x > packages/cli/src/a.ts"',
      "redirect",
    ],
    ["sudo prefixes tee", "sudo tee packages/cli/src/a.ts", "tee"],
    [
      "env assignment prefixes sed -i",
      "env FOO=1 sed -i 's/a/b/' packages/cli/src/a.ts",
      "sed",
    ],
    ["nohup prefixes cp", "nohup cp x packages/cli/src/a.ts", "cp"],
    ["time prefixes cp", "time cp x packages/cli/src/a.ts", "cp"],
    ["command prefixes tee", "command tee packages/cli/src/a.ts", "tee"],
    [
      "leading env assignment before cp (no env keyword)",
      "FOO=1 cp x packages/cli/src/a.ts",
      "cp",
    ],
  ];

  it.each(BLOCKED_SIMPLE)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  interface SpecialBlockedCase {
    name: string;
    command: string;
    keyword: string;
    opts?: Partial<FindOpts>;
  }

  const SPECIAL_BLOCKED: SpecialBlockedCase[] = [
    {
      name: "absolute path inside projectDir",
      command: "echo x > /proj/packages/cli/src/a.ts",
      keyword: "redirect",
    },
    {
      name: "absolute path inside a worktree under projectDir",
      command: "echo x > /proj/.claude/worktrees/w1/packages/cli/src/a.ts",
      keyword: "redirect",
    },
    {
      name: "relative path resolved against a worktree cwd",
      command: "echo x > packages/cli/src/a.ts",
      keyword: "redirect",
      opts: { cwd: "/proj/.claude/worktrees/w1" },
    },
    {
      name: "cd into a package dir before a relative redirect",
      command: "cd packages/cli && echo x > src/a.ts",
      keyword: "redirect",
    },
    {
      name: "cd elsewhere before an absolute cp back into the project",
      command: "cd /tmp && cp x /proj/packages/cli/src/a.ts",
      keyword: "cp",
    },
    {
      name: "external script file (outside projectDir) that both writes and names a protected path",
      command: "node /tmp/gen.mjs",
      keyword: "node",
      opts: {
        readFile: fakeReader({
          "/tmp/gen.mjs":
            "import { writeFileSync } from 'node:fs';\nwriteFileSync('packages/cli/src/a.ts', 'x');\n",
        }),
      },
    },
    {
      name: "git apply naming a protected path via an injected patch file",
      command: "git apply p.diff",
      keyword: "patch",
      opts: {
        readFile: fakeReader({ "p.diff": diffBody, "/proj/p.diff": diffBody }),
      },
    },
    {
      name: "patch -p1 reading an injected patch file via a stdin redirect",
      command: "patch -p1 < p.diff",
      keyword: "patch",
      opts: {
        readFile: fakeReader({ "p.diff": diffBody, "/proj/p.diff": diffBody }),
      },
    },
  ];

  it.each(SPECIAL_BLOCKED)("$name", ({ command, keyword, opts }) => {
    expectBlocked(command, keyword, opts);
  });
});

describe("findBashWriteToProtectedPath -- MUST ALLOW (null) for a hub caller", () => {
  const ALLOWED_SIMPLE: string[] = [
    "cat packages/cli/src/a.ts",
    "grep -rn foo packages/cli/src",
    "rg foo packages/cli/tests",
    "ls packages/cli/src",
    "head -5 packages/cli/src/a.ts",
    "git diff -- packages/cli/src",
    "git show HEAD:packages/cli/src/a.ts",
    "git log -- packages/cli/src",
    "git add packages/cli/src/a.ts",
    'git commit -s -m "fix: src/ tests/"',
    "git checkout -- packages/cli/src/a.ts",
    "git status",
    "git apply --check p.diff",
    "git apply --stat p.diff",
    "pnpm test",
    "pnpm vitest run packages/cli/tests/a.test.ts",
    "vitest run packages/cli/tests/a.test.ts",
    "tsc -b",
    "eslint packages/cli/src",
    "pnpm lint",
    "prettier --check packages/cli/src",
    "pnpm --filter ./packages/cli test",
    "node packages/cli/tests/x.mjs",
    "node --test packages/cli/tests",
    "diff -u a packages/cli/src/a.ts",
    "wc -l packages/cli/src/*.ts",
    "find packages/cli/src -name '*.ts'",
    "cp packages/cli/src/a.ts /tmp/a.ts",
    "rsync -a packages/cli/src/ /tmp/backup/",
    "sed -n '1,5p' packages/cli/src/a.ts",
    "sed 's/a/b/' packages/cli/src/a.ts > /tmp/out.ts",
    "perl -ne 'print' packages/cli/src/a.ts",
    "python3 -c \"print(open('packages/cli/src/a.ts').read())\"",
    `node -e "console.log(${NODE_LOAD_FS_CALL}'fs').readFileSync('packages/cli/src/a.ts','utf8'))"`,
    "tee /tmp/x",
    "cmd > /dev/null",
    "cmd 2>/dev/null",
    "cmd &>/dev/null",
    "cmd 2>&1",
    "cmd >&2",
    "cat packages/cli/src/a.ts > /tmp/a.txt",
    "echo x > docs/note.md",
    "echo x > .claude/rules/r.md",
    "> bin/lib/x.mjs",
    "> templates/core/CLAUDE.md",
    "> packages/cli/dist/a.js",
    "> packages/cli/srcfoo/a.ts",
    "> packages/cli/mysrc/a.ts",
    'echo "write to packages/cli/src/a.ts > not a redirect"',
    "echo 'a > packages/cli/src/a.ts'",
    'grep -n "> packages/cli/src" notes.md',
    ["cat <<EOF", "echo x > packages/cli/src/a.ts", "EOF"].join("\n"),
    commitWithHeredocMessage,
    "[[ a > b ]]",
    "(( x > 3 ))",
    "> /elsewhere/packages/cli/src/a.ts",
    "> ~/src/other/a.ts",
    "> $OUT",
    '> "$DIR/a.ts"',
    "> $(mktemp)",
  ];

  it.each(ALLOWED_SIMPLE)("%s", (command) => {
    expectAllowed(command);
  });

  interface SpecialAllowedCase {
    name: string;
    command: string;
    opts?: Partial<FindOpts>;
  }

  const SPECIAL_ALLOWED: SpecialAllowedCase[] = [
    {
      name: "a project script INSIDE projectDir is trusted, not scanned, even though it writes to a tests path",
      command: "node bin/verify.mjs --group test",
      opts: {
        readFile: fakeReader({
          "bin/verify.mjs": "writeFileSync('tests/generated.ts', 'x');",
          "/proj/bin/verify.mjs": "writeFileSync('tests/generated.ts', 'x');",
        }),
      },
    },
    {
      name: "git apply --check (dry run) never blocks even when the named patch touches a protected path",
      command: "git apply --check p.diff",
      opts: {
        readFile: fakeReader({ "p.diff": diffBody, "/proj/p.diff": diffBody }),
      },
    },
    {
      name: "git apply --stat (dry run) never blocks even when the named patch touches a protected path",
      command: "git apply --stat p.diff",
      opts: {
        readFile: fakeReader({ "p.diff": diffBody, "/proj/p.diff": diffBody }),
      },
    },
  ];

  it.each(SPECIAL_ALLOWED)("$name", ({ command, opts }) => {
    expectAllowed(command, opts);
  });
});

/**
 * Fix-round regression tests (review-found false positives): a guarded
 * string literal must only count when it is the argument/receiver of a
 * write-verb CALL (the first path argument for write/append, the
 * destination argument for a copy, a write-mode `open(...)`, a
 * `Path(...).write_text`/`write_bytes` receiver) -- not merely present
 * ANYWHERE in an interpreter snippet that also happens to contain some
 * write-verb token elsewhere (e.g. `process.stdout.write(...)` wrapping an
 * unrelated READ of the guarded path). The MUST-ALLOW cases below currently
 * fail (false positives); the MUST-BLOCK cases confirm the precision fix
 * doesn't regress a real write at the correct argument position.
 */
describe("findBashWriteToProtectedPath -- argument-position precision (regression)", () => {
  const ALLOWED_PRECISION: [string, string][] = [
    [
      "node -e: a protected path is only READ (via fs's readFileSync), wrapped in an unrelated process.stdout.write(...)",
      `node -e "process.stdout.write(${NODE_LOAD_FS_CALL}'fs').readFileSync('packages/cli/src/a.ts','utf8'))"`,
    ],
    [
      "python3 -c: a protected path is only READ (open(...).read()), wrapped in an unrelated sys.stdout.write(...)",
      "python3 -c \"import sys; sys.stdout.write(open('packages/cli/src/a.ts').read())\"",
    ],
    [
      "node -e: the protected path is read; the actual writeFileSync target is elsewhere (/tmp)",
      `node -e "const s=${NODE_LOAD_FS_CALL}'fs').readFileSync('packages/cli/src/a.ts','utf8'); ${NODE_LOAD_FS_CALL}'fs').writeFileSync('/tmp/out', s)"`,
    ],
    [
      "[[ ... ]] test expression: the '>' is a string comparison, never a redirect",
      "[[ -n $a && $b > src ]] && echo hi",
    ],
    [
      "node -e: copyFileSync's SOURCE argument (1st) names a protected path, destination is /tmp",
      `node -e "${NODE_LOAD_FS_CALL}'fs').copyFileSync('packages/cli/src/a.ts','/tmp/out')"`,
    ],
  ];

  it.each(ALLOWED_PRECISION)("%s", (_name, command) => {
    expectAllowed(command);
  });

  const BLOCKED_PRECISION: [string, string, string][] = [
    [
      "node -e: cpSync's DESTINATION argument (2nd) names a protected path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').cpSync('/tmp/x','packages/cli/src/a')"`,
      "node",
    ],
    [
      "node -e: copyFileSync's DESTINATION argument (2nd) names a protected path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').copyFileSync('/tmp/x','packages/cli/src/a.ts')"`,
      "node",
    ],
    [
      "node -e: appendFileSync's FIRST argument names a protected path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').appendFileSync('packages/cli/tests/a.ts','x')"`,
      "node",
    ],
  ];

  it.each(BLOCKED_PRECISION)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });
});

/**
 * Round-3 regression tests: treating `[[ ... ]]` / `[ ... ]` as one opaque
 * unit (so a `>`/`&&`/`||` inside a test expression is never misread as a
 * redirect or separator) must not go so far as to skip REAL command
 * substitutions inside that unit, nor treat an unquoted `;`/`&`/`|`/newline
 * between the opener and the next standalone closer as still "inside" the
 * test expression -- a real statement separator ends it. A write hiding in
 * either of those positions must still be caught; a genuine test expression
 * (no separator, no substituted write) must still be left alone.
 */
describe("findBashWriteToProtectedPath -- test-expression opaque-unit regressions", () => {
  const BLOCKED_TEST_EXPR: [string, string, string][] = [
    [
      "[[ ... ]] with a real $(...) command substitution that removes a protected directory",
      "[[ -n $(rm -rf packages/cli/src) ]]",
      "rm",
    ],
    [
      "[ ... ] with a double-quoted $(...) command substitution that writes into src",
      '[ -n "$(cp /tmp/x packages/cli/src/a.ts)" ]',
      "cp",
    ],
    [
      "[[ ... ]] with a backtick command substitution that touches a protected file",
      "[[ -n `touch packages/cli/src/a.ts` ]]",
      "touch",
    ],
    [
      "[ ... ] containing an unquoted ';' before the ']': not a single test unit, the middle command is a real rm",
      "[ x; rm packages/cli/src/a.ts; echo ]",
      "rm",
    ],
    [
      "python3 -c: open(...) with encoding= before mode= -- the write mode kwarg can be at any argument position, not just the 2nd",
      "python3 -c \"open('packages/cli/src/a.ts', encoding='utf8', mode='w').write('x')\"",
      "python",
    ],
  ];

  it.each(BLOCKED_TEST_EXPR)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  const ALLOWED_TEST_EXPR: [string, string][] = [
    [
      "[ ... ] with a $(...) substitution that only reads a protected file",
      '[ -n "$(cat packages/cli/src/a.ts)" ]',
    ],
    [
      "[[ 3 > 2 ]] is a numeric test comparison, not a redirect -- the command AFTER && is a plain read",
      "[[ 3 > 2 ]] && cat packages/cli/src/a.ts",
    ],
  ];

  it.each(ALLOWED_TEST_EXPR)("%s", (_name, command) => {
    expectAllowed(command);
  });
});

/**
 * GAP 3(a) contract tests: the hook's own documented FALSE NEGATIVES list
 * (see this file's header comment) currently states "a write into an
 * ANCESTOR of a guarded directory: only the operand itself is tested" and
 * gives exactly these examples as passing today. That must close: a
 * cp/rsync/install/mv DESTINATION, or an rm/mv operand, naming the project
 * root, `packages`, `packages/<pkg>`, or any other path that itself
 * CONTAINS a guarded directory beneath it (including a glob whose literal
 * prefix is such an ancestor) must now be blocked the same way a direct
 * `packages/cli/src/a.ts` operand already is.
 *
 * Every MUST-BLOCK row below is expected to presently return ALLOW (null)
 * -- that is this suite's RED state; `code-implementer` closes the gap.
 * The MUST-ALLOW rows lock in the surrounding behavior (source operands,
 * reads, and removals genuinely outside any guarded tree) that the fix
 * must not regress.
 */
describe("findBashWriteToProtectedPath -- GAP 3(a): ancestor-of-guarded-directory writes/removals", () => {
  const BLOCKED_ANCESTOR: [string, string, string][] = [
    [
      "rsync -a from an external source into a package dir (nested layout)",
      "rsync -a /tmp/pkg/ packages/cli/",
      "rsync",
    ],
    [
      "cp -r from an external source into a package dir (nested layout)",
      "cp -r /tmp/pkg/. packages/cli/",
      "cp",
    ],
    ["mv a whole package dir out of the tree", "mv packages/cli /tmp", "mv"],
    ["rm -rf a whole package dir", "rm -rf packages/cli", "rm"],
    ["rm -rf the project root via a glob", "rm -rf ./*", "rm"],
    ["rm -rf the project root itself", "rm -rf .", "rm"],
    ["rm -rf the project root via a bare glob", "rm -rf *", "rm"],
    [
      "mv the whole packages/ directory out of the tree",
      "mv packages /tmp",
      "mv",
    ],
    ["rm -r the whole packages/ directory", "rm -r packages", "rm"],
    ["rm -rf every package via a glob", "rm -rf packages/*", "rm"],
    [
      "rm -rf everything inside one package via a glob",
      "rm -rf packages/cli/*",
      "rm",
    ],
  ];

  it.each(BLOCKED_ANCESTOR)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  // Flat-layout equivalents -- the emitted templates/core baseline guards
  // src/** and tests/** directly under the project root, with no
  // packages/<pkg> nesting, but it is the SAME pure function (isProtectedPath
  // matches a bare "src/"/"tests/" segment too): the project root itself is
  // the ancestor of its own src/tests there.
  const BLOCKED_ANCESTOR_FLAT: [string, string, string][] = [
    [
      "rsync -a into the project root (flat layout)",
      "rsync -a /tmp/x/ .",
      "rsync",
    ],
    [
      "rsync -a into the project root with a trailing slash (flat layout)",
      "rsync -a /tmp/x/ ./",
      "rsync",
    ],
    [
      "cp -r into the project root by absolute path (flat layout)",
      `cp -r /tmp/x/. ${PROJECT_DIR}`,
      "cp",
    ],
  ];

  it.each(BLOCKED_ANCESTOR_FLAT)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  const ALLOWED_ANCESTOR: [string, string][] = [
    [
      "cp's SOURCE operand is an ancestor, never checked",
      "cp -r packages/cli /tmp/x",
    ],
    [
      "rsync's SOURCE operand is an ancestor, never checked",
      "rsync -a packages/cli/ /tmp/backup/",
    ],
    ["a plain read (ls) of an ancestor path", "ls packages/cli"],
    ["a plain read (cat) of an ancestor path", "cat packages/cli"],
    [
      "tar reading an ancestor path is not a recognised write tool",
      "tar czf /tmp/x.tgz packages/cli",
    ],
    ["rm -rf outside any guarded tree (node_modules)", "rm -rf node_modules"],
    ["rm -rf outside any guarded tree (dist)", "rm -rf dist"],
    [
      "rm -rf a package's own dist/ is not an ancestor of src/tests",
      "rm -rf packages/cli/dist",
    ],
    [
      "rm -rf a worktree directory is not an ancestor of src/tests",
      "rm -rf .claude/worktrees/x",
    ],
    ["rm -rf outside any guarded tree (coverage)", "rm -rf coverage"],
    [
      "rm -rf a package's own node_modules/ is not an ancestor of src/tests",
      "rm -rf packages/cli/node_modules",
    ],
    ["rm -rf a path entirely outside the project", "rm -rf /tmp/x"],
  ];

  it.each(ALLOWED_ANCESTOR)("%s", (_name, command) => {
    expectAllowed(command);
  });
});

/**
 * GAP 4(a) contract tests: `containsGuardedTree`'s glob branch today only
 * recognises a trailing glob that could itself literally BE a workspace
 * container or guarded-dir name (`packages/*`). It misses the more common
 * shape -- a glob standing for a PACKAGE NAME directly inside a workspace
 * container (`packages/c*`, `packages/cli*`, `packages/cl?`,
 * `packages/[c]li`) -- which also removes/moves that package's whole
 * src/tests tree and must be blocked the same way `packages/cli` (no glob)
 * already is. Conversely, today's bare-`*`-matches-anything rule
 * over-blocks a build/scratch directory's OWN glob clear
 * (`dist/*`, `coverage/*`, `tmp/*`, a package's own `dist/*`) purely because
 * `*` can match any literal name -- those must become ALLOW. Every
 * MUST-BLOCK row below is expected to presently return ALLOW (null) and
 * every "now allowed" row is expected to presently return a BLOCK (not
 * null) -- this describe's RED state; `code-implementer` closes the gap on
 * `containsGuardedTree`'s glob branch without reopening GAP 3(a)'s rows
 * above (kept passing by the MUST-BLOCK rows already there).
 */
describe("findBashWriteToProtectedPath -- GAP 4(a): ancestor glob matches a package NAME, and the bare-`*` over-block is fixed", () => {
  const BLOCKED_PACKAGE_NAME_GLOB: [string, string, string][] = [
    [
      "rm -rf packages/c* removes every package whose name starts with c",
      "rm -rf packages/c*",
      "rm",
    ],
    [
      "rm -rf packages/cli* removes the package via a trailing wildcard",
      "rm -rf packages/cli*",
      "rm",
    ],
    [
      "rm -rf packages/cl? removes the package via a single-char wildcard",
      "rm -rf packages/cl?",
      "rm",
    ],
    [
      "rm -rf packages/[c]li removes the package via a character class",
      "rm -rf packages/[c]li",
      "rm",
    ],
    [
      "mv packages/c* /tmp moves a whole package dir out of the tree via a wildcard",
      "mv packages/c* /tmp",
      "mv",
    ],
  ];

  it.each(BLOCKED_PACKAGE_NAME_GLOB)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  const ALLOWED_OWN_GLOB_CLEAR: [string, string][] = [
    [
      "rm -rf dist/* clears a build artifact directory, not an ancestor of src/tests",
      "rm -rf dist/*",
    ],
    [
      "rm -rf coverage/* clears a build artifact directory, not an ancestor of src/tests",
      "rm -rf coverage/*",
    ],
    [
      "rm -rf tmp/* clears a scratch directory, not an ancestor of src/tests",
      "rm -rf tmp/*",
    ],
    [
      "rm -rf packages/cli/dist/* clears a package's own build artifact, not an ancestor of its src/tests",
      "rm -rf packages/cli/dist/*",
    ],
    [
      "cp -r into a package's own dist/ directory is not an ancestor write",
      "cp -r /tmp/x packages/cli/dist/",
    ],
  ];

  it.each(ALLOWED_OWN_GLOB_CLEAR)("%s", (_name, command) => {
    expectAllowed(command);
  });
});

/**
 * GAP 4(b): `rsync --remove-source-files` deletes every file it copies out
 * of the SOURCE tree once the transfer succeeds -- unlike a bare `rsync`,
 * the source operand is itself a write (a deletion) target, the same as an
 * `mv` source, and must be blocked when that source is (or contains) a
 * guarded path. Today `analyseCopy`'s rsync branch never inspects
 * `--remove-source-files` and only ever checks the destination, so this is
 * expected to presently return ALLOW (null) -- this describe's RED state.
 */
describe("findBashWriteToProtectedPath -- GAP 4(b): rsync --remove-source-files deletes its source", () => {
  it("blocks rsync --remove-source-files whose source is a guarded path", () => {
    expectBlocked("rsync --remove-source-files packages/cli/ /tmp/x/", "rsync");
  });

  it("still allows a plain rsync (no --remove-source-files) copying the same source", () => {
    expectAllowed("rsync -a packages/cli/ /tmp/x/");
  });
});

/**
 * GAP 3(b) contract tests: two more documented FALSE NEGATIVES close here --
 * "`php` is screened only for `rename(` (no `file_put_contents` or
 * `fopen`)" and "an interpreter's delete calls (`fs.rmSync`, `os.remove`,
 * `shutil.rmtree`, `Path.unlink`) are not write verbs here". Each MUST-BLOCK
 * row is expected to presently return ALLOW (null); the `os.rename`/
 * `renameSync` rows are regression locks (already a recognised write verb
 * today, kept green across the fix).
 */
describe("findBashWriteToProtectedPath -- GAP 3(b): php write verbs and interpreter delete verbs", () => {
  const BLOCKED_DELETE_AND_PHP: [string, string, string][] = [
    // php -- file_put_contents and a write-mode fopen are write calls.
    [
      "php -r inline file_put_contents against a guarded path",
      "php -r \"file_put_contents('packages/cli/src/a.ts', 'x');\"",
      "php",
    ],
    [
      "php -r inline fopen in write mode against a guarded path",
      "php -r \"fopen('packages/cli/tests/a.ts', 'w');\"",
      "php",
    ],
    [
      "php -r inline fopen in append mode against a guarded path",
      "php -r \"fopen('packages/cli/src/a.ts', 'a');\"",
      "php",
    ],

    // node -- fs's delete/rename verbs against a guarded path.
    [
      "node -e inline fs.rmSync against a guarded path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').rmSync('packages/cli/src/a.ts')"`,
      "node",
    ],
    [
      "node -e inline fs.unlinkSync against a guarded path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').unlinkSync('packages/cli/src/a.ts')"`,
      "node",
    ],
    [
      "node -e inline fs.rmdirSync against a guarded path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').rmdirSync('packages/cli/tests/fixtures')"`,
      "node",
    ],
    [
      "node -e inline fs.renameSync against a guarded path (already a write verb -- regression lock)",
      `node -e "${NODE_LOAD_FS_CALL}'fs').renameSync('packages/cli/src/a.ts','/tmp/x')"`,
      "node",
    ],

    // python -- os's and shutil's delete/rename/move verbs, and
    // Path(...).unlink(), against a guarded path.
    [
      "python3 -c inline os.remove against a guarded path",
      "python3 -c \"import os; os.remove('packages/cli/src/a.ts')\"",
      "python",
    ],
    [
      "python3 -c inline os.unlink against a guarded path",
      "python3 -c \"import os; os.unlink('packages/cli/src/a.ts')\"",
      "python",
    ],
    [
      "python3 -c inline os.replace against a guarded path",
      "python3 -c \"import os; os.replace('packages/cli/src/a.ts', '/tmp/x')\"",
      "python",
    ],
    [
      "python3 -c inline shutil.rmtree against a guarded path",
      "python3 -c \"import shutil; shutil.rmtree('packages/cli/src')\"",
      "python",
    ],
    [
      "python3 -c inline shutil.move against a guarded path",
      "python3 -c \"import shutil; shutil.move('packages/cli/src/a.ts', '/tmp/x')\"",
      "python",
    ],
    [
      "python3 -c inline Path(...).unlink() against a guarded path",
      "python3 -c \"from pathlib import Path; Path('packages/cli/src/a.ts').unlink()\"",
      "python",
    ],
    [
      "python3 -c inline os.rename against a guarded path (already a write verb -- regression lock)",
      "python3 -c \"import os; os.rename('packages/cli/src/a.ts', '/tmp/x')\"",
      "python",
    ],
  ];

  it.each(BLOCKED_DELETE_AND_PHP)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  const ALLOWED_DELETE_AND_PHP: [string, string][] = [
    [
      "php -r inline fopen in read mode is never a write call",
      "php -r \"fopen('packages/cli/src/a.ts', 'r');\"",
    ],
    [
      "php -r inline file_put_contents against an unguarded path",
      "php -r \"file_put_contents('/tmp/x', 'x');\"",
    ],
    [
      "node -e inline fs.rmSync against an unguarded path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').rmSync('/tmp/x')"`,
    ],
    [
      "node -e inline fs.unlinkSync against an unguarded path (dist/)",
      `node -e "${NODE_LOAD_FS_CALL}'fs').unlinkSync('dist/a.js')"`,
    ],
    [
      "node -e inline fs.rmdirSync against an unguarded path",
      `node -e "${NODE_LOAD_FS_CALL}'fs').rmdirSync('/tmp/x')"`,
    ],
    [
      "python3 -c inline os.remove against an unguarded path",
      "python3 -c \"import os; os.remove('/tmp/x')\"",
    ],
    [
      "python3 -c inline shutil.rmtree against an unguarded path (dist)",
      "python3 -c \"import shutil; shutil.rmtree('dist')\"",
    ],
    [
      "python3 -c inline Path(...).unlink() against an unguarded path",
      "python3 -c \"from pathlib import Path; Path('/tmp/x').unlink()\"",
    ],
  ];

  it.each(ALLOWED_DELETE_AND_PHP)("%s", (_name, command) => {
    expectAllowed(command);
  });
});

/**
 * GAP 3(c): the php, deno and bun interpreter branches carried no dedicated
 * test coverage at all. `deno`/`bun` write-verb detection already works
 * today (they share the generic `scanCode`/`WRITE_CALL` path with
 * node/python) -- these rows are new COVERAGE, not a RED gap, and are
 * expected to pass immediately. The php rows duplicate (b)'s to confirm the
 * php branch itself (not just the write-verb list) is exercised.
 */
describe("findBashWriteToProtectedPath -- GAP 3(c): php/deno/bun interpreter branch coverage", () => {
  const BLOCKED_INTERPRETER_BRANCHES: [string, string, string][] = [
    [
      "deno eval inline writeFileSync (node:fs compat) against a guarded path",
      `deno eval "const fs = ${NODE_LOAD_FS_CALL}'node:fs'); fs.writeFileSync('packages/cli/src/a.ts','x')"`,
      "deno",
    ],
    [
      "bun -e inline writeFileSync (node fs compat) against a guarded path",
      `bun -e "${NODE_LOAD_FS_CALL}'fs').writeFileSync('packages/cli/src/a.ts','x')"`,
      "bun",
    ],
    [
      "bun -e inline Bun.write against a guarded path",
      "bun -e \"Bun.write('packages/cli/src/a.ts','x')\"",
      "bun",
    ],
    [
      "php -r inline file_put_contents against a guarded path (branch coverage)",
      "php -r \"file_put_contents('packages/cli/src/a.ts', 'x');\"",
      "php",
    ],
  ];

  it.each(BLOCKED_INTERPRETER_BRANCHES)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  const ALLOWED_INTERPRETER_BRANCHES: [string, string][] = [
    [
      "deno eval reading (readFileSync via node:fs compat) a guarded path is not a write",
      `deno eval "console.log(${NODE_LOAD_FS_CALL}'node:fs').readFileSync('packages/cli/src/a.ts','utf8'))"`,
    ],
    [
      "bun -e reading (readFileSync via node fs compat) a guarded path is not a write",
      `bun -e "console.log(${NODE_LOAD_FS_CALL}'fs').readFileSync('packages/cli/src/a.ts','utf8'))"`,
    ],
    [
      "php -r inline fopen in read mode is not a write (branch coverage)",
      "php -r \"fopen('packages/cli/src/a.ts', 'r');\"",
    ],
  ];

  it.each(ALLOWED_INTERPRETER_BRANCHES)("%s", (_name, command) => {
    expectAllowed(command);
  });

  interface SpecialInterpreterCase {
    name: string;
    command: string;
    keyword: string;
    opts?: Partial<FindOpts>;
  }

  const SPECIAL_BLOCKED_INTERPRETER: SpecialInterpreterCase[] = [
    {
      name: "deno run with an external script (outside projectDir) that writes a protected path",
      command: "deno run /tmp/gen.ts",
      keyword: "deno",
      opts: {
        readFile: fakeReader({
          "/tmp/gen.ts":
            "import { writeFileSync } from 'node:fs';\nwriteFileSync('packages/cli/src/a.ts', 'x');\n",
        }),
      },
    },
  ];

  it.each(SPECIAL_BLOCKED_INTERPRETER)(
    "$name",
    ({ command, keyword, opts }) => {
      expectBlocked(command, keyword, opts);
    },
  );
});

/**
 * GAP 4(c): `WRITE_CALL` screens for the generic `writeFileSync`/`rmSync`/...
 * verb family shared across node/python-fs-compat/deno/bun, but Deno's OWN
 * namespace calls (`Deno.writeTextFile(Sync)`, `Deno.remove(Sync)`) are a
 * different spelling entirely and are not in that list -- so deno's own API,
 * not just its node:fs compatibility shim, passes through unscreened today.
 * Every MUST-BLOCK row below is expected to presently return ALLOW (null)
 * -- this describe's RED state.
 */
describe("findBashWriteToProtectedPath -- GAP 4(c): Deno's own namespace calls (not just node:fs compat)", () => {
  const BLOCKED_DENO_OWN_API: [string, string, string][] = [
    [
      "deno eval inline Deno.remove (recursive) against a guarded path",
      "deno eval 'await Deno.remove(\"packages/cli/src\",{recursive:true})'",
      "deno",
    ],
    [
      "deno eval inline Deno.removeSync against a guarded path",
      "deno eval 'Deno.removeSync(\"packages/cli/src/a.ts\")'",
      "deno",
    ],
    [
      "deno eval inline Deno.writeTextFileSync against a guarded path",
      'deno eval \'Deno.writeTextFileSync("packages/cli/src/a.ts","x")\'',
      "deno",
    ],
    [
      "deno eval inline Deno.writeTextFile against a guarded path",
      'deno eval \'Deno.writeTextFile("packages/cli/src/a.ts","x")\'',
      "deno",
    ],
  ];

  it.each(BLOCKED_DENO_OWN_API)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  it("blocks a deno run -A - heredoc stdin script calling Deno.writeTextFileSync against a guarded path", () => {
    const command = [
      "deno run -A - <<EOF",
      'Deno.writeTextFileSync("packages/cli/src/a.ts","x")',
      "EOF",
    ].join("\n");
    expectBlocked(command, "deno");
  });

  const ALLOWED_DENO_OWN_API: [string, string][] = [
    [
      "deno eval inline Deno.readTextFileSync (a read) is not a write",
      "deno eval 'Deno.readTextFileSync(\"packages/cli/src/a.ts\")'",
    ],
    [
      "deno eval inline Deno.removeSync against an unguarded path",
      "deno eval 'Deno.removeSync(\"/tmp/x\")'",
    ],
  ];

  it.each(ALLOWED_DENO_OWN_API)("%s", (_name, command) => {
    expectAllowed(command);
  });
});

/**
 * GAP 7: `containsGuardedTree`'s glob branch only recognises a glob
 * character sitting in the FINAL path segment (see its own doc comment:
 * "only the last segment is read as a glob -- a mid-path glob is an opaque
 * package name"). A glob in an EARLIER segment is therefore matched
 * LITERALLY against `WORKSPACE_CONTAINERS` and can never be recognised as
 * potentially expanding to `packages` (or a package name directly beneath
 * one) at runtime -- so a destructive operand built from a non-final glob
 * segment (two stars separated by a slash, a star then a literal package
 * name, or a literal prefix then a star) passes through unblocked today,
 * even though at runtime it can expand to exactly the same
 * `packages/cli` ancestor a literal `rm -rf packages/cli` already blocks
 * (see GAP 3(a)/4(a) above). Every MUST-BLOCK row below is expected to
 * presently return ALLOW (null) -- this describe's RED state;
 * `code-implementer` closes the gap by also matching a glob sitting in a
 * non-final segment against `WORKSPACE_CONTAINERS` (and a package-name
 * segment directly beneath one), without reopening GAP 4(a)'s "own glob
 * clear" rows (a build directory's own contents, e.g. `packages/cli/dist`)
 * -- a flat-layout equivalent does not apply here since none of these
 * commands name a package (`cli`) that exists in a flat, non-nested layout.
 */
describe("findBashWriteToProtectedPath -- GAP 7: a glob in a NON-FINAL path segment is opaque today", () => {
  const BLOCKED_MIDPATH_GLOB: [string, string, string][] = [
    [
      "rm -rf */* -- both segments globbed, the first could expand to the packages container",
      "rm -rf */*",
      "rm",
    ],
    [
      "rm -rf */cli -- the first (non-final) segment could expand to packages",
      "rm -rf */cli",
      "rm",
    ],
    [
      "rm -rf pack*/* -- a partial-literal non-final segment could still expand to packages",
      "rm -rf pack*/*",
      "rm",
    ],
    [
      "rm -rf p*/cli -- same, with a literal final package-name segment",
      "rm -rf p*/cli",
      "rm",
    ],
    [
      "mv */cli /tmp -- an mv SOURCE naming the same ancestor via a non-final glob segment",
      "mv */cli /tmp",
      "mv",
    ],
  ];

  it.each(BLOCKED_MIDPATH_GLOB)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });
});

/**
 * GAP 9: `containsGuardedTree`'s non-final-segment check
 * (`isContainer(n-1) || isContainer(n-2)`) matches a workspace-container
 * name -- or a glob that could expand to one -- at whatever index it lands
 * on counting back from the END of the operand, not relative to the
 * project ROOT. GAP 7's fix above anchors correctly for a 1- or 2-segment
 * operand (there, `n-2` IS index 0), but once the operand is three or more
 * segments deep, `n-2`/`n-1` land on a MIDDLE segment that merely happens
 * to share a container's name -- so `docs/packages/old` reads as
 * "`packages` the container, `old` the package" even though `packages`
 * here sits two levels below the project root, never as the operand's own
 * first segment. The same drift hits a package's own build and scratch
 * directories (a package name glob followed by `dist`, or by `coverage`)
 * and a bare top-level `node_modules` sweep (a leading glob followed by
 * `node_modules`): in each case the glob standing in for the PACKAGE NAME
 * sits at index 1, not index 0, yet still satisfies `isContainer` because
 * that check never looks at WHERE in the operand the candidate segment
 * sits. Only the operand's first segment (workspace-relative) can ever BE
 * a workspace container; a container-shaped name anywhere else is an
 * ordinary nested directory with no guarded `src`/`tests` tree beneath it.
 * Every MUST-ALLOW row below is expected to presently return a BLOCK (an
 * `ancestor: true` hit) -- this describe's RED state; `code-implementer`
 * closes the gap by anchoring the container check to segment index 0 only.
 * The MUST-BLOCK rows lock in the surrounding behavior (the container
 * ITSELF, a bare package-glob sweep directly under it, and a direct
 * `src`/`tests` target reached through a glob placeholder) that the fix
 * must not regress.
 */
describe("findBashWriteToProtectedPath -- GAP 9: a workspace-container name counts only as the operand's OWN first segment", () => {
  const ALLOWED_NESTED_CONTAINER_NAME: [string, string][] = [
    [
      "rm -rf packages/*/dist -- a package's own build artifact; 'packages' is the first segment but the glob package-name slot is index 1, not a second container",
      "rm -rf packages/*/dist",
    ],
    [
      "rm -rf packages/*/coverage -- a package's own coverage artifact, same shape as dist",
      "rm -rf packages/*/coverage",
    ],
    [
      "rm -rf */node_modules -- each top-level directory's own node_modules, not a package dir inside a container",
      "rm -rf */node_modules",
    ],
    [
      "rm -rf docs/packages/old -- 'packages' sits two levels deep, never the operand's own first segment",
      "rm -rf docs/packages/old",
    ],
  ];

  it.each(ALLOWED_NESTED_CONTAINER_NAME)("%s", (_name, command) => {
    expectAllowed(command);
  });

  it("still allows rm -rf packages/cli/dist (regression lock -- already allowed today, must stay so)", () => {
    expectAllowed("rm -rf packages/cli/dist");
  });

  const BLOCKED_FIRST_SEGMENT_CONTAINER: [string, string, string][] = [
    [
      "rm -rf packages/*/src stays blocked -- a direct guarded path reached through a glob placeholder, not an ancestor call",
      "rm -rf packages/*/src",
      "rm",
    ],
    [
      "rm -rf packages/*/tests stays blocked -- a direct guarded path reached through a glob placeholder, not an ancestor call",
      "rm -rf packages/*/tests",
      "rm",
    ],
    [
      "rm -rf packages stays blocked -- the container ITSELF, at the operand's own first (and only) segment",
      "rm -rf packages",
      "rm",
    ],
    [
      "rm -rf packages/* stays blocked -- a bare package sweep, container at the operand's own first segment",
      "rm -rf packages/*",
      "rm",
    ],
  ];

  it.each(BLOCKED_FIRST_SEGMENT_CONTAINER)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });
});

/**
 * GAP 10 contract tests: `containsGuardedTree`'s glob branch caps out at
 * `if (!container || n > 3) return false;` -- an operand resolving to FOUR
 * or more path segments is unconditionally read as allowed, regardless of
 * whether its first segment is (or globs to) a workspace container and a
 * later segment could expand to `src`/`tests`. This is a regression from
 * the GAP 9 fix (commit anchoring the container check to the operand's own
 * first segment): a 4-segment operand such as `packages/cli/*\/*` -- whose
 * first segment literally IS the `packages` container and whose third
 * segment (index 2) is a bare `*` that could expand to `src` or `tests` --
 * is exactly the shape GAP 3(a)/4(a) already block at 3 segments
 * (`packages/cli/*`), yet is allowed today purely because it is one segment
 * longer. Every MUST-BLOCK row below is expected to presently return ALLOW
 * (null) -- this describe's RED state; `code-implementer` closes the gap by
 * extending the rule past the `n > 3` cutoff: when the first segment is (or
 * globs to) a workspace container, a glob segment at index >= 2 that could
 * expand to `src` or `tests` makes the operand an ancestor, at any depth --
 * without reopening GAP 9's own fix (a container-shaped name that is not
 * the operand's own first segment must stay unblocked, regression-locked
 * below).
 *
 * `rm -rf *a` + two more globbed segments is deliberately NOT included as a
 * MUST-BLOCK row: it is only 3 segments (`["*a", "*", "*"]`), not 4+, so it
 * is outside this gap's `n > 3` cutoff entirely, and its first segment
 * `*a` cannot glob-match any `WORKSPACE_CONTAINERS` name (none of
 * `packages`/`apps`/`libs` end in `a`). Running the pre-GAP-9 hook (commit
 * `77127ba^`) over it confirms it used to block this command only as a
 * side effect of the SAME over-blocking bug GAP 9's commit fixed (that
 * commit's own message cites a package's own build directory and
 * `docs/packages/old` as the false positives it closed; this one was swept
 * up in the identical "any segment can be the container" bug, not a
 * targeted true positive). Its current ALLOW is therefore correct
 * post-GAP-9 behavior, not a regression, and is locked in below instead.
 */
describe("findBashWriteToProtectedPath -- GAP 10: a glob operand of 4+ segments is unconditionally allowed today", () => {
  const BLOCKED_DEEP_GLOB: [string, string, string][] = [
    [
      "rm -rf packages/cli/*/* -- a direct package, a glob at index 2 could expand to src/tests",
      "rm -rf packages/cli/*/*",
      "rm",
    ],
    [
      "rm -rf packages/cli/*/*.ts -- same shape, a suffixed glob at index 2 could still expand to src/tests",
      "rm -rf packages/cli/*/*.ts",
      "rm",
    ],
    [
      "rm -rf packages/*/*/* -- a glob package name, a glob at index 2 could expand to src/tests",
      "rm -rf packages/*/*/*",
      "rm",
    ],
    [
      "rm -rf packages/*/*/*.ts -- same shape, suffixed glob at index 2",
      "rm -rf packages/*/*/*.ts",
      "rm",
    ],
    [
      "rm -rf packages/*/[st]*/* -- a character-class glob at index 2 matches both src and tests",
      "rm -rf packages/*/[st]*/*",
      "rm",
    ],
    [
      "rm -rf p*/*/*/* -- a globbed first segment could still expand to the packages container",
      "rm -rf p*/*/*/*",
      "rm",
    ],
    [
      "rm -rf */*/*/* -- a bare-* first segment could expand to any container",
      "rm -rf */*/*/*",
      "rm",
    ],
    [
      "rm -rf */*/*/*.ts -- same shape, suffixed glob at the last segment",
      "rm -rf */*/*/*.ts",
      "rm",
    ],
    [
      "rm -rf */*/*/x -- a literal last segment, the blocking glob is at index 2",
      "rm -rf */*/*/x",
      "rm",
    ],
    [
      "mv */*/*/* /tmp/ -- an mv SOURCE naming the same 4-segment ancestor shape",
      "mv */*/*/* /tmp/",
      "mv",
    ],
  ];

  it.each(BLOCKED_DEEP_GLOB)("%s", (_name, command, keyword) => {
    expectBlocked(command, keyword);
  });

  const ALLOWED_DEEP_GLOB_REGRESSION: [string, string][] = [
    [
      "rm -rf *a/*/* -- 3 segments, outside this gap; first segment '*a' cannot glob-match any workspace container (regression lock, see describe comment)",
      "rm -rf *a/*/*",
    ],
    [
      "rm -rf packages/*/dist -- GAP 9 regression lock: a package's own build artifact stays unblocked at 3 segments",
      "rm -rf packages/*/dist",
    ],
    [
      "rm -rf packages/*/coverage -- GAP 9 regression lock: a package's own coverage artifact stays unblocked",
      "rm -rf packages/*/coverage",
    ],
    [
      "rm -rf */node_modules -- GAP 9 regression lock: a top-level node_modules sweep stays unblocked",
      "rm -rf */node_modules",
    ],
    [
      "rm -rf docs/packages/old -- GAP 9 regression lock: 'packages' two levels deep is not the operand's own first segment",
      "rm -rf docs/packages/old",
    ],
    [
      "rm -rf packages/cli/dist -- GAP 9 regression lock: a package's own dist/ is not an ancestor of its src/tests",
      "rm -rf packages/cli/dist",
    ],
    [
      "rm -rf packages/node_modules -- GAP 9 regression lock: node_modules is never a package",
      "rm -rf packages/node_modules",
    ],
  ];

  it.each(ALLOWED_DEEP_GLOB_REGRESSION)("%s", (_name, command) => {
    expectAllowed(command);
  });
});

describe("findBashWriteToProtectedPath never throws, however malformed the command text", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["unterminated double quote", 'echo "abc'],
    [
      "unterminated heredoc",
      ["cat <<EOF", "body with no closing marker"].join("\n"),
    ],
    ["100KB of repeated filler", "a ".repeat(50_000)],
  ])("%s", (_name, command) => {
    expect(() => find(command)).not.toThrow();
    expect(find(command)).toBeNull();
  });
});

describe("findBashWriteToProtectedPath's default readFile reads the real filesystem", () => {
  it("reads a script FILE from disk when no readFile is injected", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-hub-bash-script-"));
    try {
      const scriptPath = join(dir, "gen.mjs");
      writeFileSync(
        scriptPath,
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('packages/cli/src/a.ts', 'x');\n",
      );
      const result = hook.findBashWriteToProtectedPath(`node ${scriptPath}`, {
        cwd: PROJECT_DIR,
        projectDir: PROJECT_DIR,
      });
      expect(result).not.toBeNull();
      expect(result?.path).toContain("packages/cli/src/a.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Fix-round visibility tests: `opts.notes` (a `Set<string>`, injected by the
 * caller) lets the detector report WHY it gave up on a command it could not
 * fully analyse, without changing the allow/block verdict itself -- giving
 * up must still mean "allow" (a static screen errs toward not blocking a
 * legitimate command it can't fully parse), but silently allowing with no
 * trace at all is the gap this closes.
 */
describe("findBashWriteToProtectedPath -- visibility notes (opts.notes)", () => {
  it("reports a 'nesting' note and allows once the nesting depth cap is exceeded", () => {
    const notes = new Set<string>();
    const result = hook.findBashWriteToProtectedPath(NESTED_PAST_DEPTH_CAP, {
      cwd: PROJECT_DIR,
      projectDir: PROJECT_DIR,
      notes,
    });
    expect(result).toBeNull();
    expect(notes.size).toBeGreaterThan(0);
    expect([...notes].some((note) => note.includes("nesting"))).toBe(true);
  });

  it("reports a 'size' note and allows for an oversized injected script file (>1MB)", () => {
    const notes = new Set<string>();
    const oversized =
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('packages/cli/src/a.ts', 'x');\n" +
      "x".repeat(1_100_000);
    const result = hook.findBashWriteToProtectedPath("node /tmp/big.mjs", {
      cwd: PROJECT_DIR,
      projectDir: PROJECT_DIR,
      readFile: fakeReader({ "/tmp/big.mjs": oversized }),
      notes,
    });
    expect(result).toBeNull();
    expect(notes.size).toBeGreaterThan(0);
    expect([...notes].some((note) => note.includes("size"))).toBe(true);
  });

  it("reports a 'read' note for an existing-but-unreadable target (a directory) via the default reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-hub-bash-unreadable-"));
    try {
      const notes = new Set<string>();
      const result = hook.findBashWriteToProtectedPath(`node ${dir}`, {
        cwd: PROJECT_DIR,
        projectDir: PROJECT_DIR,
        notes,
      });
      expect(result).toBeNull();
      expect(notes.size).toBeGreaterThan(0);
      expect([...notes].some((note) => note.includes("read"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds no note for a target that simply does not exist (ENOENT)", () => {
    const notes = new Set<string>();
    const missing = join(
      tmpdir(),
      "guard-hub-bash-does-not-exist-dir",
      "gen.mjs",
    );
    const result = hook.findBashWriteToProtectedPath(`node ${missing}`, {
      cwd: PROJECT_DIR,
      projectDir: PROJECT_DIR,
      notes,
    });
    expect(result).toBeNull();
    expect(notes.size).toBe(0);
  });

  /**
   * GAP 5: `scanCode`'s `splitArgs` silently gives up (`if (!args) continue`,
   * no `addNote`) on a write-call whose argument list exceeds
   * `MAX_CALL_CHARS` -- the call is never screened AND nothing records that
   * it wasn't. This describe's RED state: the long call allows with zero
   * notes today; it must instead allow WITH a note mentioning the cap.
   */
  it("reports a note mentioning the size cap for a write-call argument list past MAX_CALL_CHARS, and still allows", () => {
    const notes = new Set<string>();
    const result = hook.findBashWriteToProtectedPath(LONG_CALL_COMMAND, {
      cwd: PROJECT_DIR,
      projectDir: PROJECT_DIR,
      notes,
    });
    expect(result).toBeNull();
    expect(notes.size).toBeGreaterThan(0);
    expect([...notes].some((note) => /cap/i.test(note))).toBe(true);
  });

  it("still blocks the same write call when its argument list is short", () => {
    expectBlocked(SHORT_CALL_COMMAND, "node");
  });
});

describe("shouldBlockHubBashWrite -- writer-spoke carve-out", () => {
  interface AgentSampleCase {
    name: string;
    command: string;
    opts?: Partial<FindOpts>;
  }

  const AGENT_TYPE_SAMPLE: AgentSampleCase[] = [
    { name: "redirect", command: "echo x > packages/cli/src/a.ts" },
    { name: "tee", command: "tee packages/cli/src/a.ts" },
    { name: "sed -i", command: "sed -i 's/a/b/' packages/cli/src/a.ts" },
    { name: "cp", command: "cp x packages/cli/src/a.ts" },
    { name: "mv", command: "mv /tmp/x packages/cli/tests/a.ts" },
    {
      name: "python3 -c",
      command: "python3 -c \"open('packages/cli/src/a.ts','w').write('x')\"",
    },
    {
      name: "node -e",
      command: `node -e "${NODE_LOAD_FS_CALL}'fs').writeFileSync('packages/cli/src/a.ts','x')"`,
    },
    {
      name: "git apply (patch header via injected file)",
      command: "git apply p.diff",
      opts: {
        readFile: fakeReader({ "p.diff": diffBody, "/proj/p.diff": diffBody }),
      },
    },
    {
      name: "bash -c wraps a redirect",
      command: 'bash -c "echo x > packages/cli/src/a.ts"',
    },
    {
      name: "perl -pi",
      command: "perl -pi -e 's/a/b/' packages/cli/src/a.ts",
    },
  ];

  function callShouldBlock(
    command: string,
    agentType: unknown,
    opts: Partial<FindOpts> = {},
  ): BashWriteResult | null {
    return hook.shouldBlockHubBashWrite(command, agentType, {
      cwd: opts.cwd ?? PROJECT_DIR,
      projectDir: opts.projectDir ?? PROJECT_DIR,
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
    });
  }

  describe.each(["test-author", "code-implementer"])(
    "writer spoke %s is never blocked",
    (agentType) => {
      it.each(AGENT_TYPE_SAMPLE)("$name", ({ command, opts }) => {
        expect(callShouldBlock(command, agentType, opts)).toBeNull();
      });
    },
  );

  describe.each([
    ["a non-writer subagent", "code-reviewer"],
    ["an empty agent_type", ""],
    ["an absent agent_type", undefined],
    ["a non-string agent_type", 42],
  ])("%s is blocked the same as the hub", (_label, agentType) => {
    it.each(AGENT_TYPE_SAMPLE)("$name", ({ command, opts }) => {
      expect(callShouldBlock(command, agentType, opts)).not.toBeNull();
    });
  });
});

function runHook(
  scriptPath: string,
  payload: unknown,
  env: { cwd?: string; projectDir?: string } = {},
): { status: number | null; stderr: string } {
  const result = spawnSync("node", [scriptPath], {
    input: JSON.stringify(payload),
    cwd: env.cwd,
    env: {
      ...process.env,
      ...(env.projectDir ? { CLAUDE_PROJECT_DIR: env.projectDir } : {}),
    },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe.each([
  ["root hook", hookPath],
  ["templates/core hook", corePath],
])("%s entry point (Bash tool, subprocess)", (_label, scriptPath) => {
  function withFakeProject<T>(run: (fakeProject: string) => T): T {
    const fakeProject = mkdtempSync(join(tmpdir(), "guard-hub-bash-project-"));
    mkdirSync(join(fakeProject, "packages", "cli", "src"), {
      recursive: true,
    });
    try {
      return run(fakeProject);
    } finally {
      rmSync(fakeProject, { recursive: true, force: true });
    }
  }

  it("blocks a hub Bash command that redirects into a guarded src path", () => {
    withFakeProject((fakeProject) => {
      const command = "echo x > packages/cli/src/a.ts";
      const expected = hook.findBashWriteToProtectedPath(command, {
        cwd: fakeProject,
        projectDir: fakeProject,
      });
      const { status, stderr } = runHook(
        scriptPath,
        { tool_name: "Bash", tool_input: { command }, cwd: fakeProject },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("guard-hub-src-writes");
      expect(stderr).toContain("packages/cli/src/a.ts");
      expect(expected).not.toBeNull();
      if (expected) expect(stderr).toContain(expected.rule);
    });
  });

  it("allows the same Bash command for a writer-spoke agent_type", () => {
    withFakeProject((fakeProject) => {
      const { status } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: "echo x > packages/cli/src/a.ts" },
          cwd: fakeProject,
          agent_type: "code-implementer",
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(0);
    });
  });

  it("allows a Bash command that redirects to /dev/null", () => {
    withFakeProject((fakeProject) => {
      const { status } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: "echo x > /dev/null" },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(0);
    });
  });

  it("honors the payload's cwd for a relative-path write issued from a worktree", () => {
    withFakeProject((fakeProject) => {
      const worktreeDir = join(fakeProject, ".claude", "worktrees", "w1");
      mkdirSync(join(worktreeDir, "packages", "cli", "src"), {
        recursive: true,
      });
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: "echo x > packages/cli/src/a.ts" },
          cwd: worktreeDir,
        },
        { cwd: worktreeDir, projectDir: fakeProject },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("guard-hub-src-writes");
    });
  });

  it("fails open (exit 0) on malformed JSON input", () => {
    withFakeProject((fakeProject) => {
      const result = spawnSync("node", [scriptPath], {
        input: "{not json",
        cwd: fakeProject,
        env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProject },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    });
  });

  it("fails open (exit 0) for a Bash tool_input with no command", () => {
    withFakeProject((fakeProject) => {
      const { status } = runHook(
        scriptPath,
        { tool_name: "Bash", tool_input: {}, cwd: fakeProject },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(0);
    });
  });

  it("treats a payload with no tool_name but a tool_input.command as Bash", () => {
    withFakeProject((fakeProject) => {
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_input: { command: "echo x > packages/cli/src/a.ts" },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("guard-hub-src-writes");
    });
  });

  it("still blocks a Write payload the same as before (no regression)", () => {
    withFakeProject((fakeProject) => {
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_name: "Write",
          tool_input: { file_path: "packages/cli/src/a.ts" },
        },
        { projectDir: fakeProject },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("guard-hub-src-writes");
    });
  });

  it("exits 0 with EMPTY stderr for a plain allowed command (no notes)", () => {
    withFakeProject((fakeProject) => {
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: "ls packages/cli/src" },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(0);
      expect(stderr).toBe("");
    });
  });

  // GAP 8: a Write/Edit payload whose file_path is not a string must fail
  // open the same way a Bash payload with a non-string command already does
  // (see "exits 0 but writes a stderr line when tool_input.command is not a
  // string" above) -- exit 0 with a non-empty stderr line, never an uncaught
  // crash. Today `runWriteGuard` computes `filePath && isAbsoluteLike(filePath)`
  // unconditionally once filePath is truthy, and `isAbsoluteLike` calls
  // `.startsWith` on it -- a non-string, truthy file_path (a number, a
  // plain object) throws an uncaught TypeError nothing catches, crashing the
  // process instead of failing open. This describe's RED state: today's
  // exit status is not 0 (an uncaught exception), not the documented
  // fail-open contract.
  it.each([
    ["Write", "a number", 123],
    ["Write", "a plain object", {}],
    ["Edit", "a number", 123],
  ])(
    "exits 0 with a non-empty, non-crash stderr line for a %s payload whose file_path is %s (not a string)",
    (toolName, _label, filePath) => {
      withFakeProject((fakeProject) => {
        const result = spawnSync("node", [scriptPath], {
          input: JSON.stringify({
            tool_name: toolName,
            tool_input: { file_path: filePath },
          }),
          cwd: fakeProject,
          env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProject },
          encoding: "utf8",
        });
        expect(result.status).toBe(0);
        expect(result.stderr.trim().length).toBeGreaterThan(0);
        // No uncaught-exception stack trace (a Node stack frame line starts
        // with leading whitespace then "at ").
        expect(result.stderr).not.toMatch(/\n\s*at /);
      });
    },
  );

  it("exits 0 but warns on stderr ('not fully analysed') when the nesting depth cap is hit", () => {
    withFakeProject((fakeProject) => {
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: NESTED_PAST_DEPTH_CAP },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(0);
      expect(stderr).toContain("not fully analysed");
    });
  });

  it("exits 0 but notes an unparseable JSON payload on stderr", () => {
    const result = spawnSync("node", [scriptPath], {
      input: "{not json",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("unparseable");
  });

  it("exits 0 but writes a stderr line when tool_input.command is not a string", () => {
    withFakeProject((fakeProject) => {
      const result = spawnSync("node", [scriptPath], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: 42 },
          cwd: fakeProject,
        }),
        cwd: fakeProject,
        env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProject },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr.trim().length).toBeGreaterThan(0);
    });
  });

  // GAP 5 (entry point, both hook copies): a write-call argument list past
  // MAX_CALL_CHARS must still fail open (exit 0) but say so on stderr.
  it("exits 0 but warns on stderr (mentioning the size cap) for a write-call argument list past MAX_CALL_CHARS", () => {
    withFakeProject((fakeProject) => {
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: LONG_CALL_COMMAND },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(0);
      expect(stderr.trim().length).toBeGreaterThan(0);
      expect(stderr).toMatch(/cap/i);
    });
  });

  it("exits 2 (still blocked) for the same write call when its argument list is short", () => {
    withFakeProject((fakeProject) => {
      const { status } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: SHORT_CALL_COMMAND },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(2);
    });
  });

  // GAP 6 (entry point, both hook copies): the block message for an
  // ANCESTOR target (a whole package dir, not a direct src/tests file) must
  // say so -- "ancestor" -- rather than reading identically to a direct hit,
  // so a maintainer reading stderr can tell the two cases apart.
  it("block message for an ancestor target explicitly names it an ANCESTOR of a guarded path", () => {
    withFakeProject((fakeProject) => {
      const { status, stderr } = runHook(
        scriptPath,
        {
          tool_name: "Bash",
          tool_input: { command: "rm -rf packages/cli" },
          cwd: fakeProject,
        },
        { cwd: fakeProject, projectDir: fakeProject },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("ancestor");
    });
  });
});

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface SettingsShape {
  hooks: { PreToolUse?: HookGroup[] };
}

function loadSettings(path: string): SettingsShape {
  return JSON.parse(readFileSync(path, "utf8")) as SettingsShape;
}

function groupsRunning(settings: SettingsShape, needle: string): HookGroup[] {
  return (settings.hooks.PreToolUse ?? []).filter((group) =>
    group.hooks.some((entry) => entry.command.includes(needle)),
  );
}

describe.each([
  ["root", join(repoRoot, ".claude", "settings.json")],
  [
    "templates/core",
    join(repoRoot, "templates", "core", ".claude", "settings.json"),
  ],
])(
  "%s settings.json registers guard-hub-src-writes under Write|Edit AND Bash",
  (_label, settingsPath) => {
    it("keeps the existing Write|Edit registration", () => {
      const groups = groupsRunning(
        loadSettings(settingsPath),
        "guard-hub-src-writes.mjs",
      );
      expect(
        groups.some(
          (group) =>
            group.matcher?.includes("Write") && group.matcher?.includes("Edit"),
        ),
      ).toBe(true);
    });

    it("adds a PreToolUse group matching Bash that also runs the hook", () => {
      const groups = groupsRunning(
        loadSettings(settingsPath),
        "guard-hub-src-writes.mjs",
      );
      expect(groups.some((group) => group.matcher === "Bash")).toBe(true);
    });
  },
);

describe("hook file count stays the same -- Bash support is added to the existing file, not a new one", () => {
  it("guard-hub-src-writes.mjs appears exactly once in the root .claude/hooks directory", () => {
    const rootHooksDir = join(repoRoot, ".claude", "hooks");
    const matches = readdirSync(rootHooksDir).filter(
      (name) => name === "guard-hub-src-writes.mjs",
    );
    expect(matches).toHaveLength(1);
  });

  it("templates/core's hooks directory still has exactly 10 .mjs files", () => {
    const coreHooksDir = join(
      repoRoot,
      "templates",
      "core",
      ".claude",
      "hooks",
    );
    const mjsFiles = readdirSync(coreHooksDir).filter((name) =>
      name.endsWith(".mjs"),
    );
    expect(mjsFiles).toHaveLength(10);
  });
});

describe("templates/core's guard-hub-src-writes.mjs stays a byte-for-byte twin of the root hook", () => {
  /**
   * The root hook carries an SPDX header (shebang, then two `// SPDX-...`
   * comment lines, then a blank line) that the emitted `templates/core`
   * copy deliberately omits -- `templates/**` ships brand-neutral into every
   * bootstrapped project and is exempted from the license-header gate (see
   * `REUSE.toml`). Stripping exactly that block is the only allowed
   * difference; everything else must match verbatim.
   */
  function stripRootOnlySpdxHeader(source: string): string {
    const lines = source.split("\n");
    if (
      lines[1]?.startsWith("// SPDX-FileCopyrightText") &&
      lines[2]?.startsWith("// SPDX-License-Identifier") &&
      lines[3] === ""
    ) {
      return [lines[0], ...lines.slice(4)].join("\n");
    }
    return source;
  }

  it("matches after stripping the root-only SPDX header (drift guard)", () => {
    const rootSource = readFileSync(hookPath, "utf8");
    const coreSource = readFileSync(corePath, "utf8");
    expect(stripRootOnlySpdxHeader(rootSource)).toBe(coreSource);
  });
});
