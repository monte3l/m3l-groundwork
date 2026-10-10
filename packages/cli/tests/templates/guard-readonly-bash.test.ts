// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Denylist gaps in `guard-readonly-bash.mjs`'s `classifyBashCommand` (missing
 * git/pnpm/npm mutating subcommands, `sed --in-place`, prefix-verb blind
 * spots for `sudo`/`env`/`xargs`/`bash -c`, and `find -delete`/`-exec`), and
 * a CRLF/quoting gap in `readOnlyAgentNames`'s frontmatter parsing.
 *
 * The hook's own `import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs"`
 * resolves relative to its own location, which in this pack's source tree
 * (`templates/packs/harness-extras/files/.claude/hooks/`) has no sibling
 * `bin/lib/agent-roster.mjs` -- that file only exists once a bootstrapped
 * project has both the baseline (which provides `bin/lib/agent-roster.mjs`)
 * and this pack installed on top of it. So the hook is loaded from a
 * temp directory that mirrors that emitted layout (`.claude/hooks/` +
 * `bin/lib/agent-roster.mjs`), the same shape `core-hooks.test.ts` uses for
 * a similar cross-file resolution concern.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const repoRoot = join(here, "..", "..", "..", "..");
const hookSource = join(
  repoRoot,
  "templates",
  "packs",
  "harness-extras",
  "files",
  ".claude",
  "hooks",
  "guard-readonly-bash.mjs",
);
const agentRosterSource = join(
  repoRoot,
  "templates",
  "core",
  "bin",
  "lib",
  "agent-roster.mjs",
);

interface GuardModule {
  classifyBashCommand: (command: string) => {
    blocked: boolean;
    reason?: string;
  };
  readOnlyAgentNames: (agentsDir: string) => Set<string>;
}

