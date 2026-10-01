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

      const command = template.replace("<file>", fixture);
      const output = execFileSync("sh", ["-c", command], { encoding: "utf8" });

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

describe("SKILL.md Step 0 -- staged baseline verification details (hub to add)", () => {
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

  it("names the file that was never adopted when verification fails", () => {
    expect(text).toContain("was never adopted");
  });

  it("flags when stagedBaseline.files disagrees with the inventory's absent conflicts", () => {
    // Step 3 already uses the word "disagree" for an unrelated pack-recommendation
    // comparison, so every occurrence is checked, not just the first --
    // the one this test actually cares about is the one near Step 0.1.
    const windows: string[] = [];
    let fromIndex = 0;
    for (;;) {
      const disagreeIdx = text.indexOf("disagree", fromIndex);
      if (disagreeIdx === -1) break;
      windows.push(
        text.slice(Math.max(0, disagreeIdx - 200), disagreeIdx + 200),
      );
      fromIndex = disagreeIdx + 1;
    }
    expect(windows.length).toBeGreaterThan(0);
    expect(
      windows.some(
        (window) =>
          window.includes("`absent`") &&
          window.includes("stagedBaseline.files"),
      ),
    ).toBe(true);
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
