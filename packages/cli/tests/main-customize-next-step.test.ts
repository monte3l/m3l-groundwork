// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Item 2 (adopt-mode next-step messaging): `runAdopt`'s console output must
 * never print the generic "open this project in Claude Code and run
 * /customize" next step when `installCustomizeSkillGuarded`'s result
 * `location` is `"groundwork"` -- a fresh skill copy staged at
 * `.groundwork/customize/` is not a path Claude Code loads a skill from, so
 * that generic instruction would be actively misleading. It must instead
 * print a truthful next step: the skill is staged at
 * `.groundwork/customize/`, Claude Code does not load a skill from there,
 * and the real options are running the plugin's own installed `/customize`
 * command or replacing the project-local `.claude/skills/customize/` copy
 * by hand. For `"claude"` and `"already-present"`, the generic next step is
 * still correct (the skill really is loadable from `.claude/`) and must be
 * unchanged.
 *
 * `../src/plugin.js` is mocked -- the direct collaborator `runAdopt` calls
 * -- so each test controls `installCustomizeSkillGuarded`'s return value
 * directly, without needing a real symlink/race fixture to PRODUCE each
 * location (that's covered in plugin-install.test.ts/plugin-symlink.test.ts/
 * plugin-rollback.test.ts). This file only covers what `main()` prints for
 * a given result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installCustomizeSkillGuardedMock = vi.fn();

vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: vi.fn(() => ({ filesWritten: [] })),
  installCustomizeSkillGuarded: installCustomizeSkillGuardedMock,
}));

const { main } = await import("../src/main.js");

const GENERIC_NEXT_STEP = "open this project in Claude Code and run /customize";

/** Runs main() against a fresh adopt-mode project dir, returning every console.log call made during the run, joined by newlines (read BEFORE mockRestore(), which also clears call history). */
function runAndCaptureOutput(projectDir: string): string {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  let output: string;
  try {
    main([projectDir]);
  } finally {
    output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();
  }
  return output;
}

describe("runAdopt's /customize next-step message depends on installCustomizeSkillGuarded's location (item 2)", () => {
  let targetDir: string;
  let projectDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-next-step-"));
    projectDir = join(targetDir, "project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    installCustomizeSkillGuardedMock.mockReset();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('does NOT print the generic next step, and prints a truthful one instead, when location is "groundwork"', () => {
    const fallbackReason = "a project-owned .claude/skills/customize/ differs";
    installCustomizeSkillGuardedMock.mockReturnValue({
      filesWritten: [join(".groundwork", "customize", "SKILL.md")],
      location: "groundwork",
      fallbackReason,
      fallbackCause: "entry",
    });

    const output = runAndCaptureOutput(projectDir);

    expect(output).not.toContain(GENERIC_NEXT_STEP);
    // A truthful replacement: names where the skill actually landed, that
    // Claude Code does not load it from there, and a real way forward.
    expect(output).toContain(".groundwork/customize");
    expect(output.toLowerCase()).toMatch(/does not load/);
    expect(output.toLowerCase()).toMatch(/\/customize|replace/);
    // [this round, item 5] the WHY must be printed too -- deleting main's
    // own print of fallbackReason must fail this assertion.
    expect(output).toContain(fallbackReason);
  });

  it('[regression guard] still prints the generic next step, unchanged, when location is "claude"', () => {
    installCustomizeSkillGuardedMock.mockReturnValue({
      filesWritten: [join(".claude", "skills", "customize", "SKILL.md")],
      location: "claude",
    });

    const output = runAndCaptureOutput(projectDir);

    expect(output).toContain(GENERIC_NEXT_STEP);
  });

  it('[regression guard] still prints the generic next step, unchanged, when location is "already-present"', () => {
    installCustomizeSkillGuardedMock.mockReturnValue({
      filesWritten: [],
      location: "already-present",
    });

    const output = runAndCaptureOutput(projectDir);

    expect(output).toContain("the /customize skill was already up to date");
    expect(output).toContain(GENERIC_NEXT_STEP);
  });
});

/**
 * [this round, item 5] `GuardedInstallResult.fallbackCause` (`"entry"` |
 * `"component"`, see `../src/plugin.js`) distinguishes WHY the
 * `.groundwork/customize/` fallback was taken. The generic "replace the
 * project-local .claude/skills/customize/ copy" advice in the current
 * `"groundwork"` next-step message is only true for `"entry"` (a real
 * project-owned entry exists there to replace); for `"component"` (a
 * symlinked or non-directory `.claude` path component) there is NO such
 * project-local copy -- advising the user to "replace" one would be
 * actively misleading, and the real fix is to fix or replace `.claude`
 * itself.
 */
