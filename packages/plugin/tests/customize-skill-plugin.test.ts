// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Regression pins for the /customize skill's Claude Code plugin support:
 * the plugin project kind, the Step 6 final gate, the CLAUDE.md naming rule
 * and the schema 6 `pluginLayout` rows. Text is whitespace-normalised so a
 * line wrap never breaks a pin.
 */
import { readFileSync } from "node:fs";
import { recommendPlugins } from "../src/plugin-map.js";
import type { ProjectKind } from "../src/kind-facet-map.js";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "customize",
);
const repoRoot = join(skillDir, "..", "..", "..", "..");
const read = (name: string): string =>
  readFileSync(join(skillDir, name), "utf8").replace(/\s+/g, " ");
const skill = read("SKILL.md");
const step0 = read("step-0-reconcile.md");

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("SKILL.md Step 1 -- Claude Code plugin project kind", () => {
  const step1 = slice(skill, "## Step 1", "## Step 2");

  it("lists Claude Code plugin among the project kinds", () => {
    expect(slice(step1, "**Project kind**", "**Runtime target**")).toContain(
      "Claude Code plugin",
    );
  });

  it("pre-selects it from survey.harness.pluginLayout, showing manifest and components", () => {
    expect(step1).toContain(
      "`survey.harness.pluginLayout` is set, pre-select **Claude Code plugin**",
    );
    expect(step1).toContain("show the manifest and components as the evidence");
  });

  it("asks the kind cold when there is neither package.json evidence nor a manifest", () => {
    expect(step1).toContain(
      "With no `package.json` evidence and no plugin manifest, do not pre-select a kind: ask it cold",
    );
  });
});

describe("SKILL.md Step 6 -- final gate", () => {
  it("places Step 6 Final gate before Step 7 Report", () => {
    const gate = skill.indexOf("## Step 6 — Final gate");
    const report = skill.indexOf("## Step 7 — Report");
    expect(gate).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(gate);
  });

  const gate = slice(skill, "## Step 6 — Final gate", "## Step 7 — Report");

  it("runs pnpm verify for fresh and the project's own check-harness when present", () => {
    expect(gate).toContain("**Fresh:** run `pnpm verify` again");
    expect(gate).toContain(
      "the project has `bin/check-harness.mjs`:** run `node bin/check-harness.mjs`",
    );
  });

  it.each([
    "bin/check-harness.mjs",
    "bin/lib/harness-rules.mjs",
    "bin/lib/frontmatter.mjs",
    "bin/lib/report.mjs",
  ])("names the staged grader file %s", (file) => {
    expect(gate).toContain(`\`${file}\``);
  });

  it("copies the grader to .groundwork/grade/bin/, runs it, deletes the directory, and never writes into the project's bin/", () => {
    const copy = gate.indexOf("`.groundwork/grade/bin/`");
    const run = gate.indexOf(
      "run `node .groundwork/grade/bin/check-harness.mjs`",
    );
    const del = gate.indexOf("delete `.groundwork/grade/`");
    expect(copy).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(copy);
    expect(del).toBeGreaterThan(run);
    expect(gate).toContain(
      "Never write the grader into the project's own `bin/`",
    );
  });

  it("requires all four grader files in stagedBaseline.files before using the staged grader", () => {
    expect(gate).toContain("**all four**");
    expect(gate).toContain("`stagedBaseline.files`");
  });

  it("requires git rev-parse --show-toplevel to equal the project root", () => {
    expect(gate).toContain("`git rev-parse --show-toplevel`");
    expect(gate).toContain("equals the project root");
  });

  it("names exactly the files check-harness.mjs imports, transitively, as the staged grader", () => {
    const binDir = join(repoRoot, "templates", "core", "bin");
    const seen = new Set<string>();
    const visit = (abs: string): void => {
      if (seen.has(abs)) return;
      seen.add(abs);
      const source = readFileSync(abs, "utf8");
      for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        visit(resolve(dirname(abs), m[1] ?? ""));
      }
    };
    visit(join(binDir, "check-harness.mjs"));
    const closure = [...seen].map((f) => relative(binDir, f)).sort();
    const named = [
      "bin/check-harness.mjs",
      "bin/lib/harness-rules.mjs",
      "bin/lib/frontmatter.mjs",
      "bin/lib/report.mjs",
    ];
    expect(closure.map((f) => `bin/${f}`)).toEqual([...named].sort());
    for (const file of named) expect(gate).toContain(`\`${file}\``);
  });

  it("falls back to reporting the harness was not graded, and why", () => {
    expect(gate).toContain(
      "state in Step 7 that the harness was not graded, and why",
    );
  });
});

describe("SKILL.md CLAUDE.md naming rule", () => {
  it("requires the full .claude/ path, never the bare filename, and names claudemd-refs", () => {
    const rule = slice(skill, "**Naming rule for `CLAUDE.md`", "## Step 4");
    expect(rule).toContain("`.claude/rules/tests.md`, never `tests.md`");
    expect(rule).toContain("`claudemd-refs`");
  });
});

