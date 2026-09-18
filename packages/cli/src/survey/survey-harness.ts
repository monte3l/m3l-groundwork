/**
 * Collects the whole `.claude/` surface of an existing project -- hook
 * wiring, agent/skill/rule frontmatter, commands, and `CLAUDE.md`'s heading
 * outline -- so `/customize`'s harness sweep starts from what is actually
 * there instead of assuming the m3l-groundwork baseline.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessAgent,
  HarnessRule,
  HarnessSkill,
  HarnessSurvey,
} from "./types.js";

/** Extracts a single frontmatter field's scalar (unquoted) value, or undefined. */
function extractFrontmatterField(
  content: string,
  field: string,
): string | undefined {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (frontmatterMatch?.[1] === undefined) return undefined;
  const fieldPattern = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = fieldPattern.exec(frontmatterMatch[1]);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md"));
}

function surveyAgents(claudeDir: string): HarnessAgent[] {
  const agentsDir = join(claudeDir, "agents");
  return listMarkdownFiles(agentsDir).map((name) => {
    const content = readFileSync(join(agentsDir, name), "utf8");
    return {
      name: name.replace(/\.md$/, ""),
      model: extractFrontmatterField(content, "model"),
    };
  });
}

function surveySkills(claudeDir: string): HarnessSkill[] {
  const skillsDir = join(claudeDir, "skills");
  if (!existsSync(skillsDir)) return [];
  const results: HarnessSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const content = readFileSync(skillFile, "utf8");
    results.push({
      name: extractFrontmatterField(content, "name") ?? entry.name,
      description: extractFrontmatterField(content, "description"),
    });
  }
  return results;
}

function surveyHooks(claudeDir: string): string[] {
  const hooksDir = join(claudeDir, "hooks");
  if (!existsSync(hooksDir)) return [];
  return readdirSync(hooksDir).filter(
    (name) => name.endsWith(".mjs") || name.endsWith(".js"),
  );
}

function surveyRules(claudeDir: string): HarnessRule[] {
  const rulesDir = join(claudeDir, "rules");
  return listMarkdownFiles(rulesDir).map((name) => {
    const content = readFileSync(join(rulesDir, name), "utf8");
    return {
      name: name.replace(/\.md$/, ""),
      paths: extractFrontmatterField(content, "paths"),
    };
  });
}

function surveyCommands(claudeDir: string): string[] {
  const commandsDir = join(claudeDir, "commands");
  return listMarkdownFiles(commandsDir);
}

function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#{1,3}\s*/, "").trim());
}

/** Surveys the `.claude/` harness and `CLAUDE.md` at `dir`. Offline, read-only. */
export function surveyHarness(dir: string): HarnessSurvey {
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
      claudeMdHeadings: hasClaudeMd
        ? extractHeadings(readFileSync(claudeMdPath, "utf8"))
        : [],
    };
  }

  const settingsPath = join(claudeDir, "settings.json");

  return {
    present: true,
    settingsFile: existsSync(settingsPath) ? "settings.json" : undefined,
    agents: surveyAgents(claudeDir),
    skills: surveySkills(claudeDir),
    hooks: surveyHooks(claudeDir),
    rules: surveyRules(claudeDir),
    commands: surveyCommands(claudeDir),
    hasSettingsLocal: existsSync(join(claudeDir, "settings.local.json")),
    hasClaudeMd,
    claudeMdHeadings: hasClaudeMd
      ? extractHeadings(readFileSync(claudeMdPath, "utf8"))
      : [],
  };
}
