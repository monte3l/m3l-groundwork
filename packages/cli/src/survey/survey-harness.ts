// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Collects the whole `.claude/` surface of an existing project -- hook
 * wiring, agent/skill/rule frontmatter, commands, and `CLAUDE.md`'s heading
 * outline -- so `/customize`'s harness sweep starts from what is actually
 * there instead of assuming the m3l-groundwork baseline.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fieldText, parseFrontmatter } from "../harness/frontmatter.js";
import { guardedRead } from "./internal/read-guard.js";
import type {
  HarnessAgent,
  HarnessRule,
  HarnessSkill,
  HarnessSurvey,
} from "./types.js";

/**
 * Reads one frontmatter field as text (a list is joined with `, `), or
 * `undefined` when the file has no frontmatter, the field is absent, or its
 * value is empty. Goes through the shared YAML-subset reader so a folded
 * `description: >-` block -- the shape every baseline skill uses -- yields
 * its text rather than the literal `>-`.
 */
function extractFrontmatterField(
  content: string,
  field: string,
): string | undefined {
  const parsed = parseFrontmatter(content);
  if (!parsed.ok) return undefined;
  const text = fieldText(parsed.fields, field);
  return text === undefined || text === "" ? undefined : text;
}

/** Reads `path` as UTF-8 text, or `undefined` (recorded) when it is unreadable. */
function readText(path: string, undetermined: string[]): string | undefined {
  return guardedRead(path, () => readFileSync(path, "utf8"), undetermined);
}

/** Lists `dir`'s entry names: `[]` when it is absent, or unreadable (recorded). */
function listNames(dir: string, undetermined: string[]): string[] {
  if (!existsSync(dir)) return [];
  return guardedRead(dir, () => readdirSync(dir), undetermined) ?? [];
}

function listMarkdownFiles(dir: string, undetermined: string[]): string[] {
  return listNames(dir, undetermined).filter((name) => name.endsWith(".md"));
}

function surveyAgents(
  claudeDir: string,
  undetermined: string[],
): HarnessAgent[] {
  const agentsDir = join(claudeDir, "agents");
  const results: HarnessAgent[] = [];
  for (const name of listMarkdownFiles(agentsDir, undetermined)) {
    const content = readText(join(agentsDir, name), undetermined);
    if (content === undefined) continue;
    results.push({
      name: name.replace(/\.md$/, ""),
      model: extractFrontmatterField(content, "model"),
    });
  }
  return results;
}

function surveySkills(
  claudeDir: string,
  undetermined: string[],
): HarnessSkill[] {
  const skillsDir = join(claudeDir, "skills");
  if (!existsSync(skillsDir)) return [];
  const entries =
    guardedRead(
      skillsDir,
      () => readdirSync(skillsDir, { withFileTypes: true }),
      undetermined,
    ) ?? [];
  const results: HarnessSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const content = readText(skillFile, undetermined);
    if (content === undefined) continue;
    results.push({
      name: extractFrontmatterField(content, "name") ?? entry.name,
      description: extractFrontmatterField(content, "description"),
    });
  }
  return results;
}

function surveyHooks(claudeDir: string, undetermined: string[]): string[] {
  return listNames(join(claudeDir, "hooks"), undetermined).filter(
    (name) => name.endsWith(".mjs") || name.endsWith(".js"),
  );
}

function surveyRules(claudeDir: string, undetermined: string[]): HarnessRule[] {
  const rulesDir = join(claudeDir, "rules");
  const results: HarnessRule[] = [];
  for (const name of listMarkdownFiles(rulesDir, undetermined)) {
    const content = readText(join(rulesDir, name), undetermined);
    if (content === undefined) continue;
    results.push({
      name: name.replace(/\.md$/, ""),
      paths: extractFrontmatterField(content, "paths"),
    });
  }
  return results;
}

function surveyCommands(claudeDir: string, undetermined: string[]): string[] {
  return listMarkdownFiles(join(claudeDir, "commands"), undetermined);
}

function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#{1,3}\s*/, "").trim());
}

/** `CLAUDE.md`'s heading outline: `[]` when it is absent, or unreadable (recorded). */
function claudeMdHeadings(path: string, undetermined: string[]): string[] {
  if (!existsSync(path)) return [];
  const content = readText(path, undetermined);
  return content === undefined ? [] : extractHeadings(content);
}

/**
 * Surveys the `.claude/` harness and `CLAUDE.md` at `dir`. Offline,
 * read-only. A file or directory that exists but cannot be read
 * (`EACCES`/`EPERM`) is left out of its collection and recorded in
 * `undetermined` -- an unreadable `CLAUDE.md` still counts as present, with
 * no headings. Any other read failure throws, naming the path, with the
 * original failure as `cause`.
 *
 * @example
 * ```ts
 * import { surveyHarness } from "./survey-harness.js";
 *
 * const undetermined: string[] = [];
 * const harness = surveyHarness("/path/to/project", undetermined);
 * console.log(harness.agents.map((agent) => agent.name), undetermined);
 * ```
 */
export function surveyHarness(
  dir: string,
  undetermined: string[],
): HarnessSurvey {
  const claudeDir = join(dir, ".claude");
  const claudeMdPath = join(dir, "CLAUDE.md");
  const hasClaudeMd = existsSync(claudeMdPath);

  if (!existsSync(claudeDir)) {
    return {
      present: false,
      settingsFile: undefined,
      agents: [],
      skills: [],
      hooks: [],
      rules: [],
      commands: [],
      hasSettingsLocal: false,
      hasClaudeMd,
      claudeMdHeadings: claudeMdHeadings(claudeMdPath, undetermined),
    };
  }

  const settingsPath = join(claudeDir, "settings.json");

  return {
    present: true,
    settingsFile: existsSync(settingsPath) ? "settings.json" : undefined,
    agents: surveyAgents(claudeDir, undetermined),
    skills: surveySkills(claudeDir, undetermined),
    hooks: surveyHooks(claudeDir, undetermined),
    rules: surveyRules(claudeDir, undetermined),
    commands: surveyCommands(claudeDir, undetermined),
    hasSettingsLocal: existsSync(join(claudeDir, "settings.local.json")),
    hasClaudeMd,
    claudeMdHeadings: claudeMdHeadings(claudeMdPath, undetermined),
  };
}