describe("step-0-reconcile.md -- schema 6 pluginLayout", () => {
  it("has a schema table row 6 documenting pluginLayout", () => {
    const start = step0.indexOf("| 6 ");
    expect(start).toBeGreaterThan(-1);
    expect(step0.slice(start, start + 120)).toContain(
      "`survey.harness.pluginLayout`",
    );
  });

  it("tells the harness agent to read survey.harness.pluginLayout", () => {
    expect(step0).toContain(
      "The harness agent also reads `survey.harness.pluginLayout` (schema 6)",
    );
  });
});

describe("step-3-round-1.md -- plugin offer split capacity", () => {
  const step3 = read("step-3-round-1.md");
  const kinds: readonly ProjectKind[] = [
    "library",
    "cli",
    "frontend",
    "service",
    "plugin",
  ];

  it.each(["plugin", "frontend"] as const)(
    "offers eleven entries for the %s kind, within the three-question capacity",
    (kind) => {
      const count = recommendPlugins({
        kind,
        runtime: "node",
        testsMandatory: true,
        ciDepth: "standard",
        keepAgents: [],
      }).length;
      expect(count).toBe(11);
      expect(count).toBeLessThanOrEqual(4 + 3 + 4);
    },
  );

  it("offers at most eleven entries across every kind", () => {
    const counts = kinds.map(
      (kind) =>
        recommendPlugins({
          kind,
          runtime: "node",
          testsMandatory: true,
          ciDepth: "standard",
          keepAgents: [],
        }).length,
    );
    expect(Math.max(...counts)).toBe(11);
  });

  it("states the 1-4, 5-7, 8-to-last split including 8-11 and no longer says all ten", () => {
    expect(step3).toContain("entries 1-4, 5-7, and 8 to the last entry");
    expect(step3).toContain("8-11");
    expect(step3).toContain("offer every entry it returns (ten, or eleven");
    expect(step3).toContain("for any entry.");
    expect(step3).not.toContain("all ten");
    expect(step3).not.toContain("for any of the ten");
  });

  it.each([
    "recommendIntegrations",
    "one more `AskUserQuestion`",
    "none pre-selected",
    "split evenly",
    "fewer than two options",
    "Enable / Skip",
    "every entry the user selected",
    "does not return it",
    "unpinned `npx` launch",
  ])("documents the integration offer: contains %s", (text) => {
    expect(step3).toContain(text);
  });

  it.each([
    "one multi-select question per four entries",
    "at most seven entries",
    "Write every confirmed `true` entry",
  ])("no longer contains the old integration wording: %s", (text) => {
    expect(step3).not.toContain(text);
  });

  it("names the frontend-design entry and defines the hasDesignSystem context field", () => {
    expect(step3).toContain("frontend-design");
    expect(step3).toContain("hasDesignSystem");
  });
});

describe("SKILL.md Step 7 -- follow-ups the project's files cannot carry", () => {
  const step7Start = skill.indexOf("## Step 7");
  expect(step7Start).toBeGreaterThan(-1);
  const step7 = skill.slice(step7Start);
  it("names the notification settings and the permissions command", () => {
    for (const text of [
      "preferredNotifChannel",
      "terminal_bell",
      "~/.claude/settings.json",
      "/fewer-permission-prompts",
    ]) {
      expect(step7).toContain(text);
    }
  });

  it("names the notification trigger accurately", () => {
    expect(step7).toContain("waiting for input");
  });

  it("explains the baseline ships no allowlist because it cannot know the commands", () => {
    expect(step7).toContain("cannot know the project's commands in advance");
  });

  it("names Ghostty, Kitty and iTerm2 as the terminals that notify by default", () => {
    for (const terminal of ["Ghostty", "Kitty", "iTerm2"]) {
      expect(step7).toContain(terminal);
    }
  });
});

describe("step-3-round-1.md -- kind-scoped packs", () => {
  const step3 = read("step-3-round-1.md");

  it("names frontend and service among the kind-scoped packs whose recommendation can disagree", () => {
    expect(step3).toContain(
      "but `publishing`'s, `licensing`'s, `frontend`'s and `service`'s do",
    );
  });

  it("no longer carries the old publishing/licensing-only clause", () => {
    expect(step3).not.toContain("not for `frontend`/`service`");
    expect(step3).not.toContain("`publishing`'s and `licensing`'s do");
    expect(step3).not.toContain("`licensing`'s and `frontend`'s do");
  });
});