describe("runAdopt's /customize next-step message distinguishes fallbackCause 'component' from 'entry' (this round, item 5)", () => {
  let targetDir: string;
  let projectDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-next-step-cause-"));
    projectDir = join(targetDir, "project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    installCustomizeSkillGuardedMock.mockReset();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('fallbackCause "component": does not advise replacing a project-local .claude/skills/customize/ copy (none exists), and instead says to fix/replace .claude', () => {
    installCustomizeSkillGuardedMock.mockReturnValue({
      filesWritten: [join(".groundwork", "customize", "SKILL.md")],
      location: "groundwork",
      fallbackReason: `${join(projectDir, ".claude")} is a symlink, so the /customize skill was installed into .groundwork/customize/ instead`,
      fallbackCause: "component",
    });

    const output = runAndCaptureOutput(projectDir);

    expect(output).not.toContain(
      "replace the project-local .claude/skills/customize",
    );
    expect(output.toLowerCase()).toMatch(/fix|replace/);
    expect(output).toContain(".claude");
  });

  it('fallbackCause "entry": keeps the replace-the-project-copy advice unchanged', () => {
    installCustomizeSkillGuardedMock.mockReturnValue({
      filesWritten: [join(".groundwork", "customize", "SKILL.md")],
      location: "groundwork",
      fallbackReason: "a project-owned .claude/skills/customize/ differs",
      fallbackCause: "entry",
    });

    const output = runAndCaptureOutput(projectDir);

    expect(output).toContain(
      "replace the project-local .claude/skills/customize",
    );
  });

  // `GuardedInstallResult`'s own TSDoc says `fallbackCause` is "Set on every
  // 'groundwork' result, and only then" -- a 'groundwork' result with no
  // `fallbackCause` at all is therefore a contract violation from the
  // installer, not a real state `groundworkNextStep` should silently
  // absorb. It throws instead (its own `case undefined` arm), the same way
  // the switch's own `default` arm already throws on a genuinely unhandled
  // value -- and that throw happens before `runAdopt` writes either
  // `.groundwork` file, so neither exists afterward.
  it('throws when location is "groundwork" but fallbackCause is missing, rather than silently treating it as "entry"', () => {
    installCustomizeSkillGuardedMock.mockReturnValue({
      filesWritten: [join(".groundwork", "customize", "SKILL.md")],
      location: "groundwork",
      fallbackReason: "x",
      // fallbackCause deliberately omitted.
    });

    expect(() => main([projectDir])).toThrow(/unhandled fallback cause/);
    expect(existsSync(join(projectDir, ".groundwork", "inventory.json"))).toBe(
      false,
    );
    expect(
      existsSync(join(projectDir, ".groundwork", "adoption-report.md")),
    ).toBe(false);
  });
});

const GENERIC_NEXT_STEP_IN_REPORT =
  "Open this project in Claude Code and run `/customize`.";

/**
 * The written `.groundwork/adoption-report.md`'s own `## Next step` section
 * (via `renderReport`'s second, optional `nextStep` parameter -- see
 * `../src/report.ts`) must agree with what the console already prints (the
 * describe block above): when `installCustomizeSkillGuarded`'s result forces
 * the `.groundwork/customize/` fallback, the report must say so too, instead
 * of keeping its own generic "Open this project in Claude Code and run
 * `/customize`." default -- false in exactly the case that console message
 * exists to correct. For `"claude"`/`"already-present"` the generic sentence
 * is still correct and must remain exactly as `renderReport` renders it with
 * no `nextStep` argument at all.
 *
 * `runAdopt` (`../src/main.ts`) is expected to build its `reportNextStep`
 * for a `"groundwork"` result from `pluginResult.fallbackReason` followed by
 * `groundworkNextStep`'s own staged-location sentence -- the reason a
 * fallback was taken must be named BEFORE that sentence, since
 * `groundworkNextStep`'s `"component"` text says to fix or replace "the
 * .claude path named above", which is only true once the reason naming that
 * path has already appeared earlier in the same text. The tests below read
 * the written report file (not the console) and fail if either half of that
 * wiring regresses: the reason going missing, or the two halves landing in
 * the wrong order.
 */
