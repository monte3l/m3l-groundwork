// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `surveyHarness` never reads through a symlink that leaves the project: the
 * entry is recorded in `undetermined` and left out, so text from elsewhere on
 * the machine cannot reach `inventory.json` or the report. A symlink that
 * stays inside the project is followed as before.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { surveyHarness } from "../../src/survey/survey-harness.js";

const NOTE = "is a symlink out of the project, not followed";
const AGENT = "---\nname: stolen\nmodel: opus\n---\nbody\n";

let base: string;
let project: string;
let outside: string;
let undetermined: string[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harness-link-out-")));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(outside);
  undetermined = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("surveyHarness: a symlink out of the project is not followed", () => {
  it("skips an agent file linked to a file outside, and records it", () => {
    mkdirSync(join(project, ".claude", "agents"));
    writeFileSync(join(outside, "agent.md"), AGENT);
    symlinkSync(
      join(outside, "agent.md"),
      join(project, ".claude", "agents", "stolen.md"),
    );
    const survey = surveyHarness(project, undetermined);
    expect(survey.agents).toEqual([]);
    expect(undetermined.some((note) => note.includes(NOTE))).toBe(true);
  });

  it("skips a CLAUDE.md linked to a file outside", () => {
    writeFileSync(join(outside, "CLAUDE.md"), "# Outside heading\n");
    symlinkSync(join(outside, "CLAUDE.md"), join(project, "CLAUDE.md"));
    const survey = surveyHarness(project, undetermined);
    expect(survey.hasClaudeMd).toBe(true);
    expect(survey.claudeMdHeadings).toEqual([]);
    expect(undetermined.some((note) => note.includes(NOTE))).toBe(true);
  });

  it("skips a SKILL.md linked to a file outside", () => {
    mkdirSync(join(project, ".claude", "skills", "x"), { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: stolen\n---\n");
    symlinkSync(
      join(outside, "SKILL.md"),
      join(project, ".claude", "skills", "x", "SKILL.md"),
    );
    const survey = surveyHarness(project, undetermined);
    expect(survey.skills).toEqual([]);
    expect(undetermined.some((note) => note.includes(NOTE))).toBe(true);
  });

  it("lists nothing from a rules directory linked to one outside", () => {
    mkdirSync(join(outside, "rules"));
    writeFileSync(join(outside, "rules", "r.md"), "---\npaths: x\n---\n");
    symlinkSync(join(outside, "rules"), join(project, ".claude", "rules"));
    const survey = surveyHarness(project, undetermined);
    expect(survey.rules).toEqual([]);
    expect(undetermined.some((note) => note.includes(NOTE))).toBe(true);
  });

  it("still follows a symlink that stays inside the project", () => {
    mkdirSync(join(project, ".claude", "agents"));
    mkdirSync(join(project, "shared"));
    writeFileSync(join(project, "shared", "agent.md"), AGENT);
    symlinkSync(
      join(project, "shared", "agent.md"),
      join(project, ".claude", "agents", "inside.md"),
    );
    const survey = surveyHarness(project, undetermined);
    expect(survey.agents).toEqual([{ name: "inside", model: "opus" }]);
    expect(undetermined.some((note) => note.includes(NOTE))).toBe(false);
  });
});
