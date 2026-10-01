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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
  it("extracts the documented node -e command and runs it, matching node:crypto's own sha256 of the same raw bytes", () => {
    const match = /`(node -e [^`]+)`/.exec(raw);
    expect(match).not.toBeNull();
    const template = match?.[1] ?? "";
    expect(template).toContain("<file>");
    // "POSIX shell" is prose ahead of the command, not inside the extracted
    // template itself.
    expect(text).toContain("POSIX shell");

    if (process.platform === "win32") {
      // sh -c is not a POSIX shell on win32 -- nothing further to run there.
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "skill-sha256-"));
    try {
      const fixture = join(dir, "fixture.bin");
      // CRLF plus a non-UTF8 byte (0xff): proves the command hashes raw
      // bytes, with no end-of-line normalization or text decoding.
      const bytes = Buffer.from([0x0d, 0x0a, 0xff, 0x41, 0x0d, 0x0a]);
      writeFileSync(fixture, bytes);

      // The fixture path is passed as a real shell positional argument
      // ($1), never spliced into the command string via String.replace --
      // a path containing a space, `$&`, or a quote would otherwise either
      // be word-split or trigger parameter expansion. See the dedicated
      // test below for a fixture path that actually exercises this.
      const command = template.replace("<file>", '"$1"');
      const output = execFileSync("sh", ["-c", command, "sh", fixture], {
        encoding: "utf8",
      });

      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(output.trim()).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes a fixture whose directory name contains a space and '$&', proving the path is passed as a shell argument rather than spliced into the command string", () => {
    const match = /`(node -e [^`]+)`/.exec(raw);
    const template = match?.[1] ?? "";

    if (process.platform === "win32") {
      // sh -c is not a POSIX shell on win32 -- nothing further to run there.
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "skill sha256 $& -"));
    try {
      const fixture = join(dir, "fixture.bin");
      const bytes = Buffer.from([0x41, 0x42, 0x43]);
      writeFileSync(fixture, bytes);

      const command = template.replace("<file>", '"$1"');
      const output = execFileSync("sh", ["-c", command, "sh", fixture], {
        encoding: "utf8",
      });

      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(output.trim()).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the staged name to equal path + suffix, a relative path, and no .. segment", () => {
    // The suffix is the literal ".staged" the skill itself documents, not a
    // value read back out of the untrusted inventory.
    expect(text).toContain('staged === path + ".staged"');
    expect(text).toContain("free of any");
    expect(text).toContain("segment");
  });

  it("says the raw bytes are hashed and each staged file is read once", () => {
    expect(text).toContain("raw bytes");
    expect(text).toContain("once");
  });

  it("forbids falling back to inventory.templateRoot except for a schema 1-4 inventory", () => {
    expect(text).toContain("Never fall back to");
    expect(text).toContain("inventory.templateRoot");
    expect(text).toContain("schema 1-4 inventory only");
  });

  it("states plainly what a passing check does NOT prove", () => {
    expect(text).toContain("does");
    expect(text).toContain("prove the files are untampered");
  });
});

describe("SKILL.md Step 0 -- staged baseline verification details", () => {
  it("requires stagedBaseline.dir and suffix to equal the documented literals exactly", () => {
    expect(text).toContain(
      "stagedBaseline.dir` must equal `.groundwork/baseline` exactly",
    );
    expect(text).toContain(
      "stagedBaseline.suffix` must equal `.staged` exactly",
    );
  });

  it("requires path to carry no backslash or colon (a Windows-shaped path smuggled into a POSIX-only field)", () => {
    expect(text).toContain("path` contains a `\\` or a `:`");
  });

  it("repeats the 'was never adopted' phrase used by the incomplete-run rule's fresh-vs-adopted branch (not a verification-failure message)", () => {
    // This phrase lives in Step 0's "absent inventory but .groundwork/
    // exists" branch (see the "incomplete-run rule" describe block above),
    // not in the staged-baseline verification-failure message -- this test
    // only pins that the exact wording survives, wherever it lives.
    expect(text).toContain("was never adopted");
  });
});

