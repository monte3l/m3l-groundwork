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

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
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
    write(
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
    write(
      ".claude/hooks/orphan.mjs",
      "if (process.argv[1] === fileURLToPath(import.meta.url)) {}\n",
    );
    write(".claude/hooks/helper.mjs", "export {};\n");
    write(".claude/hooks/registered.mjs", 'import "./helper.mjs";\n');
    write(
      ".claude/settings.local.json",
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "node .claude/hooks/registered.mjs",
        },
      }),
    );
    write(".claude/skills/bare/SKILL.md", "# no frontmatter\n");
    write(".claude/skills/empty/notes.md", "x\n");
    write(
      ".claude/agents/a.md",
      "---\nname: b\ndescription: short\nmodel: claude-3-opus\n---\n",
    );
    write(".claude/rules/r.md", '---\npaths:\n  - "nowhere/**"\n---\n');
    write("CLAUDE.md", "`.claude/agents/missing.md`\n");

    const ts = gradeHarness(root);
    expect(ts.findings.length).toBeGreaterThan(8);
    expect(plain(emitted.gradeHarness(root))).toEqual(plain(ts));
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
