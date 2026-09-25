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
