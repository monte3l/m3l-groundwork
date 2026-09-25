import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "../../src/harness/frontmatter.js";
import { gradeHarness } from "../../src/harness/grade.js";
import { CURRENT_MODELS, RULES } from "../../src/harness/rules.js";

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
 * with a stale model and no `tools`, a rule with an empty `paths` and a
 * dead glob, a `CLAUDE.md` naming a file that does not exist, and a
 * malformed `.claude/settings.local.json` (H3).
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
