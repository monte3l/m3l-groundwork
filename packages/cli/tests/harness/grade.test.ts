import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeHarness } from "../../src/harness/grade.js";
import { RULES } from "../../src/harness/rules.js";
import type { HarnessGrade } from "../../src/harness/types.js";

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

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-grade-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function settings(commands: { file: string; timeout?: number }[]): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Write",
          hooks: commands.map(({ file, timeout }) => ({
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`,
            ...(timeout === undefined ? {} : { timeout }),
          })),
        },
      ],
    },
  });
}

const GOOD_DESCRIPTION =
  "A description long enough to trigger on reliably, naming when to use it.";

function ids(grade: HarnessGrade, level?: "structural" | "rubric"): string[] {
  return grade.findings
    .filter((finding) => level === undefined || finding.level === level)
    .map((finding) => `${finding.ruleId}:${finding.subject}`)
    .sort();
}

/** A harness that is clean under every rule. */
function writeCleanHarness(): void {
  write(
    ".claude/settings.json",
    settings([{ file: "guard.mjs", timeout: 30 }]),
  );
  write(
    ".claude/hooks/guard.mjs",
    'import { realpathSync } from "node:fs";\nrealpathSync(process.argv[1]);\n',
  );
  write(
    ".claude/agents/reviewer.md",
    `---\nname: reviewer\ndescription: ${GOOD_DESCRIPTION}\ntools: Read, Grep\nmodel: claude-sonnet-5\n---\nbody\n`,
  );
  write(
    ".claude/skills/starting-work/SKILL.md",
    `---\nname: starting-work\ndescription: >-\n  ${GOOD_DESCRIPTION}\n---\n# starting-work\nSee references/table.md.\n`,
  );
  write(".claude/skills/starting-work/references/table.md", "# table\n");
  write(".claude/rules/src.md", '---\npaths:\n  - "src/**"\n---\nrule body\n');
  write("src/index.ts", "export {};\n");
  write(
    "CLAUDE.md",
    "# Project\n\nSee `.claude/rules/src.md` and `.claude/skills/starting-work/`.\n",
  );
}

describe("gradeHarness -- a clean harness", () => {
  it("has no findings and a perfect rubric score", () => {
    writeCleanHarness();
    const grade = gradeHarness(root);
    expect(ids(grade)).toEqual([]);
    expect(grade.structural.failed).toBe(0);
    expect(grade.rubricScore).toBe(1);
  });

  it("grades an empty directory as clean rather than failing", () => {
    const grade = gradeHarness(root);
    expect(grade.findings).toEqual([]);
    expect(grade.structural.checked).toBe(0);
    expect(grade.rubricScore).toBe(1);
  });
});

describe("gradeHarness -- structural defects", () => {
  it("catches a dangling hook, an orphan hook, an unparseable-frontmatter skill, and a skill/agent naming mismatch", () => {
    writeCleanHarness();
    write(
      ".claude/settings.json",
      settings([
        { file: "guard.mjs", timeout: 30 },
        { file: "gone.mjs", timeout: 30 },
      ]),
    );
    write(".claude/hooks/orphan.mjs", "// never registered\n");
    write(".claude/skills/no-frontmatter/SKILL.md", "# just markdown\n");
    write(".claude/skills/no-skill-md/notes.md", "x\n");
    write(
      ".claude/skills/wrong-name/SKILL.md",
      `---\nname: other\ndescription: ${GOOD_DESCRIPTION}\n---\n`,
    );
    write(
      ".claude/agents/mismatch.md",
      `---\nname: someone-else\ndescription: ${GOOD_DESCRIPTION}\ntools: Read\nmodel: sonnet\n---\n`,
    );

    const grade = gradeHarness(root);
    expect(
      ids(grade, "structural"),
      JSON.stringify(grade.findings, null, 2),
    ).toEqual([
      "agent-shape:.claude/agents/mismatch.md",
      "hook-dangling:.claude/hooks/gone.mjs",
      "hook-orphan:.claude/hooks/orphan.mjs",
      "skill-shape:.claude/skills/no-frontmatter",
      "skill-shape:.claude/skills/no-skill-md",
      "skill-shape:.claude/skills/wrong-name",
    ]);
    expect(grade.structural.failed).toBe(6);
  });

  it("accepts a skill with no `name` (it defaults to the directory) and reports a missing description only as a quality gap", () => {
    writeCleanHarness();
    write(
      ".claude/skills/no-name/SKILL.md",
      `---\ndescription: ${GOOD_DESCRIPTION}\n---\nbody\n`,
    );
    write(".claude/skills/no-desc/SKILL.md", "---\nname: no-desc\n---\nbody\n");
    const grade = gradeHarness(root);
    expect(ids(grade, "structural")).toEqual([]);
    expect(ids(grade, "rubric")).toEqual([
      "description-substance:.claude/skills/no-desc",
    ]);
  });

  it("reports an unparseable settings.json once, without cascading into hook findings", () => {
    writeCleanHarness();
    write(".claude/settings.json", "{ not json");
    const grade = gradeHarness(root);
    expect(ids(grade, "structural")).toEqual([
      "settings-parses:.claude/settings.json",
    ]);
  });

  it("flags a hook that compares process.argv[1] to import.meta.url without realpathSync", () => {
    writeCleanHarness();
    write(
      ".claude/hooks/guard.mjs",
      "if (process.argv[1] === fileURLToPath(import.meta.url)) main();\n",
    );
    expect(ids(gradeHarness(root), "structural")).toEqual([
      "hook-entrypoint:.claude/hooks/guard.mjs",
    ]);
  });

  it("accepts a rule with no frontmatter (unconditional) but flags an empty `paths`", () => {
    writeCleanHarness();
    write(".claude/rules/always.md", "no frontmatter at all\n");
    write(".claude/rules/empty.md", "---\npaths:\n---\nbody\n");
    write(
      "CLAUDE.md",
      "`.claude/rules/src.md` `.claude/rules/always.md` `.claude/rules/empty.md` `.claude/skills/starting-work/`\n",
    );
    expect(ids(gradeHarness(root), "structural")).toEqual([
      "rule-shape:.claude/rules/empty.md",
    ]);
  });

  it("flags a CLAUDE.md path that does not exist and a rule CLAUDE.md never names, but ignores globs and settings.local.json", () => {
    writeCleanHarness();
    write(".claude/rules/unlisted.md", '---\npaths:\n  - "src/**"\n---\n');
    write(
      "CLAUDE.md",
      "`.claude/rules/src.md` `.claude/skills/starting-work/` `.claude/skills/deleted/` `.claude/agents/**` `.claude/settings.local.json`.\n",
    );
    expect(ids(gradeHarness(root), "structural")).toEqual([
      "claudemd-refs:.claude/rules/unlisted.md",
      "claudemd-refs:CLAUDE.md",
    ]);
  });

  it("counts a script wired through a top-level command key like statusLine as registered, and flags one that is missing", () => {
    writeCleanHarness();
    write(".claude/hooks/statusline.mjs", "// status line\n");
    write(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.mjs"',
                  timeout: 30,
                },
              ],
            },
          ],
        },
        statusLine: {
          type: "command",
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/statusline.mjs"',
        },
        subagentStatusLine: {
          type: "command",
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/missing-sub.mjs"',
        },
      }),
    );
    expect(ids(gradeHarness(root), "structural")).toEqual([
      "hook-dangling:.claude/hooks/missing-sub.mjs",
    ]);
  });

  it("treats a helper module a registered hook imports -- directly or transitively -- as wired, but not an unimported one", () => {
    writeCleanHarness();
    write(
      ".claude/hooks/guard.mjs",
      'import { realpathSync } from "node:fs";\nimport "./layout.mjs";\nrealpathSync(process.argv[1]);\n',
    );
    write(".claude/hooks/layout.mjs", 'import "./glyphs.mjs";\n');
    write(".claude/hooks/glyphs.mjs", "export const G = 1;\n");
    write(".claude/hooks/unused-helper.mjs", "export const U = 1;\n");
    expect(ids(gradeHarness(root), "structural")).toEqual([
      "hook-orphan:.claude/hooks/unused-helper.mjs",
    ]);
  });

  it("counts a hook registered only in settings.local.json as referenced", () => {
    writeCleanHarness();
    write(".claude/hooks/local-only.mjs", "// registered locally\n");
    write(
      ".claude/settings.local.json",
      settings([{ file: "local-only.mjs", timeout: 5 }]),
    );
    expect(ids(gradeHarness(root), "structural")).toEqual([]);
  });
});

