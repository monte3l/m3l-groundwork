/**
 * `.claude/skills/customize/{domain-map,pack-map,kind-facet-map}.ts` are
 * hand-synced copies of `packages/plugin/src/{domain-map,pack-map,kind-facet-map}.ts`,
 * and `.claude/skills/customize/SKILL.md` is a hand-synced copy of
 * `packages/plugin/skills/customize/SKILL.md` -- this repo's own self-hosted
 * `/customize` install (see CLAUDE.md's "Known gaps" section on
 * self-hosting). Nothing wires the two together automatically, so this test
 * is the only thing that catches one edited without the other.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  ["SKILL.md", skillDir],
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