describe("step-3-round-1.md -- npm Dependabot grouping", () => {
  const step3 = read("step-3-round-1.md");
  const raw = readFileSync(join(skillDir, "step-3-round-1.md"), "utf8");
  const fences = [...raw.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (m) => m[1] ?? "",
  );
  const block = fences.find((f) => f.includes('package-ecosystem: "npm"'));
  const blockText = block ?? "";
  const blockLines = blockText.split("\n").filter((l) => l.trim() !== "");

  it("carries a fenced yaml block with an npm package-ecosystem entry", () => {
    expect(block).toBeDefined();
  });

  it("indents every line of the block at least two spaces, item starting exactly at two", () => {
    expect(blockLines.length).toBeGreaterThan(0);
    for (const line of blockLines) {
      expect(line).toMatch(/^ {2,}\S/);
    }
    expect(blockText).toMatch(/^ {2}- package-ecosystem: "npm"/m);
  });

  it("groups development and production dependencies", () => {
    expect(blockText).toContain("groups:");
    expect(blockText).toContain("dev-dependencies");
    expect(blockText).toContain("prod-dependencies");
    expect(blockText).toContain('dependency-type: "development"');
    expect(blockText).toContain('dependency-type: "production"');
  });

  it("groups minor and patch updates but never major", () => {
    const typeLines = blockLines.filter(
      (l) =>
        l.includes("update-types") ||
        /^\s*- "?(minor|patch|major)"?\s*$/.test(l),
    );
    const joined = typeLines.join("\n");
    expect(joined).toContain("minor");
    expect(joined).toContain("patch");
    expect(joined).not.toContain("major");
  });

  it("carries the cooldown line", () => {
    expect(blockText).toContain("default-days: 7");
  });

  it("names .github/dependabot.yml as the file the block goes into", () => {
    expect(step3).toContain(".github/dependabot.yml");
  });

  it("states the npm ecosystem also covers pnpm", () => {
    expect(step3).toMatch(/`npm` ecosystem[^.]*pnpm/);
  });

  it("tells the owner to rewrite or drop the baseline comment saying npm updates are not enabled", () => {
    expect(step3).toMatch(
      /deliberately not enabled|npm updates are deliberately/,
    );
    expect(step3).toMatch(
      /(rewrite|drop)[^.]*(deliberately not enabled|npm updates are deliberately)|(deliberately not enabled|npm updates are deliberately)[^.]*(rewrite|drop)/,
    );
  });

  it("never applies the block in adopt mode, since Step 0.4 did not confirm it", () => {
    expect(step3).toMatch(/never applied/);
    expect(step3).toMatch(/Step 0\.4 did not confirm/);
  });

  it("scopes the adopt follow-up to an existing file with no npm entry for directory /", () => {
    expect(step3).toContain("already exists");
    expect(step3).toMatch(/no `npm` entry[^.]*"\/"/);
  });

  it("never creates the file and never touches an existing npm entry", () => {
    expect(step3).toContain("never create");
    expect(step3).toMatch(/never touch[^.]*`npm` entry/);
  });

  it("keeps the adopt-mode 'exactly three things' list unextended", () => {
    expect(step3).toContain("exactly three things");
    expect(step3).not.toContain("plus the one Dependabot edit");
  });

  it("flags pnpm support as unconfirmed beyond v10 and points at the first Dependabot PR", () => {
    expect(step3).toMatch(/pnpm[^.]*up to v10|up to v10[^.]*pnpm/);
    expect(step3).toContain("unconfirmed");
    expect(step3).toMatch(/first Dependabot PR/);
  });

  it("makes the unconfirmed caveat conditional on the project using pnpm", () => {
    expect(step3).toMatch(
      /(project (uses|runs) pnpm|uses pnpm)[^.]*unconfirmed|unconfirmed[^.]*(project (uses|runs) pnpm|uses pnpm)/i,
    );
  });

  it("cites the upstream evidence: dependabot-core, pnpm 12, #15904, #16513, #16521 and #16375", () => {
    expect(step3).toContain("dependabot-core");
    expect(step3).toContain("pnpm 12");
    expect(step3).toContain("#15904");
    expect(step3).toContain("#16521");
    expect(step3).toContain("#16375");
    expect(step3).toContain("#16513");
  });

  it("says pnpm 12 support is staged or partial", () => {
    expect(step3).toMatch(/(Part 3|still open|not yet complete)/i);
  });

  it("names the known open problems as literal words", () => {
    expect(step3).toContain("catalogs");
    expect(step3).toContain("overrides");
    expect(step3).toContain("minimumReleaseAge");
  });

  it("tells the owner to expect failures when the project uses catalog: entries or workspace overrides", () => {
    expect(step3).toContain("catalog:");
    expect(step3).toMatch(
      /owner[^.]*expect[^.]*fail|expect[^.]*fail[^.]*owner/i,
    );
  });

  it("makes fresh mode at any other CI depth a Step 7 follow-up, not a question", () => {
    expect(step3).toMatch(/Step 7 follow-up/i);
    expect(step3).toMatch(/not (offered as )?a question/i);
  });
});

describe("SKILL.md Step 7 -- npm Dependabot grouping follow-up", () => {
  const step7Start = skill.indexOf("## Step 7");
  expect(step7Start).toBeGreaterThan(-1);
  const step7 = skill.slice(step7Start);

  it("names dependabot.yml and groups in a follow-up", () => {
    expect(step7).toContain("dependabot.yml");
    expect(step7).toContain("groups");
  });

  it("flags pnpm support as unconfirmed", () => {
    expect(step7).toContain("unconfirmed");
  });

  it("names the known pnpm catalogs and overrides problems", () => {
    expect(step7).toContain("catalogs");
    expect(step7).toContain("overrides");
  });

  it("does not hedge the follow-up with 'or on request'", () => {
    expect(step7).not.toContain("or on request");
  });
});
