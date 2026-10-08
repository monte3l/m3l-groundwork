// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `.claude/skills/customize/{domain-map,pack-map,kind-facet-map,plugin-map}.ts`
 * are hand-synced copies of
 * `packages/plugin/src/{domain-map,pack-map,kind-facet-map,plugin-map}.ts`,
 * and `.claude/skills/customize/SKILL.md` is a hand-synced copy of
 * `packages/plugin/skills/customize/SKILL.md` -- this repo's own self-hosted
 * `/customize` install (see CLAUDE.md's "Known gaps" section on
 * self-hosting). Nothing wires the two together automatically, so this test
 * is the only thing that catches one edited without the other.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const srcDir = join(repoRoot, "packages", "plugin", "src");
const skillDir = join(repoRoot, "packages", "plugin", "skills", "customize");
const installedDir = join(repoRoot, ".claude", "skills", "customize");

const syncedFiles: [name: string, sourceDir: string][] = [
  ["domain-map.ts", srcDir],
  ["pack-map.ts", srcDir],
  ["kind-facet-map.ts", srcDir],
  ["plugin-map.ts", srcDir],
  ["SKILL.md", skillDir],
  ["step-0-reconcile.md", skillDir],
  ["step-3-round-1.md", skillDir],
];

describe("customize skill install stays synced with packages/plugin", () => {
  it.each(syncedFiles)(
    "%s is byte-for-byte identical between its source and .claude/skills/customize",
    (name, sourceDir) => {
      const source = readFileSync(join(sourceDir, name), "utf8");
      const installed = readFileSync(join(installedDir, name), "utf8");
      expect(
        installed,
        `.claude/skills/customize/${name} has drifted from its packages/plugin source -- ` +
          `hand-sync the installed copy (or regenerate it) so this repo's self-hosted ` +
          `/customize skill reflects the same guidance it ships to adopters.`,
      ).toBe(source);
    },
  );
});

describe("SKILL.md stays small enough to survive post-compaction re-injection", () => {
  it("is at most 18000 bytes (about 4.5k tokens, under the 5,000-token cap)", () => {
    const bytes = Buffer.byteLength(
      readFileSync(join(skillDir, "SKILL.md"), "utf8"),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(18000);
  });

  it("links only to sibling .md files that exist in the skill directory", () => {
    const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const targets = [...body.matchAll(/\]\(([^)#/\s]+\.md)\)/g)].map(
      (m) => m[1] as string,
    );
    expect(targets).toEqual(
      expect.arrayContaining(["step-0-reconcile.md", "step-3-round-1.md"]),
    );
    for (const target of targets) {
      expect(
        existsSync(join(skillDir, target)),
        `SKILL.md links to ${target}, which does not exist in the skill dir`,
      ).toBe(true);
    }
  });
});
