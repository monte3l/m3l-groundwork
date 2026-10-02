// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "../../src/harness/frontmatter.js";
import { gradeHarness } from "../../src/harness/grade.js";
import { CURRENT_MODELS, RULES } from "../../src/harness/rules.js";
import { chmodIneffective } from "../chmod-ineffective.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesCoreDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "core",
);
const libDir = join(templatesCoreDir, "bin", "lib");

// The emitted twin is plain ESM under templates/, outside every tsconfig, so
// it is loaded by file URL at test time rather than imported statically.
interface EmittedRules {
  gradeHarness: (rootDir: string) => unknown;
  RULES: { id: string; level: string; category: string }[];
  CURRENT_MODELS: string[];
}
interface EmittedFrontmatter {
  parseFrontmatter: (content: string) => unknown;
}

const emitted = (await import(
  pathToFileURL(join(libDir, "harness-rules.mjs")).href
)) as EmittedRules;
const emittedFrontmatter = (await import(
  pathToFileURL(join(libDir, "frontmatter.mjs")).href
)) as EmittedFrontmatter;

/** Reduces to plain JSON so Maps and class instances compare structurally. */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      v instanceof Map ? Object.fromEntries(v as Map<string, unknown>) : v,
    ),
  ) as unknown;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-parity-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTo(dir: string, rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function write(rel: string, content: string): void {
  writeTo(root, rel, content);
}

/**
 * A harness deliberately broken across every rule this file exercises:
 * a dangling hook, an orphan hook, both broken hook-entrypoint forms
 * (`BARE_ENTRY_POINT` and the `.pathname` form -- see H2), a skill with no
 * frontmatter, a skill with no `SKILL.md`, an oversized skill with a dead
 * `references/` link and an over-length description, a mismatched agent
 * with a stale model and no `tools`, an otherwise-valid agent declaring an
 * `mcpServers` entry (`ghost-server`) that neither `.claude/settings.json`'s
 * `enabledPlugins` nor a root `.mcp.json` supplies, a rule with an empty
 * `paths` and a dead glob, a `CLAUDE.md` naming a file that does not exist,
 * and a malformed `.claude/settings.local.json` (H3).
 */
function writeBrokenHarness(dir: string): void {
  const w = (rel: string, content: string): void => writeTo(dir, rel, content);
  w(
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: "node .claude/hooks/gone.mjs" },
            ],
          },
        ],
      },
      // Registered through a top-level command key rather than the local
      // settings file, since settings.local.json below is deliberately
      // unparseable (H3) and must not be relied on for reachability here.
      subagentStatusLine: {
        type: "command",
        command: "node .claude/hooks/registered.mjs",
      },
    }),
  );
  w(
    ".claude/hooks/orphan.mjs",
    "if (process.argv[1] === fileURLToPath(import.meta.url)) {}\n",
  );
  w(
    ".claude/hooks/pathname-broken.mjs",
    "if (realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) main();\n",
  );
  w(".claude/hooks/helper.mjs", "export {};\n");
  w(".claude/hooks/registered.mjs", 'import "./helper.mjs";\n');
  // Deliberately malformed -- H3: this must not be silently treated as
  // absent, and must not make hook-dangling/hook-orphan misreport based on
  // settings.json alone as if this file had no registrations at all.
  w(".claude/settings.local.json", "{ not valid json");
  w(".claude/skills/bare/SKILL.md", "# no frontmatter\n");
  w(".claude/skills/empty/notes.md", "x\n");
  w(
    ".claude/skills/oversized/SKILL.md",
    `---\nname: oversized\ndescription: ${"A".repeat(1100)}\n---\nSee references/missing.md.\n${"line\n".repeat(600)}`,
  );
  w(
    ".claude/agents/a.md",
    "---\nname: b\ndescription: short\nmodel: claude-3-opus\n---\n",
  );
  // Otherwise-valid so it doesn't ALSO trip agentShape/modelPinCurrency/
  // agentToolScope -- the only defect here is the unsupplied mcpServers
  // entry (H4: agent-mcp-source). Neither settings.json's enabledPlugins
  // (there is none above) nor any .mcp.json (none is written) supplies
  // "ghost-server".
  w(
    ".claude/agents/mcp-agent.md",
    "---\nname: mcp-agent\ndescription: Exercises agent-mcp-source with an unsupplied MCP server declaration.\nmodel: sonnet\ntools: Read\nmcpServers: [ghost-server]\n---\n",
  );
  w(".claude/rules/r.md", '---\npaths:\n  - "nowhere/**"\n---\n');
  w(".claude/rules/empty.md", "---\npaths:\n---\nbody\n");
  w("CLAUDE.md", "`.claude/agents/missing.md`\n");
}