describe("the written adoption-report.md's ## Next step agrees with the console", () => {
  let targetDir: string;
  let projectDir: string;
  let reportPath: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-next-step-report-"));
    projectDir = join(targetDir, "project");
    reportPath = join(projectDir, ".groundwork", "adoption-report.md");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    installCustomizeSkillGuardedMock.mockReset();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  /** Runs main() against projectDir with console.log suppressed (the console text is covered by the describe block above, not here), then returns the written adoption-report.md's full text. */
  function runAndReadReport(): string {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      main([projectDir]);
    } finally {
      logSpy.mockRestore();
    }
    return readFileSync(reportPath, "utf8");
  }

  it.each(["entry", "component"] as const)(
    'reports the truthful .groundwork/customize/ next step, not the generic one, when location is "groundwork" and fallbackCause is "%s"',
    (fallbackCause) => {
      installCustomizeSkillGuardedMock.mockReturnValue({
        filesWritten: [join(".groundwork", "customize", "SKILL.md")],
        location: "groundwork",
        fallbackReason: "irrelevant to this assertion",
        fallbackCause,
      });

      const report = runAndReadReport();

      expect(report).toContain(".groundwork/customize/");
      expect(report.toLowerCase()).toMatch(/does not load/);
      expect(report).not.toContain(GENERIC_NEXT_STEP_IN_REPORT);
    },
  );

  it.each(["entry", "component"] as const)(
    'names the fallback reason, BEFORE the staged-location sentence, when location is "groundwork" and fallbackCause is "%s"',
    (fallbackCause) => {
      const fallbackReason = `${join(projectDir, ".claude", "skills")} is a symlink, so the /customize skill was installed into .groundwork/customize/ instead`;
      installCustomizeSkillGuardedMock.mockReturnValue({
        filesWritten: [join(".groundwork", "customize", "SKILL.md")],
        location: "groundwork",
        fallbackReason,
        fallbackCause,
      });

      const report = runAndReadReport();

      const reasonIndex = report.indexOf(fallbackReason);
      const stagedSentenceIndex = report.indexOf(
        "is staged at .groundwork/customize/",
      );
      expect(reasonIndex).toBeGreaterThan(-1);
      expect(stagedSentenceIndex).toBeGreaterThan(-1);
      expect(reasonIndex).toBeLessThan(stagedSentenceIndex);
    },
  );

  it.each(["claude", "already-present"] as const)(
    'keeps the generic next step in the report unchanged when location is "%s"',
    (location) => {
      installCustomizeSkillGuardedMock.mockReturnValue(
        location === "claude"
          ? {
              filesWritten: [
                join(".claude", "skills", "customize", "SKILL.md"),
              ],
              location: "claude",
            }
          : { filesWritten: [], location: "already-present" },
      );

      const report = runAndReadReport();

      expect(report).toContain(GENERIC_NEXT_STEP_IN_REPORT);
    },
  );

  it.each(["entry", "component"] as const)(
    'omits a fallback reason cleanly (no literal "undefined" text) and still prints the staged-location sentence, when location is "groundwork", fallbackCause is "%s" and fallbackReason is absent',
    (fallbackCause) => {
      installCustomizeSkillGuardedMock.mockReturnValue({
        filesWritten: [join(".groundwork", "customize", "SKILL.md")],
        location: "groundwork",
        fallbackCause,
        // fallbackReason deliberately omitted.
      });

      const report = runAndReadReport();

      expect(report).not.toContain("undefined");
      expect(report).toContain(".groundwork/customize/");
      expect(report.toLowerCase()).toMatch(/does not load/);
      expect(report).not.toContain(GENERIC_NEXT_STEP_IN_REPORT);
    },
  );

  it.each([
    ["a fallback reason ending in a period", "A custom skill copy exists."],
    [
      "a fallback reason ending in an exclamation mark",
      "A custom skill copy exists!",
    ],
    [
      "a fallback reason ending in a question mark",
      "Does a custom skill copy exist?",
    ],
  ] as const)(
    "joins the fallback reason and the staged-location sentence with exactly one separator, reason first, for %s",
    (_description, fallbackReason) => {
      installCustomizeSkillGuardedMock.mockReturnValue({
        filesWritten: [join(".groundwork", "customize", "SKILL.md")],
        location: "groundwork",
        fallbackReason,
        fallbackCause: "entry",
      });

      const report = runAndReadReport();

      // Already-terminal punctuation gets exactly one joining space before
      // the capitalized sentence -- never a second "." appended, and never
      // a "reason. ." double-separator.
      expect(report).toContain(`${fallbackReason} The current`);
      expect(report).not.toContain(`${fallbackReason}.`);
      expect(report).not.toContain(`${fallbackReason}..`);
      expect(report).not.toContain(`${fallbackReason}. .`);

      const reasonIndex = report.indexOf(fallbackReason);
      const stagedSentenceIndex = report.indexOf(
        "is staged at .groundwork/customize/",
      );
      expect(reasonIndex).toBeGreaterThan(-1);
      expect(stagedSentenceIndex).toBeGreaterThan(-1);
      expect(reasonIndex).toBeLessThan(stagedSentenceIndex);
    },
  );
});
