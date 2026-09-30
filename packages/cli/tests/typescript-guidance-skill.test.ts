// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// A link-integrity and shape test over the REAL, on-disk baseline
// typescript-guidance skill (templates/core/.claude/skills/typescript-guidance).
// ts-advisor is retired: its recommending-ts-tooling skill is merged into
// this skill as a third mode, "gaps" (research/refresh stay unchanged, for
// questions about tooling the project already has). This test never touches
// the pack -- it asserts the merged shape the baseline skill must have.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/harness/frontmatter.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "core",
  ".claude",
  "skills",
  "typescript-guidance",
);
const skillMdPath = join(skillDir, "SKILL.md");
const referencesDir = join(skillDir, "references");

// Mirrors the private DESCRIPTION_MAX constant in
// templates/core/bin/lib/harness-rules.mjs (not exported, so pinned here by
// value rather than imported) -- a frontmatter description over this length
// is truncated in Claude Code's own skill listing.
const DESCRIPTION_MAX = 1024;

/** Recursively lists every file under a directory (no directory entries). */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("the real templates/core typescript-guidance skill (post ts-advisor merge)", () => {
  const raw = readFileSync(skillMdPath, "utf8");
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) {
    throw new Error(`SKILL.md frontmatter failed to parse: ${parsed.error}`);
  }
  const description = parsed.fields.get("description");
  const descriptionText = Array.isArray(description)
    ? description.join(" ")
    : (description ?? "");
  const bodyLines = parsed.body.split("\n");

  it("keeps the frontmatter description at or under the truncation limit and mentions the new gaps mode", () => {
    expect(descriptionText.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(descriptionText).toMatch(/gaps/i);
  });

  it("documents all three modes with their own section, and stays within the 500-line budget", () => {
    expect(parsed.body).toMatch(/^## Gaps mode$/m);
    expect(parsed.body).toMatch(/^## Research mode$/m);
    expect(parsed.body).toMatch(/^## Refresh mode$/m);
    expect(bodyLines.length).toBeLessThanOrEqual(500);
  });

  it("every references/<name>.md path mentioned in SKILL.md's body actually exists on disk", () => {
    const mentioned = [
      ...new Set(
        [...parsed.body.matchAll(/references\/([\w-]+\.md)/g)].map((m) => m[1]),
      ),
    ];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(
        existsSync(join(referencesDir, String(name))),
        `references/${String(name)} is mentioned in SKILL.md but missing on disk`,
      ).toBe(true);
    }
  });

  it("carries all three reference files: the pre-existing typescript-sources.md plus the two merged in from ts-advisor", () => {
    expect(existsSync(join(referencesDir, "typescript-sources.md"))).toBe(true);
    expect(existsSync(join(referencesDir, "area-catalog.md"))).toBe(true);
    expect(existsSync(join(referencesDir, "tooling-sources.md"))).toBe(true);
  });

  it("tooling-sources.md points at its sibling typescript-sources.md and carries no leftover pack-specific language", () => {
    const toolingSourcesPath = join(referencesDir, "tooling-sources.md");
    const content = readFileSync(toolingSourcesPath, "utf8");
    expect(content).toContain("typescript-sources.md");
    expect(content).not.toMatch(/this pack|\bpack\.json|adoptNotes/i);
  });

  it("SKILL.md's body no longer names the retired pack or its retired skill id", () => {
    expect(parsed.body).not.toContain("recommending-ts-tooling");
    expect(parsed.body).not.toContain("ts-advisor");
  });

  it("ships no hard-coded upstream fact strings -- the skill points at sources, it never states the answer itself", () => {
    for (const filePath of listFilesRecursive(skillDir)) {
      const content = readFileSync(filePath, "utf8");
      expect(content, `${filePath} names a fixed GA date`).not.toMatch(
        /7\.0 went GA/,
      );
      expect(
        content,
        `${filePath} names a fixed pnpm option removal`,
      ).not.toMatch(/onlyBuiltDependencies/);
      expect(
        content,
        `${filePath} names a fixed typescript-eslint version cap`,
      ).not.toMatch(/6\.1\.0/);
    }
  });
});