describe("the TypeScript grader and its emitted .mjs twin", () => {
  it("declare the same rules, in the same order", () => {
    expect(
      emitted.RULES.map(({ id, level, category }) => ({ id, level, category })),
    ).toEqual(
      RULES.map(({ id, level, category }) => ({ id, level, category })),
    );
  });

  it("agree on which model ids are current", () => {
    expect(emitted.CURRENT_MODELS).toEqual([...CURRENT_MODELS]);
  });

  it("produce identical grades for the real templates/core tree", () => {
    expect(plain(emitted.gradeHarness(templatesCoreDir))).toEqual(
      plain(gradeHarness(templatesCoreDir)),
    );
  });

  it("produce identical grades for a deliberately broken harness", () => {
    writeBrokenHarness(root);

    const ts = gradeHarness(root);
    expect(ts.findings.length).toBeGreaterThan(8);
    expect(plain(emitted.gradeHarness(root))).toEqual(plain(ts));
  });

  it("produce identical grades when settings.json itself is unparseable", () => {
    write(".claude/settings.json", "{ not valid json");
    write(".claude/hooks/guard.mjs", "// a hook, unregistered either way\n");

    const ts = gradeHarness(root);
    expect(ts.findings.map((f) => f.ruleId)).toContain("settings-parses");
    expect(plain(emitted.gradeHarness(root))).toEqual(plain(ts));
  });

  it("exercises every rule id both graders declare, at least once", () => {
    const dirA = mkdtempSync(join(tmpdir(), "harness-parity-coverage-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "harness-parity-coverage-b-"));
    // dirA (writeBrokenHarness) breaks settings.local.json (H3), and dirB
    // breaks settings.json (settings-parses) -- both make hook-dangling and
    // hook-orphan skip (checked: 0) under the fixed rules, since that guard
    // now fires when EITHER settings file fails to parse. dirC keeps both
    // settings files valid/absent so those two rules can actually fail.
    const dirC = mkdtempSync(join(tmpdir(), "harness-parity-coverage-c-"));
    try {
      writeBrokenHarness(dirA);
      writeTo(dirB, ".claude/settings.json", "{ not valid json");
      writeTo(
        dirC,
        ".claude/settings.json",
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { type: "command", command: "node .claude/hooks/gone.mjs" },
                ],
              },
            ],
          },
        }),
      );
      writeTo(dirC, ".claude/hooks/orphan-c.mjs", "// never registered\n");

      const exercised = new Set([
        ...gradeHarness(dirA).findings.map((f) => f.ruleId),
        ...gradeHarness(dirB).findings.map((f) => f.ruleId),
        ...gradeHarness(dirC).findings.map((f) => f.ruleId),
      ]);
      const declared = new Set([
        ...RULES.map((rule) => rule.id),
        ...emitted.RULES.map((rule) => rule.id),
      ]);
      const unexercised = [...declared].filter((id) => !exercised.has(id));
      expect(unexercised, JSON.stringify(unexercised)).toEqual([]);
      expect(exercised.has("hook-dangling")).toBe(true);
      expect(exercised.has("hook-orphan")).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
      rmSync(dirC, { recursive: true, force: true });
    }
  });

  // `agent-mcp-source` (rubric, agents category): for every `mcpServers`
  // entry an agent declares, is that server name "supplied" by either (a) an
  // `enabledPlugins` key in `.claude/settings.json` whose name-before-`@`
  // matches and whose value is exactly `true`, or (b) a root `.mcp.json`'s
  // `mcpServers` object, by key name. Each fixture below is its own temp dir
  // so it isolates cleanly from `writeBrokenHarness`'s H4 case above.
  it("agent-mcp-source: an mcpServers entry is supplied by settings.json's enabledPlugins", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-parity-mcp-a-"));
    try {
      writeTo(
        dir,
        ".claude/agents/consumer.md",
        "---\nname: consumer\ndescription: Declares an mcpServers entry supplied by an enabledPlugins key.\nmodel: sonnet\ntools: Read\nmcpServers: [context7]\n---\n",
      );
      writeTo(
        dir,
        ".claude/settings.json",
        JSON.stringify({
          enabledPlugins: { "context7@claude-plugins-official": true },
        }),
      );

      const ts = gradeHarness(dir);
      expect(
        ts.findings.filter((f) => f.ruleId === "agent-mcp-source"),
      ).toEqual([]);
      expect(plain(emitted.gradeHarness(dir))).toEqual(plain(ts));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-mcp-source: an mcpServers entry is supplied by a root .mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-parity-mcp-b-"));
    try {
      writeTo(
        dir,
        ".claude/agents/consumer.md",
        "---\nname: consumer\ndescription: Declares an mcpServers entry supplied by a root .mcp.json file.\nmodel: sonnet\ntools: Read\nmcpServers: [local-tool]\n---\n",
      );
      writeTo(
        dir,
        ".mcp.json",
        JSON.stringify({ mcpServers: { "local-tool": { command: "x" } } }),
      );

      const ts = gradeHarness(dir);
      expect(
        ts.findings.filter((f) => f.ruleId === "agent-mcp-source"),
      ).toEqual([]);
      expect(plain(emitted.gradeHarness(dir))).toEqual(plain(ts));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-mcp-source: an mcpServers entry nothing supplies fails, naming the server", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-parity-mcp-c-"));
    try {
      writeTo(
        dir,
        ".claude/agents/consumer.md",
        "---\nname: consumer\ndescription: Declares an mcpServers entry nothing in the harness supplies.\nmodel: sonnet\ntools: Read\nmcpServers: [unsupplied]\n---\n",
      );

      const ts = gradeHarness(dir);
      const findings = ts.findings.filter(
        (f) => f.ruleId === "agent-mcp-source",
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("unsupplied");
      expect(findings[0]?.message.toLowerCase()).toContain("not supplied");
      expect(findings[0]?.subject).toBe(".claude/agents/consumer.md");
      expect(plain(emitted.gradeHarness(dir))).toEqual(plain(ts));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-mcp-source: an enabledPlugins entry present but set to false does not supply the server", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-parity-mcp-d-"));
    try {
      writeTo(
        dir,
        ".claude/agents/consumer.md",
        "---\nname: consumer\ndescription: Declares an mcpServers entry whose enabledPlugins key is explicitly false.\nmodel: sonnet\ntools: Read\nmcpServers: [context7]\n---\n",
      );
      writeTo(
        dir,
        ".claude/settings.json",
        JSON.stringify({
          enabledPlugins: { "context7@claude-plugins-official": false },
        }),
      );

      const ts = gradeHarness(dir);
      const findings = ts.findings.filter(
        (f) => f.ruleId === "agent-mcp-source",
      );
      expect(findings).toHaveLength(1);
      expect(plain(emitted.gradeHarness(dir))).toEqual(plain(ts));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `.claude/settings.json` is a DIRECTORY, not a file. `readJsoncFile`
   * (`jsonc.ts`, used by `harness/grade.ts`'s `readSettings`) recognizes
   * `EISDIR` and reports the friendly `"<path> is not a regular file"`,
   * while the emitted twin's `readJsonc` (`harness-rules.mjs`) catches
   * every `readFileSync` failure unconditionally and surfaces the raw
   * Node error text instead. The two messages differ, which breaks this
   * file's whole-grade parity (`settings-parses`'s finding message
   * embeds `settings.error` verbatim) even though both sides agree the
   * file doesn't parse. The twin is the reference: fix the TypeScript
   * side's settings read to degrade exactly like it, not the other way
   * around.
   */
  it("produce identical grades when .claude/settings.json is a directory, not a file", () => {
    mkdirSync(join(root, ".claude", "settings.json"), { recursive: true });

    const ts = gradeHarness(root);
    expect(ts.findings.some((f) => f.ruleId === "settings-parses")).toBe(true);
    expect(plain(emitted.gradeHarness(root))).toEqual(plain(ts));
  });

  /**
   * Same parity gap as the directory fixture above, reached via a
   * permission failure (`EACCES`) on the read instead of `EISDIR` on a
   * directory -- the TypeScript side's friendly
   * `"<path> is unreadable (EACCES)"` versus the twin's raw Node error
   * text.
   */
  it.skipIf(chmodIneffective)(
    "produce identical grades when .claude/settings.json cannot be read (EACCES)",
    () => {
      const settingsPath = join(root, ".claude", "settings.json");
      write(".claude/settings.json", "{}");
      chmodSync(settingsPath, 0o000);

      // Both sides must read while the lock is still in effect -- restoring
      // permissions between the two calls would have each grader read a
      // different filesystem state and compare nothing meaningful.
      let thrown: unknown;
      let ts: ReturnType<typeof gradeHarness> | undefined;
      let emittedGrade: unknown;
      try {
        ts = gradeHarness(root);
        emittedGrade = emitted.gradeHarness(root);
      } catch (error) {
        thrown = error;
      } finally {
        if (existsSync(settingsPath)) chmodSync(settingsPath, 0o644);
      }

      expect(thrown).toBeUndefined();
      expect(ts?.findings.some((f) => f.ruleId === "settings-parses")).toBe(
        true,
      );
      expect(plain(emittedGrade)).toEqual(plain(ts));
    },
  );

  it("parse frontmatter identically across every scalar form", () => {
    const samples = [
      "---\nname: a\ndescription: >-\n  folded\n  text\n---\nbody",
      "---\nd: |-\n  lit\n  eral\n---\n",
      "---\na: \"q \\\"x\\\"\"\nb: 'it''s'\n---\n",
      '---\npaths:\n  - a\n  - b\nx: [p, "q,r"]\n---\n',
      "---\nmcp:\n  nested:\n    k: v\nname: n\n---\n",
      "---\n???\nname: a\nname: b\n---\n",
      "# no frontmatter",
      "---\nunclosed: true\n",
    ];
    for (const sample of samples) {
      expect(
        plain(emittedFrontmatter.parseFrontmatter(sample)),
        sample,
      ).toEqual(plain(parseFrontmatter(sample)));
    }
  });
});
