// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Template-contract tests for the `frontend` pack: its manifest, the
 * read-only `ui-reviewer` agent (a static WCAG 2.2 source review) and the
 * `new-component` skill. `templates/**` is excluded from vitest discovery, so
 * the files are read by path. Pins the verified WCAG 2.2 criteria and
 * thresholds so the agent can not drift into unverified claims.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPack } from "../../src/packs.js";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "frontend",
);
const agentPath = join(packDir, "files", ".claude", "agents", "ui-reviewer.md");
const skillPath = join(
  packDir,
  "files",
  ".claude",
  "skills",
  "new-component",
  "SKILL.md",
);

function split(content: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) {
    throw new Error("no frontmatter block found");
  }
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

function field(frontmatter: string, key: string): string | undefined {
  return new RegExp(`^${key}:[ \\t]*(.*)$`, "mu")
    .exec(frontmatter)?.[1]
    ?.trim();
}

/**
 * The text of one checklist criterion: from its `- **<number> ` line up to the
 * next `- **` bullet or `**` heading line, whitespace-normalised.
 */
function criterionBlock(body: string, criterion: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`- **${criterion} `));
  if (start === -1) {
    throw new Error(`criterion ${criterion} not found`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^(- )?\*\*/u.test(l));
  const block = [
    lines[start] ?? "",
    ...(end === -1 ? rest : rest.slice(0, end)),
  ];
  return block.join(" ").replace(/\s+/gu, " ").trim();
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

describe("frontend pack manifest", () => {
  it("loads through loadPack with the contracted shape", () => {
    const { manifest } = loadPack("frontend");
    expect(manifest.name).toBe("frontend");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.modes).toEqual(["fresh", "adopt"]);
    expect(manifest.budget).toEqual({
      agents: 1,
      skills: 1,
      hooks: 0,
      workflows: 0,
      scripts: 0,
    });
    expect(manifest.requires).toBeUndefined();
    expect(manifest.wiring.packageScripts).toEqual({});
    expect(manifest.wiring.verifySteps).toEqual([]);
    expect(manifest.description.trim().length).toBeGreaterThan(0);
    expect(manifest.adoptNotes?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("adoptNotes says it works best with components, not that it needs one", () => {
    const { manifest } = loadPack("frontend");
    expect(manifest.adoptNotes).not.toContain("needs at least one component");
    expect(manifest.adoptNotes).toContain("works best with");
  });

  it("has exactly the contracted raw fields: no requires key, empty wiring", () => {
    const raw = JSON.parse(
      readFileSync(join(packDir, "pack.json"), "utf8"),
    ) as {
      requires?: unknown;
      wiring: {
        settings: unknown;
        packageScripts: unknown;
        verifySteps: unknown;
      };
      schemaVersion: number;
      name: string;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.name).toBe("frontend");
    expect("requires" in raw).toBe(false);
    expect(raw.wiring).toEqual({
      settings: {},
      packageScripts: {},
      verifySteps: [],
    });
  });
});

describe("ui-reviewer agent", () => {
  const { frontmatter, body } = split(readFileSync(agentPath, "utf8"));
  const description = field(frontmatter, "description") ?? "";

  it("is named ui-reviewer, on the medium-effort sonnet model", () => {
    expect(field(frontmatter, "name")).toBe("ui-reviewer");
    expect(field(frontmatter, "model")).toBe("claude-sonnet-5-5");
    expect(field(frontmatter, "effort")).toBe("medium");
  });

  it("is read-only: tools are exactly Read, Grep, Glob and Agent is disallowed", () => {
    const tools = list(field(frontmatter, "tools"));
    expect([...tools].sort()).toEqual(["Glob", "Grep", "Read"]);
    for (const forbidden of [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
      "Agent",
    ]) {
      expect(tools).not.toContain(forbidden);
    }
    expect(list(field(frontmatter, "disallowedTools"))).toContain("Agent");
  });

  it("has a 40-1024 character description naming accessibility and WCAG", () => {
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/accessib/i);
    expect(description).toMatch(/WCAG/);
  });

  it.each([
    "1.1.1",
    "1.3.1",
    "1.4.3",
    "1.4.4",
    "1.4.10",
    "1.4.11",
    "2.1.1",
    "2.1.2",
    "2.3.3",
    "2.4.7",
    "2.4.11",
    "2.5.8",
    "3.3.1",
    "3.3.2",
    "4.1.2",
  ])("cites WCAG success criterion %s", (criterion) => {
    expect(body).toContain(criterion);
  });

  it.each([
    "4.5:1",
    "3:1",
    "24 by 24 CSS pixels",
    "320 CSS pixels",
    "200 percent",
  ])("states the verified threshold %s", (threshold) => {
    expect(body).toContain(threshold);
  });

  it("labels 2.3.3 as level AAA", () => {
    const line = body.split("\n").find((l) => l.includes("2.3.3"));
    expect(line).toBeDefined();
    expect(line).toContain("AAA");
  });

  it("is a WCAG 2.2 static source review that reports browser-only checks as NOT CHECKED", () => {
    expect(body).toContain("WCAG 2.2");
    expect(body).toContain("NOT CHECKED");
  });

  it.each(["Must-fix", "Should-fix", "Nit"])(
    "uses the %s severity tier",
    (tier) => {
      expect(body).toContain(tier);
    },
  );

  it("does not cite 4.1.1, which WCAG 2.2 removed", () => {
    expect(body).not.toContain("4.1.1");
  });

  it.each([
    ["1.1.1", "A"],
    ["1.3.1", "A"],
    ["4.1.2", "A"],
    ["2.1.1", "A"],
    ["2.1.2", "A"],
    ["2.4.7", "AA"],
    ["2.4.11", "AA"],
    ["2.5.8", "AA"],
    ["3.3.2", "A"],
    ["3.3.1", "A"],
    ["1.4.3", "AA"],
    ["1.4.11", "AA"],
    ["1.4.4", "AA"],
    ["1.4.10", "AA"],
    ["2.3.3", "AAA"],
  ])("criterion %s is labelled level %s", (criterion, level) => {
    expect(criterionBlock(body, criterion)).toMatch(
      new RegExp(`\\(${level}[,)]`, "u"),
    );
  });

  it.each(["4.5:1", "3:1", "18 point", "14 point bold"])(
    "1.4.3 block states %s",
    (token) => {
      expect(criterionBlock(body, "1.4.3")).toContain(token);
    },
  );

  it("1.4.11 block states 3:1", () => {
    expect(criterionBlock(body, "1.4.11")).toContain("3:1");
  });

  it("2.1.1 does not mention a role (a missing role is a 4.1.2 issue)", () => {
    expect(criterionBlock(body, "2.1.1")).not.toContain("role");
  });

  it.each(["focus is managed", "focus management", "focus managed"])(
    "2.1.2 does not claim %s (not part of 2.1.2)",
    (phrase) => {
      expect(criterionBlock(body, "2.1.2")).not.toContain(phrase);
    },
  );

  it.each(["inactive", "decoration", "logotype"])(
    "1.4.3 names the incidental-text exemption %s",
    (word) => {
      expect(criterionBlock(body, "1.4.3")).toContain(word);
    },
  );

  it("1.4.3 does not use the loose blanket exemption claim", () => {
    expect(criterionBlock(body, "1.4.3")).not.toContain(
      "Logotypes and inactive controls are exempt",
    );
  });

  it("2.3.3 is a Should-fix and never a Nit", () => {
    const block = criterionBlock(body, "2.3.3");
    expect(block).toContain("Should-fix");
    expect(block).not.toContain("Nit");
  });

  it("returns immediately when given no file list, since a spoke cannot ask mid-run", () => {
    expect(body).toContain("return immediately");
  });

  it("does not cite the removed Parsing criterion", () => {
    expect(body).not.toContain("Parsing");
  });
});

describe("new-component skill", () => {
  const { frontmatter, body } = split(readFileSync(skillPath, "utf8"));
  const description = field(frontmatter, "description") ?? "";

  it("has a name equal to its directory name", () => {
    expect(field(frontmatter, "name")).toBe("new-component");
  });

  it("has a 40-1024 character description containing 'new component'", () => {
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("new component");
  });

  it.each([
    "test-author",
    "code-implementer",
    "ui-reviewer",
    "sibling",
    "dependency",
    "framework",
  ])("body mentions %s", (word) => {
    expect(body).toContain(word);
  });

  it("does not tell the hub to do the writer spokes' work directly", () => {
    expect(body).not.toContain("do the same steps directly");
  });

  it("stops and asks the owner to restore missing writer spokes", () => {
    expect(body).toContain("restore");
    expect(body).toContain("never writes");
  });

  it("has no shell injection (a bang followed by a backtick)", () => {
    expect(body).not.toMatch(/!`/u);
  });

  it("stays under 500 lines", () => {
    expect(body.split("\n").length).toBeLessThan(500);
  });
});
