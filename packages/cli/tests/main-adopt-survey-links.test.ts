// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `main()` must complete (exit 0, no throw) against a project whose survey
 * hits a dangling symlink (ENOENT), a symlink loop (ELOOP) and a directory
 * standing in for a file (EISDIR) -- none of these is a permission failure
 * (`EACCES`/`EPERM`), so each exercises the gap this suite's siblings
 * (`survey/read-guard.test.ts`, `survey/survey-harness-unreadable.test.ts`,
 * `survey/survey-docs-unreadable.test.ts`) prove at the collector level:
 * `guardedRead` only special-cases EACCES/EPERM today, so ENOENT/ELOOP/EISDIR
 * on a read all throw a `SurveyReadError` instead of being recorded. This
 * file is the end-to-end proof that the same gap, left unfixed, takes down
 * the whole adopt-mode run rather than staying local to one collector --
 * and that once fixed, each path is named (with its errno) under both
 * `.groundwork/inventory.json`'s `survey.undetermined` and
 * `adoption-report.md`'s "## Could not be determined" section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";

function readInventoryUndetermined(groundworkDir: string): string[] {
  const inventory = JSON.parse(
    readFileSync(join(groundworkDir, "inventory.json"), "utf8"),
  ) as { survey: { undetermined: string[] } };
  return inventory.survey.undetermined;
}

function readReportText(groundworkDir: string): string {
  return readFileSync(join(groundworkDir, "adoption-report.md"), "utf8");
}

describe("adopt mode (main()): a dangling symlink, a symlink loop and a directory-in-place-of-a-file are each recorded in undetermined, and the run still completes", () => {
  let workDir: string;
  let projectDir: string;
  let groundworkDir: string;
  let danglingAgent: string;
  let loopDoc: string;
  let claudeMdDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "adopt-survey-links-"));
    projectDir = join(workDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }, null, 2),
    );

    // ENOENT: a dangling symlink standing in for an agent .md.
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    danglingAgent = join(projectDir, ".claude", "agents", "x.md");
    symlinkSync(join(projectDir, "does-not-exist-target"), danglingAgent);

    // ELOOP: a symlink loop standing in for a docs/adr entry.
    mkdirSync(join(projectDir, "docs", "adr"), { recursive: true });
    loopDoc = join(projectDir, "docs", "adr", "loop.md");
    const loopB = join(projectDir, "docs", "adr", "loop-b");
    symlinkSync(loopB, loopDoc);
    symlinkSync(loopDoc, loopB);

    // EISDIR: a directory standing in for CLAUDE.md.
    claudeMdDir = join(projectDir, "CLAUDE.md");
    mkdirSync(claudeMdDir);

    groundworkDir = join(projectDir, ".groundwork");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("completes the run without throwing, and records each path with its errno in both inventory.json and the adoption report", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    } finally {
      logSpy.mockRestore();
    }

    expect(thrown).toBeUndefined();
    expect(existsSync(join(groundworkDir, "inventory.json"))).toBe(true);

    const undetermined = readInventoryUndetermined(groundworkDir);
    expect(
      undetermined.some(
        (entry) => entry.includes(danglingAgent) && entry.includes("ENOENT"),
      ),
    ).toBe(true);
    expect(
      undetermined.some(
        (entry) => entry.includes(loopDoc) && entry.includes("ELOOP"),
      ),
    ).toBe(true);
    expect(
      undetermined.some(
        (entry) => entry.includes(claudeMdDir) && entry.includes("EISDIR"),
      ),
    ).toBe(true);

    const reportText = readReportText(groundworkDir);
    expect(reportText).toContain("## Could not be determined");
    expect(reportText).toContain(danglingAgent);
    expect(reportText).toContain("ENOENT");
    expect(reportText).toContain(loopDoc);
    expect(reportText).toContain("ELOOP");
    expect(reportText).toContain(claudeMdDir);
    expect(reportText).toContain("EISDIR");
  });
});

/**
 * `observeWiring` (`packs.ts`) is called once per pack (`main.ts`'s
 * un-try/catch'd `.map` over `listPackNames()`), unguarded by any
 * `recordedReadCode`-style discrimination -- it only recognizes
 * `EACCES`/`EPERM`. A directory sitting at `.claude/settings.json` makes
 * the prior `stat` (`existsOrObserve`) report `present`, and the
 * subsequent `readFileSync` raise `EISDIR` -- a property of the project's
 * own tree, exactly like the dangling-symlink/symlink-loop/EISDIR cases the
 * sibling describe above already proves at the survey-collector level.
 * `observeWiring` records the EISDIR failure and continues, so the
 * adopt-mode `packs` computation completes and `.groundwork/` is written,
 * reached through `packs.ts` instead of a `survey-*.ts` collector.
 */
describe("adopt mode (main()): a directory sitting at .claude/settings.json does not abort the run (observeWiring's EISDIR)", () => {
  let workDir: string;
  let projectDir: string;
  let groundworkDir: string;
  let settingsDirPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "adopt-settings-eisdir-"));
    projectDir = join(workDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }, null, 2),
    );

    settingsDirPath = join(projectDir, ".claude", "settings.json");
    mkdirSync(settingsDirPath, { recursive: true });

    groundworkDir = join(projectDir, ".groundwork");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("completes the run without throwing, and records the settings path with EISDIR in undetermined", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    } finally {
      logSpy.mockRestore();
    }

    expect(thrown).toBeUndefined();
    expect(existsSync(join(groundworkDir, "inventory.json"))).toBe(true);

    const undetermined = readInventoryUndetermined(groundworkDir);
    expect(
      undetermined.some(
        (entry) => entry.includes(settingsDirPath) && entry.includes("EISDIR"),
      ),
    ).toBe(true);
  });
});
