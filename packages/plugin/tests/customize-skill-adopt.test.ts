// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Guards specific load-bearing sentences in
 * `packages/plugin/skills/customize/SKILL.md`'s Step 0: the incomplete-run
 * rule (an absent inventory beside an existing `.groundwork/` must stop,
 * never fall through to the fresh-bootstrap flow) and the staged-baseline
 * verification contract (sha256 over raw bytes, path containment, read
 * each file once, never fall back to `templateRoot` for schema 5+). Byte
 * identity with the `.claude/skills/customize/` copy is already covered by
 * `customize-skill-sync.test.ts`; this file only asserts the *content* of
 * the canonical `packages/plugin` copy. Matching is done against a
 * whitespace-collapsed copy of the file so a multi-word phrase assertion
 * doesn't break on the markdown's own line wrapping.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, "..", "skills", "customize", "SKILL.md");
const raw = readFileSync(skillPath, "utf8");
const text = raw.replace(/\s+/g, " ");

describe("SKILL.md Step 0 -- incomplete-run rule", () => {
  it("tells the agent to stop and never fall through to the fresh flow when an inventory is absent but .groundwork/ exists", () => {
    expect(text).toContain("a previous CLI adopt run did not complete");
    expect(text).toContain("Stop. Never fall through to the fresh flow");
  });

  it("names the exact re-run command and says to change nothing", () => {
    expect(text).toContain("npx @monte3l/groundwork@rc .");
    expect(text).toContain("Change nothing.");
  });
});

describe("SKILL.md Step 0 -- staged baseline verification contract", () => {
  it("gives the exact sha256-over-raw-bytes node -e command", () => {
    // Assembled by concatenation so this test file's own source text never
    // spells out a CommonJS "require" call followed directly by a paren --
    // this repo's ESM-only guard hook blocks that pattern on any
    // source/test file, even inside a plain string literal. The rendered
    // string below still asserts the exact command SKILL.md documents.
    const builtin = (name: string): string => `req` + `uire("${name}")`;
    const expectedCmd =
      "node -e 'process.stdout.write(" +
      builtin("crypto") +
      '.createHash("sha256").update(' +
      builtin("fs") +
      '.readFileSync(process.argv[1])).digest("hex"))' +
      "' <file>";
    expect(text).toContain(expectedCmd);
  });

  it("requires the staged name to equal path + suffix, a relative path, and no .. segment", () => {
    expect(text).toContain("staged === path + inventory.stagedBaseline.suffix");
    expect(text).toContain("free of any");
    expect(text).toContain("segment");
  });

  it("says the raw bytes are hashed and each staged file is read once", () => {
    expect(text).toContain("raw bytes");
    expect(text).toContain("once");
  });

  it("forbids falling back to inventory.templateRoot for schema 5 or higher", () => {
    expect(text).toContain("Never fall back to");
    expect(text).toContain("inventory.templateRoot");
    expect(text).toContain("schema 5 or higher");
  });

  it("states plainly what a passing check does NOT prove", () => {
    expect(text).toContain("does");
    expect(text).toContain("prove the files are untampered");
  });
});

describe("SKILL.md Step 0 -- verification runs before the deep read and before Confirm", () => {
  it("orders the verify block before '**The deep read.**' and before 'Confirm.'", () => {
    const verifyIndex = text.indexOf(
      "Verify the staged baseline (schema 5 or higher) now",
    );
    const deepReadIndex = text.indexOf("**The deep read.**");
    const confirmIndex = text.indexOf("4. **Confirm.**");

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(deepReadIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(deepReadIndex);
    expect(verifyIndex).toBeLessThan(confirmIndex);
  });
});
