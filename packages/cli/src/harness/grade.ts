// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Grades a project's Claude Code harness. `gradeHarness` reads the `.claude/`
 * tree and `CLAUDE.md` once into a `HarnessSnapshot`, then runs every rule in
 * `rules.ts` over it. Offline and read-only -- safe to point at an adopted
 * project.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsoncFile } from "../jsonc.js";
import { walkBounded } from "../survey/fs-walk.js";
import { RULES } from "./rules.js";
import type { HarnessSnapshot, SkillSnapshot } from "./rules.js";
import { HARNESS_CATEGORIES } from "./types.js";
import type {
  CheckTally,
  HarnessCategory,
  HarnessFinding,
  HarnessGrade,
} from "./types.js";

const PROJECT_WALK_DEPTH = 8;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readSettings(path: string): HarnessSnapshot["settings"] {
  if (!existsSync(path)) {
    return { present: false, error: undefined, parsed: undefined };
  }
  const result = readJsoncFile(path);
  return result.ok
    ? { present: true, error: undefined, parsed: result.value }
    : { present: true, error: result.error, parsed: undefined };
}

function loadSnapshot(root: string): HarnessSnapshot {
  const entries = walkBounded(root, PROJECT_WALK_DEPTH);
  const claudeEntries = entries.filter((entry) =>
    entry.relPath.startsWith(".claude/"),
  );

  const readEach = (pattern: RegExp, strip: string): Map<string, string> =>
    new Map(
      claudeEntries
        .filter((entry) => !entry.isDirectory && pattern.test(entry.relPath))
        .map((entry) => [
          entry.relPath.slice(strip.length),
          readText(entry.path) ?? "",
        ]),
    );

  const skills: SkillSnapshot[] = claudeEntries
    .filter(
      (entry) =>
        entry.isDirectory && /^\.claude\/skills\/[^/]+$/.test(entry.relPath),
    )
    .map((dir) => {
      const prefix = `${dir.relPath}/`;
      const files = claudeEntries
        .filter(
          (entry) => !entry.isDirectory && entry.relPath.startsWith(prefix),
        )
        .map((entry) => entry.relPath.slice(prefix.length));
      return {
        name: dir.relPath.slice(".claude/skills/".length),
        skillMd: files.includes("SKILL.md")
          ? readText(join(dir.path, "SKILL.md"))
          : undefined,
        files,
      };
    });

  const settingsLocal = readSettings(
    join(root, ".claude", "settings.local.json"),
  );

  return {
    settings: readSettings(join(root, ".claude", "settings.json")),
    settingsLocal: settingsLocal.parsed,
    settingsLocalError: settingsLocal.error,
    hooks: readEach(/^\.claude\/hooks\/[^/]+$/, ".claude/hooks/"),
    agents: readEach(/^\.claude\/agents\/[^/]+\.md$/, ".claude/agents/"),
    skills,
    rules: readEach(/^\.claude\/rules\/[^/]+\.md$/, ".claude/rules/"),
    claudeMd: readText(join(root, "CLAUDE.md")),
    claudeTree: new Set(claudeEntries.map((entry) => entry.relPath)),
    projectFiles: entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.relPath),
  };
}

function emptyTally(): CheckTally {
  return { checked: 0, failed: 0 };
}

/** Runs every rule over the harness rooted at `rootDir` and tallies the result. */
export function gradeHarness(rootDir: string): HarnessGrade {
  const snapshot = loadSnapshot(rootDir);
  const findings: HarnessFinding[] = [];
  const structural = emptyTally();
  const rubric = Object.fromEntries(
    HARNESS_CATEGORIES.map((category) => [category, emptyTally()]),
  ) as Record<HarnessCategory, CheckTally>;

  for (const rule of RULES) {
    const result = rule.check(snapshot);
    const tally =
      rule.level === "structural" ? structural : rubric[rule.category];
    tally.checked += result.checked;
    tally.failed += result.failures.length;
    for (const failure of result.failures) {
      findings.push({
        ruleId: rule.id,
        level: rule.level,
        category: rule.category,
        subject: failure.subject,
        message: failure.message,
      });
    }
  }

  const rubricChecked = Object.values(rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  const rubricFailed = Object.values(rubric).reduce(
    (sum, tally) => sum + tally.failed,
    0,
  );
  return {
    findings,
    structural,
    rubric,
    rubricScore: rubricChecked === 0 ? 1 : 1 - rubricFailed / rubricChecked,
  };
}