describe("SKILL.md Step 0.1 section (heading-scoped: '1. Look for' through '2. **The deep read.**')", () => {
  const sectionStart = text.indexOf("1. Look for");
  const sectionEnd = text.indexOf("2. **The deep read.**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.1 section markers ('1. Look for' / '2. **The deep read.**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("states the absent/stagedBaseline.files disagreement rule INSIDE Step 0.1, not deferred to Step 3", () => {
    expect(section).toContain("`absent`");
    expect(section).toContain("`stagedBaseline.files`");
    expect(section).toContain("disagree");
  });

  it("names the literal staged-file path .groundwork/baseline/<staged>", () => {
    expect(section).toContain(".groundwork/baseline/<staged>");
  });

  it('rejects a path of "" or "." in the path validation list', () => {
    const validationStart = section.indexOf(
      "For every entry of `inventory.stagedBaseline.files`",
    );
    const validationEnd = section.indexOf(
      "Read each staged file at",
      validationStart,
    );
    expect(validationStart).toBeGreaterThan(-1);
    expect(validationEnd).toBeGreaterThan(validationStart);
    const validationList = section.slice(validationStart, validationEnd);
    expect(validationList).toContain('"."');
    expect(validationList).toContain('""');
  });

  it("stops for an inventory.json that is not valid JSON or a schemaVersion that is not an integer >= 1, naming the re-run command and changing nothing", () => {
    expect(section).toContain("not valid JSON");
    expect(section).toContain("integer");
    expect(section).toContain("npx @monte3l/groundwork@rc .");

    const idx = section.indexOf("not valid JSON");
    expect(idx).toBeGreaterThan(-1);
    expect(section.slice(idx, idx + 400)).toContain("change nothing");
  });

  it("says to change nothing in the same breath as the schemaVersion-higher-than-5 stop", () => {
    const idx = section.indexOf("higher than 5");
    expect(idx).toBeGreaterThan(-1);
    expect(section.slice(idx, idx + 400)).toContain("change nothing");
  });

  it("names invalid entry, missing file, hash mismatch, a stagedBaseline.files set mismatch, and a duplicate staged/path entry in the single stop list", () => {
    const bulletStart = section.indexOf("**Any invalid entry");
    const bulletEnd = section.indexOf(
      "What a passing check proves",
      bulletStart,
    );
    expect(bulletStart).toBeGreaterThan(-1);
    expect(bulletEnd).toBeGreaterThan(bulletStart);
    const bullet = section.slice(bulletStart, bulletEnd);

    expect(bullet).toContain("invalid entry");
    expect(bullet).toContain("missing file");
    expect(bullet).toContain("hash mismatch");
    expect(bullet).toContain("do not name the same set");
    expect(bullet).toContain("duplicate");
  });

  it("rejects a duplicate staged or path entry somewhere in the validation list", () => {
    expect(section).toContain("duplicate");
  });

  it("tells the agent to pass the file to the hash one-liner as a single quoted argument", () => {
    expect(section).toContain("single quoted argument");
  });

  it("says the schemaVersion-higher-than-5 stop names /plugin update, the re-run command, and the project-local reason /plugin update alone can't fix it", () => {
    const idx = section.indexOf("higher than 5");
    expect(idx).toBeGreaterThan(-1);
    // Widened from 650: the corrected local-copy advice (delete-first,
    // names both local-copy locations) lengthened this paragraph.
    const window = section.slice(idx, idx + 1100);
    expect(window).toContain("/plugin update");
    expect(window).toContain("npx @monte3l/groundwork@rc .");
    expect(window).toContain("project-local");
  });

  it("names stagedBaseline missing, not an object, or files not an array in the single stop list bullet", () => {
    const bulletStart = section.indexOf(
      "**For a schema 5 inventory, a `stagedBaseline` that is missing",
    );
    const bulletEnd = section.indexOf(
      "What a passing check proves",
      bulletStart,
    );
    expect(bulletStart).toBeGreaterThan(-1);
    expect(bulletEnd).toBeGreaterThan(bulletStart);
    const bullet = section.slice(bulletStart, bulletEnd);

    expect(bullet).toContain("not an object");
    expect(bullet).toContain("not an array");
  });

  it("drops the impossible '(schema 5 or higher)' / 'schema 5 or higher.**' wording now that anything above 5 stops earlier, while the schema 1-4 templateRoot fallback rule still survives", () => {
    expect(section).not.toContain("(schema 5 or higher)");
    expect(section).not.toContain("schema 5 or higher.**");
    expect(text).toContain("schema 1-4");
    expect(text).toContain("inventory.templateRoot");
  });
});

describe("SKILL.md Step 0.1 -- native vs relative/POSIX path fields", () => {
  // Same heading-scoped slice as the "Step 0.1 section" describe block above
  // (a module-level `section` would leak the first describe's scope, so this
  // is recomputed locally per the test-author instructions).
  const sectionStart = text.indexOf("1. Look for");
  const sectionEnd = text.indexOf("2. **The deep read.**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.1 section markers ('1. Look for' / '2. **The deep read.**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("no longer makes the blanket claim that every path in the inventory uses `/` separators", () => {
    expect(section).not.toContain("All paths in the inventory use");
  });

  it("scopes the `/`-separator claim to the specific relative-path fields it actually holds, naming each within 400 chars of the scoped sentence", () => {
    const idx = section.indexOf(
      "These fields use `/` separators on every platform",
    );
    expect(idx).toBeGreaterThan(-1);

    const window = section.slice(idx, idx + 400);
    expect(window).toContain("`conflicts[].relPath`");
    expect(window).toContain("`packs[].fileConflicts[].relPath`");
    expect(window).toContain("`stagedBaseline.dir`");
    expect(window).toContain("`stagedBaseline.files[].path`");
    expect(window).toContain("`.staged`");
  });

  it("says templateRoot and targetDir are native paths, not `/`-separated", () => {
    expect(section).toContain("`templateRoot` and `targetDir`");
  });
});