let scratch: string;
let guard: GuardModule;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "guard-readonly-bash-"));
  mkdirSync(join(scratch, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(scratch, "bin", "lib"), { recursive: true });
  copyFileSync(
    hookSource,
    join(scratch, ".claude", "hooks", "guard-readonly-bash.mjs"),
  );
  copyFileSync(
    agentRosterSource,
    join(scratch, "bin", "lib", "agent-roster.mjs"),
  );
  guard = (await import(
    pathToFileURL(join(scratch, ".claude", "hooks", "guard-readonly-bash.mjs"))
      .href
  )) as GuardModule;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("classifyBashCommand -- denylist gaps", () => {
  it.each([
    ["git rm file.txt", "missing git 'rm' subcommand"],
    ["git mv a.txt b.txt", "missing git 'mv' subcommand"],
    ["git pull", "missing git 'pull' subcommand"],
    ["pnpm install", "missing pnpm 'install' subcommand"],
    ["pnpm i", "missing pnpm 'i' subcommand"],
    ["pnpm update", "missing pnpm 'update' subcommand"],
    ["npm update", "missing npm 'update' subcommand"],
    [
      "sed --in-place 's/a/b/' file.txt",
      "long-form --in-place flag not matched",
    ],
    ["sudo rm -rf /tmp/x", "sudo prefix hides the real mutating command"],
    ["env FOO=bar rm file.txt", "env prefix hides the real mutating command"],
    ["xargs rm", "xargs prefix hides the real mutating command"],
    [
      "bash -c 'rm -rf /tmp/x'",
      "nested shell command via bash -c is not inspected",
    ],
    ["find . -name '*.tmp' -delete", "find -delete is not recognized"],
    ["find . -type f -exec rm {} \\;", "find -exec is not recognized"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it("mentions the real command hidden behind a sudo prefix in the reason", () => {
    const verdict = guard.classifyBashCommand("sudo rm -rf /tmp/x");
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/rm/);
  });
});

describe("classifyBashCommand -- must stay allowed", () => {
  it.each([
    "git log --oneline",
    "pnpm list",
    "find . -name '*.ts'",
    "echo hello",
  ])("allows %s", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- quoted '>' is not a redirect", () => {
  it.each([
    ['grep -rn "=> {" src', "quoted arrow inside double quotes"],
    ["grep -rn '=> {' src", "quoted arrow inside single quotes"],
    ['git log --format="%h > %s"', "quoted '>' inside a --format value"],
    ['echo "a > b"', "quoted '>' inside an echoed string"],
    ['rg "x >> y" src', "quoted '>>' inside a search pattern"],
  ])("allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it.each([
    ["echo x > out.txt", "an unquoted redirect"],
    ['echo "a > b" > out.txt', "a real redirect following a quoted decoy"],
    ['echo x > "out.txt"', "a redirect to a quoted target"],
    ["echo x >> 'log.txt'", "an appending redirect to a quoted target"],
    [
      "echo x > /dev/null > real.txt",
      "a real redirect following a discard-target decoy",
    ],
  ])("still blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each(["echo x > /dev/null", 'echo x > "/dev/null"'])(
    "still allows %s (redirect to the discard target)",
    (command) => {
      expect(guard.classifyBashCommand(command).blocked).toBe(false);
    },
  );
});

describe("classifyBashCommand -- read-only git forms", () => {
  it.each([
    "git branch",
    "git branch --show-current",
    "git branch --list",
    "git branch -a",
    "git branch -r",
    "git branch -vv",
    "git branch --merged main",
    "git worktree list",
    "git worktree list --porcelain",
    "git stash list",
    "git stash show -p",
    "git config --get user.name",
    "git config --list",
    "git tag",
    "git tag -l 'v*'",
    "git tag --list",
    "git -C /tmp branch --show-current",
  ])("allows %s", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it.each([
    "git branch foo",
    "git branch -d foo",
    "git branch -D foo",
    "git branch -m a b",
    "git worktree add ../x",
    "git worktree remove x",
    "git stash",
    "git stash push",
    "git stash pop",
    "git stash drop",
    "git config user.name x",
    "git config --unset user.name",
    "git config --global --add a b",
    "git tag v1",
    "git tag -d v1",
    "git -C /tmp branch foo",
  ])("still blocks %s", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });
});

describe("classifyBashCommand -- formatter/fixer scripts", () => {
  it.each([
    ["pnpm format", "the pnpm 'format' script"],
    ["pnpm run format", "the pnpm 'run format' script"],
    ["pnpm lint:fix", "the pnpm 'lint:fix' script"],
    ["pnpm run lint:fix", "the pnpm 'run lint:fix' script"],
    ["prettier --write .", "prettier's --write flag"],
    ["prettier -w src", "prettier's short -w flag"],
    ["pnpm exec prettier --write x", "prettier --write run through pnpm exec"],
    ["eslint --fix .", "eslint's --fix flag"],
    ["pnpm exec eslint --fix src", "eslint --fix run through pnpm exec"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    "pnpm format:check",
    "pnpm run format:check",
    "prettier --check .",
    "pnpm lint",
    "eslint .",
    "pnpm test",
    "pnpm exec vitest run",
    "pnpm run test:coverage",
  ])("still allows %s", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git branch: verbose/list flags don't turn a positional into a pattern", () => {
  it.each([
    [
      "git branch -v newb1",
      "-v does not turn a following positional into a listing pattern",
    ],
    [
      "git branch -vv newb5",
      "-vv does not turn a following positional into a listing pattern",
    ],
    [
      "git branch --verbose newb",
      "--verbose does not turn a following positional into a listing pattern",
    ],
    [
      "git branch -a foo",
      "-a plus a positional is a create-mode branch name, not a pattern (fatal in real git, must still block)",
    ],
    [
      "git branch -r foo",
      "-r plus a positional is a create-mode branch name, not a pattern (fatal in real git, must still block)",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    "git branch -v",
    "git branch -vv",
    "git branch -a",
    "git branch -r",
    "git branch --list 'feat/*'",
    "git branch -l 'feat/*'",
    "git branch --merged main",
    "git branch --no-merged main",
    "git branch --contains abc123",
    "git branch --points-at HEAD",
    "git branch --sort=-committerdate",
    "git branch --format='%(refname:short)'",
    "git branch --show-current",
    "git branch --color=never -a",
  ])("still allows %s", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git branch: unique-prefix/inline-value/bundled flags still mutate", () => {
  it.each([
    ["git branch -uorigin/main", "bundled short flag -u with an inline value"],
    [
      "git branch --set-upstream-to=origin/main",
      "long flag with an inline =value",
    ],
    ["git branch --unset", "unique prefix of --unset-upstream"],
    ["git branch --unset-upstream", "the full --unset-upstream flag"],
    ["git branch --edit-desc", "unique prefix of --edit-description"],
    ["git branch --edit-description", "the full --edit-description flag"],
    ["git branch --track=direct", "--track with an inline =value"],
    ["git branch --no-track", "the full --no-track flag"],
    ["git branch -f", "the force flag alone"],
    ["git branch --copy", "the full --copy flag"],
    ["git branch --delete", "the full --delete flag"],
  ])(
    "blocks %s -- an unrecognized-or-mutating flag on git branch blocks (%s)",
    (command) => {
      expect(guard.classifyBashCommand(command).blocked).toBe(true);
    },
  );
});

describe("classifyBashCommand -- backslash-escaped quotes must not hide a redirect", () => {
  it.each([
    [
      `echo \\" > out \\"`,
      "a backslash-escaped double quote is not a real quote delimiter and must not swallow the redirect that follows",
    ],
    [
      `echo it\\'s > out \\'`,
      "a backslash-escaped single quote inside an unquoted word must not swallow the redirect that follows",
    ],
    [
      `cat f \\">\\" x`,
      "a bare redirect sandwiched between two backslash-escaped quotes must still be detected",
    ],
    [
      `echo x "\\"" > out "`,
      "an escaped quote inside a real quoted argument must not desync quote matching and hide the redirect that follows",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each(['echo "x" >"$f"', "echo 'a'>'b'", 'echo "x > out'])(
    "still blocks %s (redirect regression)",
    (command) => {
      expect(guard.classifyBashCommand(command).blocked).toBe(true);
    },
  );

  it.each(['echo "a > b"', 'grep "=> {" src'])(
    "still allows %s (quoted '>' regression)",
    (command) => {
      expect(guard.classifyBashCommand(command).blocked).toBe(false);
    },
  );
});

describe("classifyBashCommand -- pnpm run: a value-taking flag doesn't hide the script name", () => {
  it.each([
    [
      "pnpm run --filter x format",
      "a value-taking flag between 'run' and the script name must not be mistaken for the script itself",
    ],
    [
      "pnpm --filter x run format",
      "a value-taking global flag before 'run' must not hide the mutating script that follows",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it("still allows pnpm run --filter x format:check", () => {
    expect(
      guard.classifyBashCommand("pnpm run --filter x format:check").blocked,
    ).toBe(false);
  });
});

describe("classifyBashCommand -- fixers reachable via script/bin/dlx/npx shorthand", () => {
  it.each([
    ["pnpm lint --fix", "a --fix flag passed through a pnpm script shorthand"],
    ["pnpm run lint --fix", "a --fix flag passed through pnpm run <script>"],
    ["pnpm eslint --fix .", "eslint run via the pnpm <bin> shorthand"],
    ["pnpm prettier --write .", "prettier run via the pnpm <bin> shorthand"],
    ["pnpm dlx prettier --write .", "prettier run via pnpm dlx"],
    [
      "npx -p somepkg prettier --write .",
      "npx's own value-taking -p flag hides the real tool (prettier) behind its value",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    "pnpm lint",
    "pnpm dlx prettier --check .",
    "pnpm prettier --check .",
  ])("still allows %s", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git -c config injection", () => {
  it.each([
    [
      "git -c core.pager='rm -rf x' branch --list",
      "-c core.pager overrides the pager with an arbitrary command",
    ],
    [
      "git -c alias.st='!rm -rf x' st",
      "-c alias.* defines a shell-escaping alias",
    ],
    ["git -c core.editor=vim log", "-c core.editor overrides the editor"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each(["git -c color.ui=never log", "git -c core.abbrev=12 log --oneline"])(
    "still allows %s (a harmless -c override)",
    (command) => {
      expect(guard.classifyBashCommand(command).blocked).toBe(false);
    },
  );
});

describe("classifyBashCommand -- a redirect nested inside a quoted command substitution must still block", () => {
  // Double quotes do not stop the shell from parsing `$(...)`/backtick command
  // substitution -- a `>` inside one is a REAL redirect run by the inner
  // subshell, not a literal argument character, so blanking the whole
  // double-quoted span (done to protect a literal `=> {`/`a > b` from being
  // misread as a redirect) must not also blank a redirect that's actually
  // inside a substitution.
  it.each([
    [
      'echo "$(date > out)"',
      "a redirect inside a $(...) command substitution nested in double quotes",
    ],
    [
      'echo "`date > out`"',
      "a redirect inside a backtick command substitution nested in double quotes",
    ],
    [
      'echo "a $(printf x >> log) b"',
      "an appending redirect inside a $(...) substitution surrounded by literal text",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ['echo "a > b"', "a literal '>' with no substitution at all"],
    ['grep "=> {" src', "a literal '=>' with no substitution at all"],
    ['echo "$HOME"', "a plain variable expansion, no command substitution"],
    [
      'echo "$(date)"',
      "a command substitution present but with no redirect inside it",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- ANSI-C quoting ($'...') must not desync quote pairing and hide a redirect", () => {
  it.each([
    [
      String.raw`echo $'\'' > out #'`,
      "an escaped single quote inside $'...' ANSI-C quoting is mismatched by the plain single-quote pairing regex, which then swallows the real redirect that follows as if it were quoted content",
    ],
    [
      "echo $'a' > out",
      "a redirect following a simple, correctly-paired $'...' ANSI-C-quoted argument",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it("still allows echo $'a\\tb' (no redirect present)", () => {
    expect(guard.classifyBashCommand("echo $'a\\tb'").blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git separated-value flags must not hide the real subcommand or an exec-key override", () => {
  it.each([
    [
      "FOO='!touch pwn1' git --config-env alias.x=FOO x",
      "a quoted leading env assignment ahead of --config-env still resolves to git running a command-executing alias",
    ],
    [
      "git --config-env foo=BAR commit -m x",
      "--config-env's separated value is mistaken for the subcommand, hiding the real mutating 'commit' subcommand behind it",
    ],
    [
      "git --attr-source HEAD commit -m x",
      "--attr-source's separated value is mistaken for the subcommand, hiding the real mutating 'commit' subcommand behind it",
    ],
    [
      "git --super-prefix p/ commit -m x",
      "--super-prefix's separated value is mistaken for the subcommand, hiding the real mutating 'commit' subcommand behind it",
    ],
    [
      "git --config-env alias.x=FOO x",
      "--config-env alias.x indirects an exec-key override through an env var, same as -c alias.x=...",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    [
      "git --config-env core.abbrev=X log",
      "core.abbrev is not on the exec-key denylist and 'log' is not a mutating subcommand",
    ],
    [
      "git --attr-source HEAD log",
      "--attr-source is unrelated to config-key execution and 'log' is not a mutating subcommand",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- npm/pnpm exec-family wrappers must reach the wrapped fixer", () => {
  it.each([
    ["npm exec -- prettier --write .", "npm exec with a -- separator"],
    ["npm exec prettier --write .", "npm exec without a -- separator"],
    ["npm x prettier --write .", "npm's 'x' alias for exec"],
    [
      "pnpm exec -- eslint --fix",
      "pnpm exec's own -- separator is not stripped before judging the wrapped tool",
    ],
    ["pnpx prettier --write .", "the pnpx binary, a synonym for pnpm dlx"],
    ["npm exec -- eslint --fix src", "npm exec wrapping eslint --fix"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["npm exec -- prettier --check .", "prettier --check is not a write flag"],
    ["npm x eslint .", "eslint with no --fix flag"],
    ["pnpm exec -- vitest run", "vitest is not a fixer-capable tool"],
    [
      "npx -- prettier --check .",
      "npx's own -- separator, prettier --check is not a write flag",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git-executing env vars set as prefix assignments must still block", () => {
  it.each([
    [
      "GIT_EXTERNAL_DIFF=touch git diff",
      "GIT_EXTERNAL_DIFF makes git run an arbitrary command as its diff driver",
    ],
    [
      "GIT_PAGER=sh git log",
      "GIT_PAGER makes git run an arbitrary command as its pager",
    ],
    [
      "GIT_EDITOR=vim git log",
      "GIT_EDITOR makes git run an arbitrary command as its editor",
    ],
    [
      "GIT_SSH_COMMAND=x git fetch",
      "GIT_SSH_COMMAND makes git run an arbitrary command for transport",
    ],
    [
      "GIT_CONFIG_PARAMETERS=\"'core.pager=x'\" git log",
      "GIT_CONFIG_PARAMETERS injects an exec-key config override the same way -c/--config-env do",
    ],
    [
      "GIT_CONFIG_COUNT=1 git log",
      "GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0 is another env-var route to a config override",
    ],
    [
      "env GIT_PAGER=sh git log",
      "prefixing with the env verb must not let GIT_PAGER escape scrutiny",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    [
      "GIT_DIR=.git git log",
      "GIT_DIR only points at a repo location, it does not execute anything",
    ],
    [
      "LC_ALL=C git log",
      "a locale env var is unrelated to git's own env-var exec surface",
    ],
    [
      "FOO=bar git log --oneline",
      "an arbitrary, non-GIT_* env assignment is not on the denylist",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("readOnlyAgentNames -- frontmatter parsing gaps", () => {
  let agentsDir: string;

  afterAll(() => {
    if (agentsDir) rmSync(agentsDir, { recursive: true, force: true });
  });

  it("finds an agent whose frontmatter uses CRLF line endings throughout", () => {
    agentsDir = mkdtempSync(join(tmpdir(), "guard-agents-crlf-"));
    writeFileSync(
      join(agentsDir, "some-agent.md"),
      "---\r\nname: some-agent\r\ndescription: x\r\n---\r\n\r\nBody.\r\n",
    );
    expect(guard.readOnlyAgentNames(agentsDir).has("some-agent")).toBe(true);
  });

  it("strips quote characters from a quoted name value", () => {
    agentsDir = mkdtempSync(join(tmpdir(), "guard-agents-quoted-"));
    writeFileSync(
      join(agentsDir, "some-agent.md"),
      '---\nname: "some-agent"\ndescription: x\n---\n\nBody.\n',
    );
    const names = guard.readOnlyAgentNames(agentsDir);
    expect(names.has("some-agent")).toBe(true);
    expect(names.has('"some-agent"')).toBe(false);
  });
});

// PR #83 review findings (5): the fixer-write check, the `git tag` list-mode
// check, `--fix-dry-run`, the git exec-config-key denylist, and a `|` inside a
// quoted pattern each have a gap the automated reviewer found and the hook's
// own author confirmed against real git/the hook's own source. These describe
// blocks pin the CORRECT contract, not what `classifyBashCommand` does today
// -- some assertions below are expected to fail until the hook is fixed.

describe("classifyBashCommand -- version-pinned wrapped tools must not evade the fixer check", () => {
  // `fixerWriteFlag` compares the resolved verb to the literal strings
  // "prettier"/"eslint". A version-pinned invocation (`prettier@3`,
  // `eslint@latest`) resolves to a verb that never equals either literal, so
  // the write-flag check silently never fires -- the mutating command runs
  // right through the guard.
  it.each([
    ["npx prettier@3 --write .", "a pinned major version on prettier"],
    ["pnpm dlx prettier@latest --write .", "the 'latest' dist-tag on prettier"],
    ["npx eslint@9 --fix src", "a pinned major version on eslint"],
    [
      "npm exec -- prettier@3.3.0 -w src",
      "a full pinned version through npm exec --",
    ],
    ["pnpm exec eslint@9 --fix", "a pinned version through pnpm exec"],
    ["pnpx prettier@3 --write .", "a pinned version through the pnpx binary"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["npx prettier@3 --check .", "a pinned version with only a read-only flag"],
    ["pnpm dlx eslint@9 .", "a pinned version with no fixer flag at all"],
    [
      "npx @scope/tool@1 --check",
      "a scoped, version-pinned package name with no fixer flag",
    ],
    ["npx vitest@4 run", "a pinned version on a non-fixer tool"],
    [
      "npx @scope/tool@1 --write",
      "a scoped, version-pinned UNKNOWN tool must not be mangled into matching prettier/eslint -- only the two known fixers are judged",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git tag: a value-taking flag must not let its consumed value be mistaken for -l", () => {
  // `git tag`'s read-only form today checks `args.includes("-l")` literally,
  // ignoring that a value-taking flag (`--format`, `--sort`) consumes the
  // NEXT token as its own value -- so `--format -l v2` is real git's create
  // mode (verified: it actually created tag "v2"), yet the guard sees a
  // literal "-l" token and calls it read-only. The correct contract treats
  // `git tag` as allowlist-style, the same as `git branch`: every flag must
  // be a known read-only flag, a value-taking flag consumes its separated
  // value token, and a bare positional is only legitimate when a
  // pattern-taking flag (-l/--list, --contains, --no-contains, --points-at,
  // --merged, --no-merged) is also present.
  it.each([
    [
      "git tag --format -l v2",
      "--format consumes '-l' as its value, leaving 'v2' as a real create-mode positional (verified against real git: this creates tag v2)",
    ],
    [
      "git tag --sort -l v1",
      "--sort consumes '-l' as its value, leaving 'v1' as a stray positional with no list-mode flag present (a fatal usage error in real git, but not one this guard can assume is safe)",
    ],
    [
      "git tag --format '%(refname)' v3",
      "a positional tag name with no list-mode flag present at all",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["git tag", "no arguments at all"],
    ["git tag -l", "the short list flag alone"],
    ["git tag -l 'v*'", "the short list flag with a pattern"],
    ["git tag --list 'v*'", "the long list flag with a pattern"],
    [
      "git tag --sort=-v:refname -l",
      "an inline '=value' sort flag alongside -l",
    ],
    [
      "git tag --sort=-v:refname",
      "an inline '=value' sort flag with no positional at all",
    ],
    [
      "git tag --format='%(refname)' -l",
      "an inline '=value' format flag alongside -l",
    ],
    [
      "git tag --contains abc123",
      "a read-only pattern-taking listing flag (currently a false positive)",
    ],
    [
      "git tag --points-at HEAD",
      "a read-only pattern-taking listing flag (currently a false positive)",
    ],
    [
      "git tag --merged main",
      "a read-only pattern-taking listing flag (currently a false positive)",
    ],
    [
      "git tag --no-merged main",
      "a read-only pattern-taking listing flag (currently a false positive)",
    ],
    [
      "git tag -l --sort -creatordate",
      "--sort's separated value looks flag-shaped but is legitimately consumed as a value, not a stray positional",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- eslint --fix-dry-run does not write files", () => {
  // `fixerWriteFlag` matches any token starting with "--fix-", which also
  // matches `--fix-dry-run` (a report-only flag that never writes) and
  // `--fix-type` used WITHOUT `--fix` (a no-op on its own, since --fix-type
  // only narrows which rules --fix is allowed to touch).
  it.each([
    ["eslint --fix-dry-run .", "--fix-dry-run only reports, it never writes"],
    [
      "pnpm exec eslint --fix-dry-run src",
      "--fix-dry-run run through pnpm exec still never writes",
    ],
    [
      "eslint --fix-type layout .",
      "--fix-type alone (no --fix present) is a no-op",
    ],
  ])("allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it.each([
    ["eslint --fix .", "the real --fix flag, which does write"],
    [
      "eslint --fix-type layout --fix .",
      "--fix-type alongside an actual --fix must still block",
    ],
  ])("still blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });
});

describe("classifyBashCommand -- more git exec-config keys must block via -c", () => {
  // GIT_EXEC_CONFIG_KEY's denylist misses several real command-executing
  // config keys: a diff/merge driver command, a filter's clean/smudge/process
  // command, a remote's upload-pack/receive-pack override, and a
  // difftool/mergetool's cmd -- each runs an arbitrary shell command exactly
  // like the pager/editor/alias keys the guard already recognizes.
  it.each([
    "diff.astextplain.command",
    "filter.lfs.clean",
    "filter.lfs.smudge",
    "filter.lfs.process",
    "merge.foo.driver",
    "remote.origin.uploadpack",
    "remote.origin.receivepack",
    "difftool.x.cmd",
    "mergetool.x.cmd",
  ])("blocks git -c %s=x log", (key) => {
    expect(guard.classifyBashCommand(`git -c ${key}=x log`).blocked).toBe(true);
  });

  it.each([
    ["git -c diff.algorithm=patience diff", "diff.algorithm runs nothing"],
    [
      "git -c merge.conflictstyle=diff3 log",
      "merge.conflictstyle runs nothing",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- a pipe inside a quoted pattern is not a segment separator", () => {
  // `segments()` splits a command on a bare `|` BEFORE any quote handling
  // runs, so a `|` that's actually inside a quoted argument (a regex
  // alternation, not a shell pipe) still splits the command into two
  // fragments. The tail fragment can then contain a stray `>` left over from
  // the split (e.g. the `=>` in `"a|=>"`), which the redirect scan
  // misreads as a real redirect to an empty-string target and blocks.
  it.each([
    [
      'grep -E "a|=>" src',
      "a '|' inside a double-quoted regex alternation, followed by a literal '=>' whose trailing '>' is mistaken for a redirect once the quoted string is incorrectly split",
    ],
    ["rg 'foo|bar' src", "a '|' inside a single-quoted search pattern"],
  ])("allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it.each([
    ['echo "a|b" > out', "a quoted '|' followed by a REAL redirect"],
    ["cat f | tee out", "a real, unquoted pipe into a mutating command"],
    ["grep x f | rm y", "a real, unquoted pipe into a mutating command"],
  ])("still blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });
});

// PR #83 review findings (round 3, second bot review): a nested `bash -c`/
// `sh -c` is never unwrapped once it sits behind a wrapper (`pnpm exec`), a
// prefix verb (`env`/`sudo`/`xargs`/`command`), a leading env assignment, or
// is spelled with a combined short flag (`-lc`) or an unrecognized shell
// (`zsh`/`dash`); `npx`/`npm exec`/`pnpm exec`/`pnpm dlx`'s own shell-mode
// flags (`-c`, `--call`, `--shell-mode`) hand their payload to a shell rather
// than treating it as a tool name to recurse into, so the payload is judged
// (if at all) as a garbled, quote-mangled "tool name" instead of as the shell
// command it actually is; more git config-indirection surfaces
// (`-c include.path=`/`-c includeIf...path=`, the `GIT_CONFIG*` family of env
// vars) are missing from both denylists; and git's modern `config get`/
// `config list`/`config set`/`config unset` subcommand spellings (git
// >=2.46) are not recognized by the read-only exemption at all, which only
// checks for the legacy `--get`/`--list` flag forms -- so a read-only modern
// invocation is currently blocked as a false positive. Verified against the
// pushed hook: every "MUST BLOCK" case below currently classifies as
// allowed, and every "currently a false positive" case below currently
// classifies as blocked.

describe("classifyBashCommand -- a nested shell must be unwrapped behind a wrapper, prefix verb, or altered spelling", () => {
  it.each([
    [
      'pnpm exec bash -c "rm -rf src"',
      "a nested bash -c hidden behind the pnpm exec wrapper",
    ],
    ["env bash -c 'rm x'", "a nested bash -c hidden behind the env prefix"],
    ["sudo sh -c 'rm x'", "a nested sh -c hidden behind the sudo prefix"],
    ["xargs sh -c 'rm x'", "a nested sh -c hidden behind the xargs prefix"],
    [
      "command bash -c 'rm x'",
      "a nested bash -c hidden behind the command prefix",
    ],
    [
      "FOO=1 bash -c 'rm x'",
      "a nested bash -c hidden behind a leading env assignment",
    ],
    ["npx bash -c 'rm x'", "a nested bash -c hidden behind the npx wrapper"],
    [
      "bash -lc 'rm x'",
      "a combined short flag (-lc) is not recognized as bash's -c",
    ],
    [
      "sh -c 'ls; rm x'",
      "a chain operator inside the nested payload must still surface the mutating half",
    ],
    ["zsh -c 'rm x'", "zsh is not recognized as a nested-shell prefix at all"],
    [
      "dash -c 'rm x'",
      "dash is not recognized as a nested-shell prefix at all",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    [
      'pnpm exec bash -c "ls src"',
      "a read-only nested payload behind the pnpm exec wrapper",
    ],
    [
      "env sh -c 'git log --oneline'",
      "a read-only nested payload behind the env prefix",
    ],
    ["bash -c 'echo hi'", "a bare, read-only bash -c payload"],
    ["sudo sh -c 'cat file'", "a read-only nested payload behind sudo"],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- npx/npm/pnpm wrapper shell-mode flags hand their payload to a shell", () => {
  it.each([
    [
      'npx -c "rm -rf src"',
      "npx's own -c flag runs its payload as a shell command",
    ],
    [
      "npm exec -c 'rm x'",
      "npm exec's own -c flag runs its payload as a shell command",
    ],
    [
      "npm exec --call 'rm x'",
      "npm exec's own --call flag runs its payload as a shell command",
    ],
    [
      "pnpm dlx -c 'rm x'",
      "pnpm dlx's own -c flag runs its payload as a shell command",
    ],
    [
      "pnpm exec -c 'rm x'",
      "pnpm exec's own -c flag runs its payload as a shell command",
    ],
    [
      "pnpm exec --shell-mode 'rm x'",
      "pnpm exec's own --shell-mode flag runs its payload as a shell command",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ['npx -c "ls"', "npx -c with a read-only payload"],
    [
      "pnpm exec -c 'git status'",
      "pnpm exec -c with a payload classified as a shell command; the read-only payload stays allowed",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- more git config-indirection surfaces must block", () => {
  it.each([
    [
      "git -c include.path=/tmp/x log",
      "-c include.path pulls in an arbitrary config file, which can itself set core.pager/alias.*",
    ],
    [
      "git -c includeIf.gitdir:/a/.path=/tmp/x log",
      "-c includeIf...path is the same indirection, conditioned on the gitdir",
    ],
    [
      "GIT_CONFIG_GLOBAL=/tmp/x git log",
      "GIT_CONFIG_GLOBAL points git's global config at an arbitrary file",
    ],
    [
      "GIT_CONFIG_SYSTEM=/tmp/x git log",
      "GIT_CONFIG_SYSTEM points git's system config at an arbitrary file",
    ],
    [
      "GIT_CONFIG=/tmp/x git log",
      "GIT_CONFIG points git's config at an arbitrary file",
    ],
    [
      "GIT_CONFIG_NOSYSTEM=0 GIT_CONFIG_SYSTEM=/x git log",
      "GIT_CONFIG_SYSTEM still indirects even alongside an unrelated assignment",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["GIT_DIR=.git git log", "GIT_DIR only points at a repo location"],
    ["git -c color.ui=never log", "a harmless -c override"],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- git's modern 'config get'/'config list' subcommand spellings are read-only", () => {
  // The read-only exemption for `git config` only recognizes the legacy
  // `--get`/`--get-all`/`--list`/`-l` FLAG forms. Git >=2.46 also accepts
  // `get`/`set`/`list`/`unset`/`edit` as explicit SUBCOMMANDS
  // (`git config get user.name`), which the exemption's GIT_CONFIG_READ set
  // never matches -- so a read-only modern invocation currently falls
  // through to the generic "config is a mutating subcommand" block.
  it.each([
    [
      "git config get user.name",
      "the modern 'config get' subcommand reads a single value (currently a false positive)",
    ],
    [
      "git config list",
      "the modern 'config list' subcommand reads everything (currently a false positive)",
    ],
    [
      "git config list --show-origin",
      "'config list' with a read-only display flag (currently a false positive)",
    ],
    [
      "git config get --all user.name",
      "'config get --all' reads every value for a key (currently a false positive)",
    ],
  ])("allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it.each([
    ["git config set user.name x", "the modern 'config set' subcommand writes"],
    [
      "git config unset user.name",
      "the modern 'config unset' subcommand writes",
    ],
    ["git config edit", "the modern 'config edit' subcommand opens an editor"],
    [
      "git config rename-section a b",
      "the modern 'config rename-section' subcommand writes",
    ],
    [
      "git config remove-section a",
      "the modern 'config remove-section' subcommand writes",
    ],
    ["git config user.name x", "the legacy 'config <key> <value>' write form"],
  ])("still blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });
});

// PR #83 review findings (round 4): a quoted or escaped command word is never
// unquoted before verb/subcommand matching. `baseName` (and therefore every
// verb/subcommand comparison in `classifyTokens`) compares the RAW token text,
// so `"rm" x`, `'rm' -rf x`, `rm"" x`, `r"m" x` and `r\m x` -- every one of
// which bash actually runs as a plain `rm` invocation once its own quoting is
// resolved -- compare a quoted/escaped string against the literal "rm" and
// never match, silently letting the mutating command through. The same gap
// hides a quoted git/pnpm subcommand (`git "commit" -m x`, `git 'branch'
// foo`, `git "push"`, `pnpm "install"`), a quoted verb itself (`"git" commit
// -m x`), a quoted real command behind a prefix verb (`sudo "rm" x`, `env
// 'rm' x`), a quoted shell name so a nested `-c` payload is never unwrapped at
// all (`"bash" -c 'rm x'`, `'sh' -c "rm x"`), a quoted verb INSIDE an
// already-unwrapped nested payload (`bash -c '"rm" x'`, `bash -c "'rm' x"`), a
// quoted tool name behind npx/pnpm exec (`npx "prettier" --write .`, `pnpm
// exec 'eslint' --fix`), a quoted fixer verb run directly (`"prettier"
// --write .`), a quoted git config key, and a quoted `sed -i` flag. Two
// further cases fail CLOSED rather than open, per this hook's own established
// pattern of blocking rather than guessing when a word cannot be read (see
// `classifyNestedCommand`'s "whose command string could not be read"): a verb
// using `$'...'` ANSI-C quoting and a verb with an unterminated quote can
// neither be statically unquoted, so they must block rather than silently
// compare as a literal mismatch and pass. Verified against the pushed hook:
// every "MUST BLOCK" case below currently classifies as allowed.
describe("classifyBashCommand -- quoted/escaped verb words must be unquoted before matching", () => {
  it.each([
    ['"rm" x', "a double-quoted verb"],
    ["'rm' -rf x", "a single-quoted verb"],
    [
      'rm"" x',
      "a verb followed by an empty double-quoted span, still literally rm once unquoted",
    ],
    ['r"m" x', "a verb split across an unquoted and a quoted span"],
    [
      String.raw`r\m x`,
      "a verb with a backslash-escaped character, still literally rm once unescaped",
    ],
    ['git "commit" -m x', "a quoted git subcommand"],
    ["git 'branch' foo", "a single-quoted git subcommand"],
    ['git "push"', "a quoted git subcommand with no further arguments"],
    ['pnpm "install"', "a quoted pnpm subcommand"],
    ['"git" commit -m x', "a quoted git verb itself"],
    ['sudo "rm" x', "a quoted real command hidden behind the sudo prefix"],
    ["env 'rm' x", "a quoted real command hidden behind the env prefix"],
    [
      `"bash" -c 'rm x'`,
      "a quoted shell name -- its nested -c payload must still be unwrapped",
    ],
    [
      `'sh' -c "rm x"`,
      "a single-quoted shell name -- its nested -c payload must still be unwrapped",
    ],
    [
      `bash -c '"rm" x'`,
      "a quoted verb inside an already-unwrapped nested -c payload",
    ],
    [
      `bash -c "'rm' x"`,
      "a single-quoted verb inside an already-unwrapped nested -c payload",
    ],
    ['npx "prettier" --write .', "a quoted tool name behind npx"],
    ["pnpm exec 'eslint' --fix", "a quoted tool name behind pnpm exec"],
    ['"prettier" --write .', "a quoted fixer verb run directly"],
    ['git config "user.name" x', "a quoted git config key"],
    ['sed "-i" s/a/b/ f', "a quoted sed -i flag"],
    [
      "$'rm' x",
      "an ANSI-C-quoted verb that cannot be statically unquoted -- fails closed",
    ],
    [
      '"rm x',
      "an unterminated-quote verb that cannot be statically unquoted -- fails closed",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ['"git" log --oneline', "a quoted read-only git verb"],
    ["'git' status", "a single-quoted read-only git verb"],
    ['git "log" --oneline', "a quoted read-only git subcommand"],
    ['git diff "a b.ts"', "a quoted argument, not the verb or subcommand"],
    ['cat "a b.txt"', "a quoted argument to a non-mutating verb"],
    ["ls -la 'dir with spaces'", "a quoted argument with embedded spaces"],
    ['grep -rn "foo bar" src', "a quoted search pattern"],
    ['echo "rm x"', "quoted text is an argument to echo, not a command to run"],
    [
      "echo 'git commit'",
      "quoted text is an argument to echo, not a git invocation",
    ],
    ['git log --format="%h %s"', "a quoted --format value"],
    [
      'FOO="a b" pnpm test',
      "a quoted env-assignment value ahead of a non-mutating verb",
    ],
    ["bash script.sh", "an unquoted script operand, not a -c payload"],
    [`"bash" -c 'ls'`, "a quoted shell name whose nested payload is read-only"],
    [
      `bash -c '"ls" src'`,
      "a quoted verb inside a nested payload that is read-only",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

// PR #83 review findings (round 5, third bot review): a shell reserved word
// or grouping construct (`for`/`if`/`while`/`{ ... }`/`(...)`/`!`/`time`)
// sitting immediately before the real command becomes the "verb"
// `classifyTokens` inspects, so the mutating command hidden after it (`do
// rm -rf src`, `then rm x`) is never reached; a lone `&` background
// operator is not recognized as a chain operator at all, so two commands
// separated only by `&` are read as a single segment whose first word is
// the harmless one; `>&word` (writing both stdout AND stderr to a file,
// when `word` is not an fd digit or `-`) is not recognized as a
// file-writing redirect at all; pnpm's own shell-mode flags (`-c`/
// `--shell-mode`) spelled BEFORE `exec` (rather than after it) are not
// unwrapped, and a wrapped tool name containing whitespace after unquoting
// (`npx "rm -rf src"`) is read as a literal (if unusual) package name
// rather than recognized as a command string masquerading as one; and `git
// tag -n`/`-n<digits>` is not on GIT_TAG_READ_FLAGS' pattern-taking list,
// so a read-only listing invocation is wrongly blocked. Verified against
// the pushed hook: every "MUST BLOCK"/"MUST BE ALLOWED" case below
// currently classifies the opposite way.

describe("classifyBashCommand -- a shell reserved word/grouping construct before the real command must not hide it", () => {
  it.each([
    ["for f in x; do rm -rf src; done", "a for-loop body running rm"],
    [
      "for f in a b; do git commit -m x; done",
      "a for-loop body running git commit",
    ],
    ["if rm x; then echo ok; fi", "an if-condition running rm"],
    ["while true; do rm x; done", "a while-loop body running rm"],
    ["{ rm -rf src; }", "a brace group running rm"],
    ["(rm -rf src)", "a subshell running rm"],
    ["( cd src && rm x )", "a subshell chaining into rm"],
    ["! rm x", "a negated rm"],
    ["time rm x", "rm timed via the time builtin/keyword"],
    [
      "if true; then rm x; else echo; fi",
      "rm in an if's then-branch alongside an else clause",
    ],
    ["echo a && { rm x; }", "a brace group hiding rm behind a chain operator"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["for f in a b; do echo $f; done", "a for-loop body that only echoes"],
    [
      "if git diff --quiet; then echo clean; fi",
      "an if-condition running a read-only git command",
    ],
    ["(git log --oneline)", "a subshell running a read-only git command"],
    ["{ git status; }", "a brace group running a read-only git command"],
    ["! git diff --quiet", "a negated read-only git command"],
    ["time git log", "a read-only git command timed via the time keyword"],
    ['while read l; do echo "$l"; done', "a while-loop body that only echoes"],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- a lone '&' background operator separates commands", () => {
  it.each([
    ["true & rm -rf src", "a backgrounded command followed by rm"],
    ["sleep 1 & rm x", "a backgrounded sleep followed by rm"],
    ["echo a &rm x", "a lone & with no surrounding space before rm"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["echo a 2>&1", "fd duplication, not a background operator"],
    [
      "echo a &> /dev/null",
      "the &> redirect operator to the discard target, not a background operator",
    ],
    [
      "git log 2>&1 | head",
      "fd duplication followed by a real pipe into a read-only command",
    ],
    ['echo "a & b"', "a literal & inside a quoted argument"],
    ["echo a && echo b", "the && chain operator, not a lone &"],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it("still blocks echo a &> out.txt (the &> redirect operator writing to a real file)", () => {
    expect(guard.classifyBashCommand("echo a &> out.txt").blocked).toBe(true);
  });
});

describe("classifyBashCommand -- '>&word' writes stdout+stderr to a file when word is not a fd digit or '-'", () => {
  it.each([
    ["echo x >&out.txt", "no space between >& and the file target"],
    ["echo x >& out.txt", "a space between >& and the file target"],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["echo x >&2", "fd duplication to stderr, no space"],
    ["echo x 2>&1", "fd duplication to stdout"],
    ["echo x >&-", "closing a file descriptor"],
    ["echo x >& /dev/null", "&> to the discard target, with a space"],
    ["echo x >&/dev/null", "&> to the discard target, no space"],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- pnpm's shell-mode flag spelled BEFORE 'exec' must still be inspected", () => {
  it.each([
    ["pnpm -c exec 'rm -rf src'", "the short -c flag before exec"],
    ["pnpm --shell-mode exec 'rm x'", "the long --shell-mode flag before exec"],
    [
      "pnpm -r -c exec 'rm x'",
      "the -c flag alongside an unrelated -r flag before exec",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    ["pnpm -c exec 'git status'", "a read-only payload behind pnpm -c exec"],
    [
      "pnpm -r exec vitest run",
      "an unrelated -r flag before exec, no shell-mode flag at all",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it("blocks a wrapped 'tool' word containing whitespace after unquoting -- that is a command string, not a package name", () => {
    expect(guard.classifyBashCommand('npx "rm -rf src"').blocked).toBe(true);
  });

  it("still allows npx vitest run", () => {
    expect(guard.classifyBashCommand("npx vitest run").blocked).toBe(false);
  });
});

// PR #83 follow-up: the wrapped-tool lookup that fires after `pnpm exec`/
// `pnpm dlx` resolves value-taking flags against FLAGS_WITH_VALUE.npx
// unconditionally (`firstPositionalIndex(tokens, wrapperEnd,
// FLAGS_WITH_VALUE.npx)`), regardless of which wrapper verb is actually in
// play. npx's own flags (`-p`/`--package`) have nothing to do with pnpm's
// (`--filter`/`-F`, `--filter-prod`, `--dir`/`-C`), so `pnpm exec --filter x
// <tool>` never skips `--filter`'s VALUE ("x") the way it needs to -- that
// value is mistaken for the wrapped tool name instead, and the real tool
// (a fixer, or a nested shell payload behind pnpm's own shell-mode flag) is
// never reached. Verified against the pushed hook: every "MUST BLOCK" case
// below (except the pnpm -c/exec ordering case, which the scan already gets
// right by coincidence) currently classifies as allowed.
describe("classifyBashCommand -- pnpm's own value-taking flags after exec/dlx must be judged with pnpm's flag table, not npx's", () => {
  it.each([
    [
      "pnpm -c exec --filter x 'rm y'",
      "pnpm's own shell-mode flag before exec, with --filter's value swallowing the real nested rm payload",
    ],
    [
      "pnpm exec --filter x -c 'rm y'",
      "pnpm's own shell-mode flag placed AFTER --filter's value is never reached because the tool-lookup scan (bounded by npx's flag table) stops too early",
    ],
    [
      "pnpm exec -c --filter x 'rm y'",
      "pnpm's own shell-mode flag placed before --filter folds --filter's own flag+value into the nested payload text, hiding the real rm command inside an unrecognized '--filter x rm y' string",
    ],
    [
      "pnpm --filter x exec -c 'rm y'",
      "--filter as a global flag before exec, with a nested rm nested behind exec's own -c flag",
    ],
    [
      "pnpm exec --filter x prettier --write .",
      "--filter's value ('x') is mistaken for the wrapped tool name, so the real prettier --write is never judged",
    ],
    [
      "pnpm exec -F x eslint --fix",
      "the short -F alias for --filter is not recognized on any flag table, so its value ('x') is mistaken for the wrapped tool name and the real eslint --fix is never judged",
    ],
  ])("blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });

  it.each([
    [
      "pnpm exec --filter x vitest run",
      "--filter's value correctly skipped, vitest is not a fixer-capable tool",
    ],
    [
      "pnpm -c exec --filter x 'git status'",
      "a read-only nested payload behind pnpm -c exec, alongside --filter",
    ],
    [
      "pnpm exec -F x prettier --check .",
      "the short -F alias correctly skipped, prettier --check is not a write flag",
    ],
    [
      "pnpm --filter x exec tsc --noEmit",
      "--filter as a global flag before exec correctly skipped, tsc is not a fixer-capable tool",
    ],
  ])("still allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });
});

describe("classifyBashCommand -- 'git tag -n'/'-n<digits>' is a read-only listing form (implies list mode)", () => {
  it.each([
    ["git tag -n v2", "-n alone, with a pattern positional"],
    [
      "git tag -n3 'v*'",
      "-n with an attached digit count, with a pattern positional",
    ],
  ])("allows %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(false);
  });

  it.each([
    [
      "git tag -n3 -a v1",
      "-n alongside -a (annotate), which is create mode despite -n",
    ],
    ["git tag v2", "a bare positional with no listing flag at all"],
  ])("still blocks %s (%s)", (command) => {
    expect(guard.classifyBashCommand(command).blocked).toBe(true);
  });
});
