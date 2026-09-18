import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyHarness } from "../../src/survey/survey-harness.js";

describe("surveyHarness", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports absent when there is no .claude/ directory and no CLAUDE.md", () => {
    expect(surveyHarness(dir)).toEqual({
      present: false,
      settingsFile: undefined,
      agents: [],
      skills: [],
      hooks: [],
      rules: [],
      commands: [],
      hasSettingsLocal: false,
      hasClaudeMd: false,
      claudeMdHeadings: [],
    });
  });

  it("reads CLAUDE.md's heading outline even without a .claude/ directory", () => {
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "# Title\n\n## Setup\n\nsome prose\n\n### Details\n",
    );
    const survey = surveyHarness(dir);
    expect(survey.hasClaudeMd).toBe(true);
    expect(survey.claudeMdHeadings).toEqual(["Title", "Setup", "Details"]);
  });

  it("surveys settings.json, agents, skills, hooks, rules, and commands", () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "my-skill"), { recursive: true });
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    mkdirSync(join(dir, ".claude", "commands"), { recursive: true });

    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}");
    writeFileSync(
      join(dir, ".claude", "agents", "reviewer.md"),
      "---\nmodel: sonnet\n---\n# reviewer\n",
    );
    writeFileSync(
      join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
      '---\nname: "my-skill"\ndescription: does a thing\n---\n# my-skill\n',
    );
    writeFileSync(join(dir, ".claude", "hooks", "guard-foo.mjs"), "");
    writeFileSync(
      join(dir, ".claude", "rules", "src.md"),
      "---\npaths: src/**\n---\n# src rule\n",
    );
    writeFileSync(join(dir, ".claude", "commands", "deploy.md"), "# deploy\n");

    const survey = surveyHarness(dir);

    expect(survey.present).toBe(true);
    expect(survey.settingsFile).toBe("settings.json");
    expect(survey.hasSettingsLocal).toBe(true);
    expect(survey.agents).toEqual([{ name: "reviewer", model: "sonnet" }]);
    expect(survey.skills).toEqual([
      { name: "my-skill", description: "does a thing" },
    ]);
    expect(survey.hooks).toEqual(["guard-foo.mjs"]);
    expect(survey.rules).toEqual([{ name: "src", paths: "src/**" }]);
    expect(survey.commands).toEqual(["deploy.md"]);
  });

  it("falls back to the directory name when a skill has no frontmatter name", () => {
    mkdirSync(join(dir, ".claude", "skills", "untitled"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "skills", "untitled", "SKILL.md"),
      "# untitled\n",
    );
    expect(surveyHarness(dir).skills).toEqual([
      { name: "untitled", description: undefined },
    ]);
  });

  it("reports empty collections when .claude/ exists but its subdirectories don't", () => {
    mkdirSync(join(dir, ".claude"));
    const survey = surveyHarness(dir);
    expect(survey.present).toBe(true);
    expect(survey.agents).toEqual([]);
    expect(survey.skills).toEqual([]);
    expect(survey.hooks).toEqual([]);
    expect(survey.rules).toEqual([]);
    expect(survey.commands).toEqual([]);
  });
});
