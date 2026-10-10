// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Collects the whole `.claude/` surface of an existing project -- hook
 * wiring, agent/skill/rule frontmatter, commands, and `CLAUDE.md`'s heading
 * outline -- so `/customize`'s harness sweep starts from what is actually
 * there instead of assuming the m3l-groundwork baseline.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { fieldText, parseFrontmatter } from "../harness/frontmatter.js";
import {
  SurveyReadError,
  guardedExists,
  guardedRead,
  isAbsentError,
  probeSubject,
  unreadableNote,
  unresolvableCode,
} from "./internal/read-guard.js";
import type {
  HarnessAgent,
  HarnessRule,
  HarnessSkill,
  HarnessSurvey,
  PluginLayout,
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
  if (!guardedExists(dir, undetermined)) return [];
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
  if (!guardedExists(skillsDir, undetermined)) return [];
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
    if (!guardedExists(skillFile, undetermined)) continue;
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
  if (!guardedExists(path, undetermined)) return [];
  const content = readText(path, undetermined);
  return content === undefined ? [] : extractHeadings(content);
}

/** The plugin manifest's repository-relative path. */
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/**
 * The root plugin components, in the fixed order `pluginLayout.components`
 * reports them: each one's display name, its path segments, and the entry
 * type it must be to count.
 */
const PLUGIN_COMPONENTS: readonly {
  readonly name: string;
  readonly segments: readonly string[];
  readonly kind: "file" | "dir";
}[] = [
  { name: "hooks/hooks.json", segments: ["hooks", "hooks.json"], kind: "file" },
  { name: "skills/", segments: ["skills"], kind: "dir" },
  { name: "agents/", segments: ["agents"], kind: "dir" },
  { name: "commands/", segments: ["commands"], kind: "dir" },
  { name: ".mcp.json", segments: [".mcp.json"], kind: "file" },
];

/**
 * `lstat`s `path` -- the entry itself, never a symlink's target. Absent
 * (`ENOENT`/`ENOTDIR`) answers `undefined` with nothing recorded; a
 * permission failure or symlink loop is recorded in `undetermined` the way
 * `guardedExists` records it, and answers `undefined`. Any other failure
 * throws a {@link SurveyReadError} naming `path`, with the original as
 * `cause`.
 */
function guardedLstat(path: string, undetermined: string[]): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isAbsentError(error)) return undefined;
    const code = unresolvableCode(error);
    if (code === undefined) {
      throw new SurveyReadError(`could not check whether ${path} exists`, {
        cause: error,
      });
    }
    undetermined.push(unreadableNote(probeSubject(path, code), code));
    return undefined;
  }
}

/**
 * A Claude Code plugin repository's root layout, or `null` unless
 * `.claude-plugin/plugin.json` is a regular file. Every probe is an `lstat`
 * of the path's final component, so a symlinked manifest or component is
 * never followed or counted; a symlinked parent directory (`.claude-plugin/`,
 * `hooks/`) is resolved by the OS and followed. A manifest that exists but is
 * not a regular file, or that this process may not probe, is recorded in
 * `undetermined` and answers `null`. A symlinked component is recorded in
 * `undetermined` and not counted; a component whose probe fails with
 * `EACCES`/`EPERM`/`ELOOP` is recorded and omitted, the layout staying
 * non-null; a component of the wrong non-symlink type is silently omitted.
 */
function surveyPluginLayout(
  dir: string,
  undetermined: string[],
): PluginLayout | null {
  const manifestPath = join(dir, PLUGIN_MANIFEST);
  const manifest = guardedLstat(manifestPath, undetermined);
  if (manifest === undefined) return null;
  if (!manifest.isFile()) {
    const what = manifest.isSymbolicLink()
      ? "symlink, not followed"
      : "directory or special file";
    undetermined.push(
      `${manifestPath} exists but is not a regular file (${what}) -- plugin layout not surveyed`,
    );
    return null;
  }
  const components = PLUGIN_COMPONENTS.filter(({ segments, kind }) => {
    const componentPath = join(dir, ...segments);
    const stats = guardedLstat(componentPath, undetermined);
    if (stats === undefined) return false;
    if (stats.isSymbolicLink()) {
      undetermined.push(
        `${componentPath} is a symlink, not followed -- plugin component not counted`,
      );
      return false;
    }
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  }).map(({ name }) => name);
  return { manifest: PLUGIN_MANIFEST, components };
}

/**
 * Surveys the `.claude/` harness and `CLAUDE.md` at `dir`. Offline,
 * read-only. A file or directory that exists but cannot be read
 * (`EACCES`/`EPERM`) is left out of its collection and recorded in
 * `undetermined` -- an unreadable `CLAUDE.md` still counts as present, with
 * no headings. A `.claude/` this process may not enter is still `present`,
 * with every collection empty and the directory recorded in `undetermined`
 * -- never reported as an empty harness. `pluginLayout` records a plugin
 * repository's root layout (`.claude-plugin/plugin.json` and its root
 * components), each probed by `lstat` of the path's final component, so a
 * symlinked manifest or component is never counted (a symlinked parent
 * directory is followed). A manifest that is not a regular file, or whose
 * probe this process may not make, is recorded in `undetermined` and leaves
 * it `null`; a symlinked component, or one whose probe fails with
 * `EACCES`/`EPERM`/`ELOOP`, is recorded and omitted while the layout stays
 * non-null. Any other read failure throws, naming the path, with the original
 * failure as `cause`.
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
  const hasClaudeMd = guardedExists(claudeMdPath, undetermined);

  if (!guardedExists(claudeDir, undetermined)) {
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
      pluginLayout: surveyPluginLayout(dir, undetermined),
    };
  }

  const settingsPath = join(claudeDir, "settings.json");

  return {
    present: true,
    settingsFile: guardedExists(settingsPath, undetermined)
      ? "settings.json"
      : undefined,
    agents: surveyAgents(claudeDir, undetermined),
    skills: surveySkills(claudeDir, undetermined),
    hooks: surveyHooks(claudeDir, undetermined),
    rules: surveyRules(claudeDir, undetermined),
    commands: surveyCommands(claudeDir, undetermined),
    hasSettingsLocal: guardedExists(
      join(claudeDir, "settings.local.json"),
      undetermined,
    ),
    hasClaudeMd,
    claudeMdHeadings: claudeMdHeadings(claudeMdPath, undetermined),
    pluginLayout: surveyPluginLayout(dir, undetermined),
  };
}
