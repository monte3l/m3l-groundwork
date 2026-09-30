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
const repoRoot = join(here, "..", "..", "..");
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
