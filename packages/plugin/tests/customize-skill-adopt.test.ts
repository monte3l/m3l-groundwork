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
    const window = section.slice(idx, idx + 650);
    expect(window).toContain("/plugin update");
    expect(window).toContain("npx @monte3l/groundwork@rc .");
    expect(window).toContain("project-local");
  });

  it("names stagedBaseline missing, not an object, or files not an array in the single stop list bullet", () => {
    const bulletStart = section.indexOf("**A `stagedBaseline` that is missing");
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
    const verifyIndex = text.indexOf("Verify the staged baseline now");
    const deepReadIndex = text.indexOf("**The deep read.**");
    const confirmIndex = text.indexOf("4. **Confirm.**");

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(deepReadIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(deepReadIndex);
    expect(verifyIndex).toBeLessThan(confirmIndex);
  });
});