describe("gradeHarness -- rubric findings warn, never block", () => {
  it("scores thin descriptions, unpinned/stale models, missing tools, missing timeouts, dead rule globs, oversized skills and dead references", () => {
    writeCleanHarness();
    write(".claude/settings.json", settings([{ file: "guard.mjs" }]));
    write(
      ".claude/agents/reviewer.md",
      "---\nname: reviewer\ndescription: too short\n---\nbody\n",
    );
    write(
      ".claude/agents/stale.md",
      `---\nname: stale\ndescription: ${GOOD_DESCRIPTION}\ntools: Read\nmodel: claude-3-opus\n---\n`,
    );
    write(
      ".claude/skills/starting-work/SKILL.md",
      `---\nname: starting-work\ndescription: ${GOOD_DESCRIPTION}\n---\nSee references/missing.md.\n${"line\n".repeat(600)}`,
    );
    write(".claude/rules/src.md", '---\npaths:\n  - "nowhere/**"\n---\nbody\n');

    const grade = gradeHarness(root);
    expect(grade.structural.failed).toBe(0);
    expect(
      ids(grade, "rubric"),
      JSON.stringify(grade.findings, null, 2),
    ).toEqual([
      "agent-tool-scope:.claude/agents/reviewer.md",
      "description-substance:.claude/agents/reviewer.md",
      "hook-timeout:PreToolUse hook",
      "model-pin-currency:.claude/agents/reviewer.md",
      "model-pin-currency:.claude/agents/stale.md",
      "rule-globs-live:.claude/rules/src.md",
      "skill-body-size:.claude/skills/starting-work",
      "skill-references-resolve:.claude/skills/starting-work",
    ]);
    expect(grade.rubricScore).toBeLessThan(1);
    expect(grade.rubricScore).toBeGreaterThan(0);
  });

  it("matches `**/` globs at the project root and brace alternatives", () => {
    writeCleanHarness();
    write("tests/a.test.ts", "");
    write(
      ".claude/rules/src.md",
      '---\npaths:\n  - "**/tests/**"\n  - "src/**/*.{ts,tsx}"\n---\n',
    );
    expect(ids(gradeHarness(root))).toEqual([]);
  });
});

describe("the real templates/core tree", () => {
  it("grades with zero structural findings", () => {
    const grade = gradeHarness(templatesCoreDir);
    const structural = grade.findings.filter((f) => f.level === "structural");
    expect(
      structural,
      `structural findings: ${JSON.stringify(structural, null, 2)}`,
    ).toEqual([]);
    expect(grade.structural.checked).toBeGreaterThan(20);
  });

  it("carries every rule once, structural rules first", () => {
    const rules = RULES.map((rule) => rule.id);
    expect(new Set(rules).size).toBe(rules.length);
    const firstRubric = RULES.findIndex((rule) => rule.level === "rubric");
    expect(
      RULES.slice(firstRubric).every((rule) => rule.level === "rubric"),
    ).toBe(true);
  });
});