describe("SKILL.md Round 1's approved-additions bullet", () => {
  it("still carries a short pointer back at Step 0.1 for the staged-copy install", () => {
    const additionsStart = text.indexOf("The **approved additions**");
    const additionsEnd = text.indexOf(
      "The **approved conflict resolutions**",
      additionsStart,
    );
    expect(additionsStart).toBeGreaterThan(-1);
    expect(additionsEnd).toBeGreaterThan(additionsStart);
    const bullet = text.slice(additionsStart, additionsEnd);
    expect(bullet).toContain("Step 0.1");
  });
});

describe("SKILL.md Step 0 -- verification runs before the deep read and before Confirm", () => {
  it("orders the verify block before '**The deep read.**' and before 'Confirm.'", () => {
    const verifyIndex = text.indexOf("verify the staged baseline now");
    const deepReadIndex = text.indexOf("**The deep read.**");
    const confirmIndex = text.indexOf("4. **Confirm.**");

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(deepReadIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(deepReadIndex);
    expect(verifyIndex).toBeLessThan(confirmIndex);
  });
});

describe("SKILL.md Step 0.1 -- the staged-baseline verify block is scoped to schema 5 only", () => {
  // Same heading-scoped slice as the "Step 0.1 section" describe block above
  // (a module-level `section` would leak the first describe's scope, so this
  // is recomputed locally per the test-author instructions).
  const sectionStart = text.indexOf("1. Look for");
  const sectionEnd = text.indexOf("2. **The deep read.**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.1 section markers ('1. Look for' / '2. **The deep read.**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  const headerPhrase = "For a schema 5 inventory only";
  const fullHeaderSubstring =
    "**For a schema 5 inventory only: verify the staged baseline now";
  const scopeSentence =
    "A schema 1-4 inventory has no `stagedBaseline`: skip this whole block";
  const stopBulletSubstring =
    "**For a schema 5 inventory, a `stagedBaseline` that is missing";

  function allIndicesOf(haystack: string, needle: string): number[] {
    const indices: number[] = [];
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      indices.push(index);
      index = haystack.indexOf(needle, index + 1);
    }
    return indices;
  }

  it("states the verify block applies to a schema 5 inventory only, and names the schema 1-4 skip in the same breath", () => {
    expect(section).toContain(fullHeaderSubstring);
    expect(section).toContain(scopeSentence);
  });

  it("opens the single stop list bullet with the schema-5-only phrasing", () => {
    expect(section).toContain(stopBulletSubstring);
  });

  it("places the schema-5-only scope statement before the first `stagedBaseline.dir` mention and before the stop bullet's 'that is missing' text", () => {
    const headerIndex = section.indexOf(headerPhrase);
    const dirIndex = section.indexOf("`stagedBaseline.dir`");
    const stopBulletIndex = section.indexOf(stopBulletSubstring);
    const thatIsMissingIndex = section.indexOf("that is missing");

    expect(headerIndex).toBeGreaterThan(-1);
    expect(dirIndex).toBeGreaterThan(-1);
    expect(stopBulletIndex).toBeGreaterThan(-1);
    expect(thatIsMissingIndex).toBeGreaterThan(-1);

    expect(headerIndex).toBeLessThan(dirIndex);
    expect(headerIndex).toBeLessThan(stopBulletIndex);
    expect(headerIndex).toBeLessThan(thatIsMissingIndex);
  });

  it("keeps every stagedBaseline.files/dir/suffix mention and the 'missing, not an object' bullet wording after the schema-5-only scope statement", () => {
    const headerIndex = section.indexOf(headerPhrase);
    expect(headerIndex).toBeGreaterThan(-1);

    const needles = [
      "stagedBaseline.files",
      "stagedBaseline.dir",
      "stagedBaseline.suffix",
      "missing, not an object",
    ];
    for (const needle of needles) {
      const occurrences = allIndicesOf(section, needle);
      expect(occurrences.length).toBeGreaterThan(0);
      for (const occurrenceIndex of occurrences) {
        expect(occurrenceIndex).toBeGreaterThan(headerIndex);
      }
    }
  });

  it("still gives the schema 1-4 templateRoot fallback alongside the skip-this-block instruction", () => {
    expect(section).toContain("skip this whole block");
    expect(section).toContain("templateRoot");
  });
});

describe("SKILL.md Step 3 Round 1 -- schema-5 install condition wording", () => {
  const step3Start = text.indexOf("## Step 3");
  if (step3Start === -1) {
    throw new Error("'## Step 3' heading was not found in SKILL.md");
  }
  const step3Text = text.slice(step3Start);

  it("no longer gates the staged-copy install on the old '`schemaVersion` 5 or higher' wording", () => {
    expect(step3Text).not.toContain("`schemaVersion` 5 or higher");
  });

  it("states the schema-5 install condition with the new wording", () => {
    expect(step3Text).toContain("For a schema 5 inventory, install them");
  });
});

describe("SKILL.md Step 0.1 -- corrected local-copy advice for a schemaVersion higher than 5", () => {
  const higherThan5Index = text.indexOf("higher than 5");

  it("finds the 'higher than 5' paragraph", () => {
    expect(higherThan5Index).toBeGreaterThan(-1);
  });

  it("tells the agent to delete the stale local copy first, names both local-copy locations, and says /plugin update does not load a deleted copy back", () => {
    const window = text.slice(higherThan5Index, higherThan5Index + 1100);
    expect(window).toContain("delete that directory first");
    expect(window).toContain("`.claude/skills/customize/`");
    expect(window).toContain("never overwrites a copy that differs");
    expect(window).toContain("`.groundwork/customize/`");
    expect(window).toContain("does not load");
    expect(window).toContain("`/plugin update`");
  });

  it("drops the incorrect claim that re-running the CLI refreshes the plugin's local copy", () => {
    const window = text.slice(higherThan5Index, higherThan5Index + 1100);
    expect(window).not.toContain("so the CLI refreshes its local copy");
  });

  it("warns that deleting `.claude/skills/customize/` discards any local edits", () => {
    const window = text.slice(higherThan5Index, higherThan5Index + 1100);
    expect(window).toContain("discards any local edits");
  });
});

describe("SKILL.md Step 0.4(c) Confirm -- prototype-key check before offering a staged pack", () => {
  // Heading-scoped the same way as the other Step-0 describe blocks above:
  // from the "4. **Confirm.**" item down to the next numbered item, "5.
  // **Record the confirmed decisions**".
  const sectionStart = text.indexOf("4. **Confirm.**");
  const sectionEnd = text.indexOf("5. **Record the confirmed decisions**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.4 Confirm section markers ('4. **Confirm.**' / '5. **Record the confirmed decisions**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("tells the agent to check each staged pack.json.staged for a prototype-sensitive wiring key before offering it", () => {
    expect(section).toContain(
      "Before offering any pack, check each staged `.groundwork/packs/<name>/pack.json.staged`",
    );
  });

  it("says the pack.json.staged bytes checked here are the ones Step 0.1 already read, hash-checked when a command could run, not a fresh read", () => {
    const idx = section.indexOf("`.groundwork/packs/<name>/pack.json.staged`");
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(idx, idx + 200);
    expect(window).toContain("Step 0.1");
    expect(window).toContain("hash-checked when a command could run");
  });

  it("names __proto__, constructor and prototype, and the three wiring fields to check, in document order after the check text", () => {
    const needles = [
      "Before offering any pack, check each staged `.groundwork/packs/<name>/pack.json.staged`",
      "__proto__",
      "constructor",
      "prototype",
      "wiring.settings",
      "wiring.settingsTopLevel",
      "wiring.packageScripts",
      "stop",
      "delete `.groundwork/`",
      "re-run the CLI",
      "Change nothing.",
    ];

    let previousIndex = -1;
    for (const needle of needles) {
      const index = section.indexOf(needle, previousIndex + 1);
      expect(
        index,
        `expected "${needle}" to appear after index ${String(previousIndex)} in the Step 0.4 Confirm section`,
      ).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it("places the 'Change nothing.' stop sentence after the prototype mention and still inside the Step 0.4 Confirm section", () => {
    const prototypeIndex = section.indexOf("prototype");
    const changeNothingIndex = section.indexOf("Change nothing.");

    expect(prototypeIndex).toBeGreaterThan(-1);
    expect(changeNothingIndex).toBeGreaterThan(-1);
    expect(changeNothingIndex).toBeGreaterThan(prototypeIndex);
    // The section slice already ends at "5. **Record the confirmed
    // decisions**", so finding it inside `section` at all proves it is
    // before that boundary.
    expect(changeNothingIndex).toBeLessThan(section.length);
  });
});

describe("SKILL.md Round 1's approved-packs bullet -- prototype-key check before the hand merge", () => {
  // Heading-scoped from "The **approved packs**" (the bullet's own opening)
  // down to the next major heading, "**Plugins (both modes)".
  const sectionStart = text.indexOf("The **approved packs**");
  const sectionEnd = text.indexOf("**Plugins (both modes)");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Round 1 approved-packs section markers ('The **approved packs**' / '**Plugins (both modes)') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("tells the agent to repeat the Step 0.4(c) prototype-key check before merging any staged pack.json.staged wiring", () => {
    expect(section).toContain(
      "Before merging any staged `pack.json.staged` wiring, repeat the prototype-key check from Step 0.4(c)",
    );
  });

  it("puts the repeated prototype-key check before the hand-translation instruction it guards", () => {
    const checkIndex = section.indexOf(
      "Before merging any staged `pack.json.staged` wiring, repeat the prototype-key check from Step 0.4(c)",
    );
    const handTranslateIndex = section.indexOf(
      "then translate `pack.json`'s `wiring` by hand",
    );

    expect(checkIndex).toBeGreaterThan(-1);
    expect(handTranslateIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(handTranslateIndex);
  });

  it("names __proto__, constructor, prototype and 'change nothing' in the repeated check", () => {
    expect(section).toContain("__proto__");
    expect(section).toContain("constructor");
    expect(section).toContain("prototype");
    expect(section).toContain("change nothing");
  });
});

describe("SKILL.md -- the Step 0.4(c) prototype-key check text is not duplicated", () => {
  it("states 'Before offering any pack, check each staged' exactly once in the whole file", () => {
    const needle = "Before offering any pack, check each staged";
    const occurrences = text.split(needle).length - 1;
    expect(occurrences).toBe(1);
  });
});

/*
 * The CLI now stages packs the same inert way it stages the baseline
 * (`pack-stage.ts`): `.groundwork/packs/<name>/pack.json.staged` and
 * `.groundwork/packs/<name>/files/<path>.staged`, recorded in
 * `inventory.stagedPacks` (schema 5, additive -- `packages/cli/src/inventory.ts`).
 * The tests below pin the SKILL.md contract for verifying and installing
 * from that staged copy, mirroring the staged-baseline contract already
 * pinned above. Same heading-scoped-slice discipline as the rest of this
 * file: a shared helper recomputes the Step 0.1 slice per describe block
 * rather than sharing a module-level binding.
 */
function step01Section(): string {
  const sectionStart = text.indexOf("1. Look for");
  const sectionEnd = text.indexOf("2. **The deep read.**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.1 section markers ('1. Look for' / '2. **The deep read.**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  return text.slice(sectionStart, sectionEnd);
}

describe("SKILL.md Step 0.1 schema table -- row 5 documents stagedPacks", () => {
  it("mentions stagedPacks in the schemaVersion 5 table row", () => {
    const rowIndex = text.indexOf("| 5 |");
    expect(rowIndex).toBeGreaterThan(-1);
    const rowEnd = text.indexOf("For a schema 5 inventory only", rowIndex);
    expect(rowEnd).toBeGreaterThan(rowIndex);
    const row = text.slice(rowIndex, rowEnd);
    expect(row).toContain("stagedPacks");
  });
});

describe("SKILL.md Step 0.1 -- staged packs verification (schema 5)", () => {
  const section = step01Section();
  const headerPhrase = "For a schema 5 inventory only";

  it("places the stagedPacks verification after the schema-5-only scope statement", () => {
    const headerIndex = section.indexOf(headerPhrase);
    const dirIndex = section.indexOf("`.groundwork/packs/<name>`");
    expect(headerIndex).toBeGreaterThan(-1);
    expect(dirIndex).toBeGreaterThan(-1);
    expect(headerIndex).toBeLessThan(dirIndex);
  });

  it("requires each stagedPacks entry's dir/suffix to equal the documented literals, built from the entry's own name, taken from the skill not the inventory", () => {
    expect(section).toContain("`.groundwork/packs/<name>`");
    expect(section).toContain("own `name`");
    expect(section).toContain("not from the inventory");
  });

  it("requires name to be a single path segment: not empty, not '.' or '..', and free of a slash, backslash or colon", () => {
    expect(section).toContain("single path segment");
    expect(section).toContain("not empty, not `.` or `..`");
  });

  it("requires manifest.path and manifest.staged to equal the documented literals exactly", () => {
    expect(section).toContain("manifest.path` must equal `pack.json`");
    expect(section).toContain("manifest.staged` must equal `pack.json.staged`");
  });

  it("requires every pack file's staged name to equal path + '.staged', applying the same path validation as the staged baseline's own files", () => {
    const occurrences = (section.match(/staged === path \+ "\.staged"/g) ?? [])
      .length;
    // One occurrence for stagedBaseline.files (already asserted above),
    // a second for stagedPacks' own files -- proves a new instance was
    // added for packs rather than only reusing the baseline's.
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("rejects a duplicate pack name among stagedPacks entries, and a duplicate path/staged within one pack's files", () => {
    expect(section).toContain("duplicate pack `name`");
    const stagedDuplicateOccurrences = (
      section.match(/duplicate `staged`/g) ?? []
    ).length;
    // One occurrence from the staged-baseline rule, a second from the
    // staged-packs rule.
    expect(stagedDuplicateOccurrences).toBeGreaterThanOrEqual(2);
  });

  it("reads the staged manifest and files once each, applying the SHA-256 check above rather than restating the node -e command", () => {
    expect(section).toContain("<dir>/pack.json.staged");
    expect(section).toContain("<dir>/files/<staged>");
    expect(section).toContain("the SHA-256 check above");
  });

  it("states the node -e one-liner exactly once in the whole file (the packs check reuses it rather than repeating it)", () => {
    const needle = "node -e 'process.stdout.write";
    const occurrences = text.split(needle).length - 1;
    expect(occurrences).toBe(1);
  });

  it("requires the set of pack names in inventory.packs to equal stagedPacks, and fileConflicts[].relPath to equal files[].path per pack", () => {
    expect(section).toContain("`inventory.packs`");
    expect(section).toContain("`inventory.stagedPacks`");
    expect(section).toContain("`fileConflicts[].relPath`");
    expect(section).toContain("`files[].path`");
  });

  it("keeps the verified bytes for Round 1's install and for the prototype-key check, instead of reading twice", () => {
    const idx = section.indexOf("the SHA-256 check above");
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(idx, idx + 400);
    expect(window).toContain("Round 1");
    expect(window).toContain("prototype-key check");
  });

  it("says the bytes kept for the staged packs are the ones Step 0.1 read, hash-checked only when a command could run", () => {
    expect(section).toContain(
      "Keep the bytes Step 0.1 read (hash-checked when a command could run)",
    );
  });
});

describe("SKILL.md Step 0.1 -- the single stop list also covers staged packs", () => {
  const section = step01Section();

  it("still describes exactly one 'single stop list' in the whole file", () => {
    const occurrences = text.split("single stop list").length - 1;
    expect(occurrences).toBe(1);
  });

  it("names a missing or non-array stagedPacks as stopping the run for schema 5, in the same stop-list description", () => {
    const idx = section.indexOf("so does a `stagedPacks` that is");
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(idx, idx + 80);
    expect(window).toContain("missing or not an array");
  });

  it("extends the fixed user message to mention both staged directories and the re-run command", () => {
    const idx = section.indexOf(
      "is incomplete or does not match `.groundwork/inventory.json`",
    );
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(Math.max(0, idx - 200), idx + 400);
    expect(window).toContain(".groundwork/baseline/");
    expect(window).toContain(".groundwork/packs/");
    expect(window).toContain("npx @monte3l/groundwork@rc .");
  });

  it("scopes the never-fall-back-to-templateRoot rule to a schema 5 inventory, packs included, dropping the old unscoped wording", () => {
    const idx = section.indexOf("Never fall back to");
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(idx, idx + 200);
    expect(window).toContain("schema 5");
    expect(window).toContain("packs included");
    expect(section).not.toContain("for packs either:");
  });
});

describe("SKILL.md Step 0.1 -- the staged-packs verify block stays scoped to schema 5, same as the staged baseline", () => {
  const section = step01Section();

  it("keeps the schema 1-4 skip statement for the whole block (stagedPacks included, no separate 1-4 handling)", () => {
    expect(section).toContain(
      "A schema 1-4 inventory has no `stagedBaseline`: skip this whole block",
    );
  });
});

describe("SKILL.md Round 1's approved-packs bullet -- installs from the staged, verified, token-substituted copy", () => {
  // Same heading-scoped slice as the "prototype-key check before the hand
  // merge" describe block above.
  const sectionStart = text.indexOf("The **approved packs**");
  const sectionEnd = text.indexOf("**Plugins (both modes)");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Round 1 approved-packs section markers ('The **approved packs**' / '**Plugins (both modes)') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("installs each file from the staged, suffixed path", () => {
    expect(section).toContain("`.groundwork/packs/<name>/files/<path>.staged`");
  });

  it("writes to the project at path with the .staged suffix stripped, never to the staged name", () => {
    expect(section).toContain("the `.staged` suffix stripped");
    expect(section).toContain("never to the staged name");
  });

  // Round 1's approved-packs bullet needs the same rewording the Step 0.1
  // pack bullet and the Step 0.4(c) check already received (a staged pack's
  // files are hash-checked only when a command-running tool is available,
  // per the no-shell fallback a few sections up) -- not yet applied here.
  // This is deliberately RED: the SKILL.md Round 1 wording change hasn't
  // landed yet.
  it("applies token substitution to the bytes Step 0.1 read (hash-checked when a command could run) as it copies, not the old 'verified bytes' wording", () => {
    expect(section).toContain("`__KEY__`");
    expect(section).toContain(
      "using the bytes Step 0.1 read (hash-checked when a command could run)",
    );
    expect(section).not.toContain("using the verified bytes");
  });

  it("tells the agent to strip the .staged suffix for the manual-install pointer too (a non-adopt-capable pack, e.g. publishing)", () => {
    const pointerIdx = section.indexOf("point at `.groundwork/packs/<name>/`");
    expect(pointerIdx).toBeGreaterThan(-1);
    const window = section.slice(pointerIdx, pointerIdx + 250);
    expect(window).toContain("strip");
    expect(window).toContain("`.staged`");
  });

  it("mentions __KEY__ token substitution within 400 chars of the manual-install pointer's strip-the-.staged-suffix instruction", () => {
    const idx = section.indexOf("strip the `.staged` suffix");
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(idx, idx + 400);
    expect(window).toContain("`__KEY__`");
  });
});

describe("SKILL.md Step 0.4(c) Confirm -- schema 1-4 branch reads the unsuffixed pack.json", () => {
  // Same heading-scoped slice as the other Step 0.4(c) describe block above.
  const sectionStart = text.indexOf("4. **Confirm.**");
  const sectionEnd = text.indexOf("5. **Record the confirmed decisions**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.4 Confirm section markers ('4. **Confirm.**' / '5. **Record the confirmed decisions**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("still keeps the schema 5 clause checking the staged pack.json.staged", () => {
    expect(section).toContain(
      "Before offering any pack, check each staged `.groundwork/packs/<name>/pack.json.staged`",
    );
  });

  it("names a schema 1-4 clause naming the unsuffixed pack.json and that it is not hash-verified", () => {
    expect(section).toContain("schema 1-4");
    expect(section).toContain("`.groundwork/packs/<name>/pack.json`");
    expect(section).toContain("not hash-verified");
  });

  it("says the prototype-key check still applies to the unsuffixed pack.json for a schema 1-4 inventory", () => {
    const idx = section.indexOf("`.groundwork/packs/<name>/pack.json`");
    expect(idx).toBeGreaterThan(-1);
    const window = section.slice(Math.max(0, idx - 250), idx + 250);
    expect(window).toContain("prototype-key check");
  });
});

describe("SKILL.md Round 1's approved-packs bullet -- schema 1-4 branch reads the unsuffixed files", () => {
  // Same heading-scoped slice as the other Round 1 approved-packs describe
  // blocks above.
  const sectionStart = text.indexOf("The **approved packs**");
  const sectionEnd = text.indexOf("**Plugins (both modes)");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Round 1 approved-packs section markers ('The **approved packs**' / '**Plugins (both modes)') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  it("still keeps the schema 5 clause installing from files/<path>.staged", () => {
    expect(section).toContain("`.groundwork/packs/<name>/files/<path>.staged`");
  });

  it("names a schema 1-4 clause naming the unsuffixed files/<path>, with no .staged suffix, where token substitution still applies", () => {
    expect(section).toContain("schema 1-4");
    expect(section).toContain("`.groundwork/packs/<name>/files/<path>`");
    expect(section).toContain("no `.staged` suffix");
    expect(section).toContain("token substitution still applies");
  });
});

describe("SKILL.md Step 0.1 schema table -- row 5's 'If absent' cell covers packs too", () => {
  it("mentions the unsuffixed copy packs read for a schema 1-4 inventory, within the rows 1-5 table region", () => {
    const tableStart = text.indexOf("| `schemaVersion` | Adds");
    const tableEnd = text.indexOf("For a schema 5 inventory only", tableStart);
    expect(tableStart).toBeGreaterThan(-1);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const region = text.slice(tableStart, tableEnd);
    expect(region).toContain("unsuffixed");
  });
});

describe("SKILL.md Step 0.1 -- no-shell-tool fallback for the staged-baseline hash check", () => {
  // Same heading-scoped slice as the other Step 0.1 describe blocks above (a
  // module-level `section` would leak scope across describe blocks, so this
  // is recomputed locally per the test-author instructions).
  const sectionStart = text.indexOf("1. Look for");
  const sectionEnd = text.indexOf("2. **The deep read.**");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(
      "Step 0.1 section markers ('1. Look for' / '2. **The deep read.**') were not both found in SKILL.md -- update these markers if the heading text changed",
    );
  }
  const section = text.slice(sectionStart, sectionEnd);

  const keepBytesIndex = section.indexOf("Keep those same bytes");
  const noShellIndex = section.indexOf("No shell tool available.");
  const emptyFilesIndex = section.indexOf("An empty `files` list");
  if (
    noShellIndex === -1 ||
    emptyFilesIndex === -1 ||
    emptyFilesIndex <= noShellIndex
  ) {
    throw new Error(
      "No-shell bullet markers ('No shell tool available.' / 'An empty `files` list') were not both found in the Step 0.1 section -- update these markers if the heading text changed",
    );
  }
  // The no-shell bullet proper: from its own heading through to (but not
  // including) the next bullet, "An empty `files` list".
  const bullet = section.slice(noShellIndex, emptyFilesIndex);

  it("adds a 'No shell tool available.' bullet after the node -e / 'Keep those same bytes' bullet and before the 'An empty files list' bullet", () => {
    expect(keepBytesIndex).toBeGreaterThan(-1);
    expect(emptyFilesIndex).toBeGreaterThan(-1);
    expect(noShellIndex).toBeGreaterThan(keepBytesIndex);
    expect(noShellIndex).toBeLessThan(emptyFilesIndex);
  });

  it("says the with-shell path still applies as documented above when a command-running tool is available", () => {
    expect(section).toContain(
      "If a Bash or other command-running tool is available, compute the hash as above.",
    );
  });

  it("tells the agent not to work around a missing command-running tool", () => {
    expect(section).toContain(
      "If you cannot run a command, do not work around it",
    );
  });

  it.each([
    "write no scratch script",
    "make no `Write` or `Edit` outside `.groundwork/`",
    "dispatch no subagent",
    "search for a command tool at most once",
  ])("forbids the workaround: %s", (forbidden) => {
    expect(section).toContain(forbidden);
  });

  it("limits the skip to the SHA-256 comparison and still requires the structural checks with file tools", () => {
    expect(section).toContain("Skip only the SHA-256 comparison");
    expect(section).toContain("(`Read`, `Glob`, `Grep`)");
  });

  it("says to spend no further turns on verification before moving to the deep read", () => {
    expect(section).toContain("spend no further turns on verification");
  });

  it("describes the Glob-pattern *.staged check that treats a short or truncated result as undetermined rather than a stop, scoped to the no-shell bullet", () => {
    expect(bullet).toContain(
      "the `Glob` pattern `.groundwork/baseline/**/*.staged`",
    );
    expect(bullet).toContain(
      "shorter than `stagedBaseline.files.length`, or that looks truncated, is undetermined",
    );
    expect(bullet).toContain("report it in the Step 0.4 summary and continue");
    expect(bullet).toContain(
      "only an extra `*.staged` file, one whose path is not in `stagedBaseline.files`, stops the run",
    );
    expect(bullet).toContain("partial no-shell substitute");
  });

  it("tells the user the SHA-256 check was skipped, what a passing check would have proven, and which structural checks were verified instead, at the top of the Step 0.4 summary with continue-or-stop asked in the same confirmation", () => {
    expect(bullet).toContain("your first message to the user");
    expect(bullet).toContain("the Step 0.4 summary");
    expect(bullet).toContain("continue or stop");
    expect(bullet).toContain(
      "the SHA-256 check was skipped because no command could be run",
    );
    expect(bullet).toContain(
      "is complete and matches the inventory, not that the files are untampered",
    );
    expect(bullet).toContain("which structural checks you did verify instead");
  });

  it("names what a passing check cannot prove as 'not tamper-resistance', scoped to the no-shell bullet", () => {
    expect(bullet).toContain("not tamper-resistance");
  });

  it("says to record the skip in the adoption report when the findings are written back in Step 0.3", () => {
    expect(bullet).toContain(
      "record the skip in `.groundwork/adoption-report.md` when you write the findings back in Step 0.3",
    );
  });

  it("still stops on a structural failure, including an extra staged file, even when the hash check itself is skipped", () => {
    expect(bullet).toContain(
      "A structural failure, including an extra staged file, still stops",
    );
  });

  it("names an extra staged file not in stagedBaseline.files, tags it '(no-shell path)', and extends the same clause to a pack's own files, in the single stop list", () => {
    const stopListStart = section.indexOf(
      "**For a schema 5 inventory, a `stagedBaseline` that is missing",
    );
    const stopListEnd = section.indexOf(
      "This is the single stop list for the staged baseline and the staged packs.",
    );
    expect(stopListStart).toBeGreaterThan(-1);
    expect(stopListEnd).toBeGreaterThan(stopListStart);
    const stopList = section.slice(stopListStart, stopListEnd);
    expect(stopList).toContain(
      "an extra `*.staged` file not named in `stagedBaseline.files`",
    );
    expect(stopList).toContain("(no-shell path)");
    expect(stopList).toContain("in a pack's `files`");
  });

  it("adds a (d) item to Step 0.4's single confirmation asking whether to continue or stop when the no-shell bullet applied", () => {
    const step04Start = text.indexOf("4. **Confirm.**");
    const step04End = text.indexOf("5. **Record the confirmed decisions**");
    expect(step04Start).toBeGreaterThan(-1);
    expect(step04End).toBeGreaterThan(step04Start);
    const step04 = text.slice(step04Start, step04End);
    expect(step04).toContain("(d) if the no-shell bullet applied");
    expect(step04).toContain(
      "which checks ran instead and any undetermined result",
    );
    expect(step04).toContain("ask whether to continue or stop");
  });

  it("carries the no-shell skip note into the rewritten adoption report when Step 0.3 writes the findings back", () => {
    const step03Start = text.indexOf("3. **Write the findings back**");
    const step03End = text.indexOf("4. **Confirm.**");
    expect(step03Start).toBeGreaterThan(-1);
    expect(step03End).toBeGreaterThan(step03Start);
    const step03 = text.slice(step03Start, step03End);
    expect(step03).toContain(
      "If the no-shell bullet in step 1 applied, carry its skip note into the rewritten report",
    );
    expect(step03).toContain("this step replaces the report's sections");
  });

  it("keeps the with-shell path's node -e one-liner, 'Keep those same bytes', and 'single quoted argument' wording unchanged", () => {
    expect(section).toContain("node -e");
    expect(section).toContain("Keep those same bytes");
    expect(section).toContain("single quoted argument");
  });

  it("states the no-shell clause exactly once in the whole file", () => {
    const needle = "No shell tool available.";
    const occurrences = text.split(needle).length - 1;
    expect(occurrences).toBe(1);
  });
});
