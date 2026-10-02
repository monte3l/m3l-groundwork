// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2: `surveyHarness` must never abort the whole adopt-mode survey
 * because one project-owned `.claude/` file happens to be unreadable
 * (`EACCES`/`EPERM`, e.g. a `chmod 000` left by a prior run, a root-owned
 * file, a restrictive umask). Every content read in `survey-harness.ts`
 * (an agent `.md`, a skill's `SKILL.md`, a rule `.md`, `CLAUDE.md`) and
 * every directory listing (`.claude/agents`, `.claude/skills`,
 * `.claude/hooks`, `.claude/rules`, `.claude/commands`) must instead record
 * an entry in the shared `undetermined` array (path + errno code) and
 * continue, treating the unreadable entry as if it were simply excluded
 * from that collection -- never silently dropped (see CLAUDE.md's "Adopt
 * mode's contract").
 *
 * This pins `surveyHarness(dir, undetermined)` as a REQUIRED two-argument
 * function, the same shape `surveyShape`/`surveyToolchain` already use (see
 * `survey-shape.test.ts`'s "Contract 6" comment: "so a caller cannot forget
 * to thread the array through") -- `survey-harness.test.ts`'s existing
 * one-argument calls are updated in the same change.
 *
 * The companion EIO/EMFILE (non-permission errno) cases live in
 * `survey-harness-io-error.test.ts`, isolated into their own file because a
 * `vi.mock("node:fs")` there would otherwise intercept every real chmod-based
 * read in this file too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyHarness } from "../../src/survey/survey-harness.js";
import { chmodIneffective } from "../chmod-ineffective.js";

describe("surveyHarness: an unreadable project file is recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-unreadable-"));
    undetermined = [];
  });

  afterEach(() => {
    // Best-effort: restore read/exec permission on anything this suite left
    // locked down so rmSync can actually remove it.
    const tryChmod = (path: string): void => {
      try {
        chmodSync(path, 0o755);
      } catch {
        // already gone or already readable -- fine either way.
      }
    };
    tryChmod(join(dir, ".claude", "agents"));
    tryChmod(join(dir, ".claude", "skills"));
    tryChmod(join(dir, ".claude", "hooks"));
    tryChmod(join(dir, ".claude", "rules"));
    tryChmod(join(dir, ".claude", "commands"));
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "an unreadable agent .md is excluded from agents[] and recorded in undetermined with its path and EACCES",
    () => {
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
      const unreadable = join(dir, ".claude", "agents", "reviewer.md");
      writeFileSync(unreadable, "---\nmodel: sonnet\n---\n# reviewer\n");
      writeFileSync(
        join(dir, ".claude", "agents", "ok.md"),
        "---\nmodel: haiku\n---\n# ok\n",
      );
      chmodSync(unreadable, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.agents).toEqual([{ name: "ok", model: "haiku" }]);
      expect(
        undetermined.some(
          (entry) => entry.includes(unreadable) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable skill's SKILL.md is excluded from skills[] and recorded in undetermined",
    () => {
      mkdirSync(join(dir, ".claude", "skills", "locked"), { recursive: true });
      const unreadable = join(dir, ".claude", "skills", "locked", "SKILL.md");
      writeFileSync(unreadable, "---\nname: locked\n---\n# locked\n");
      mkdirSync(join(dir, ".claude", "skills", "ok"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "skills", "ok", "SKILL.md"),
        "---\nname: ok\n---\n# ok\n",
      );
      chmodSync(unreadable, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.skills).toEqual([{ name: "ok", description: undefined }]);
      expect(
        undetermined.some(
          (entry) => entry.includes(unreadable) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable rule .md is excluded from rules[] and recorded in undetermined",
    () => {
      mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
      const unreadable = join(dir, ".claude", "rules", "scoped.md");
      writeFileSync(unreadable, '---\npaths: "src/**"\n---\nbody\n');
      writeFileSync(
        join(dir, ".claude", "rules", "ok.md"),
        '---\npaths: "tests/**"\n---\nbody\n',
      );
      chmodSync(unreadable, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.rules).toEqual([{ name: "ok", paths: "tests/**" }]);
      expect(
        undetermined.some(
          (entry) => entry.includes(unreadable) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable CLAUDE.md still reports hasClaudeMd true, but with empty headings and an undetermined entry",
    () => {
      const claudeMd = join(dir, "CLAUDE.md");
      writeFileSync(claudeMd, "# Title\n\n## Setup\n");
      chmodSync(claudeMd, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.hasClaudeMd).toBe(true);
      expect(survey?.claudeMdHeadings).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(claudeMd) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable CLAUDE.md is guarded on the no-.claude/-directory branch too",
    () => {
      // No .claude/ directory at all -- exercises the early-return branch
      // (survey-harness.ts's other CLAUDE.md read site) rather than the
      // main return's.
      const claudeMd = join(dir, "CLAUDE.md");
      writeFileSync(claudeMd, "# Title\n");
      chmodSync(claudeMd, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.present).toBe(false);
      expect(survey?.hasClaudeMd).toBe(true);
      expect(survey?.claudeMdHeadings).toEqual([]);
      expect(undetermined.some((entry) => entry.includes(claudeMd))).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .claude/agents/ directory yields an empty agents[] rather than throwing, and is recorded in undetermined",
    () => {
      const agentsDir = join(dir, ".claude", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "reviewer.md"),
        "---\nmodel: sonnet\n---\n# reviewer\n",
      );
      chmodSync(agentsDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.agents).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(agentsDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .claude/skills/ directory yields an empty skills[] rather than throwing, and is recorded in undetermined",
    () => {
      const skillsDir = join(dir, ".claude", "skills");
      mkdirSync(join(skillsDir, "ok"), { recursive: true });
      writeFileSync(
        join(skillsDir, "ok", "SKILL.md"),
        "---\nname: ok\n---\n# ok\n",
      );
      chmodSync(skillsDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.skills).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(skillsDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .claude/hooks/ directory yields an empty hooks[] rather than throwing, and is recorded in undetermined",
    () => {
      const hooksDir = join(dir, ".claude", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, "guard-foo.mjs"), "");
      chmodSync(hooksDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.hooks).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(hooksDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .claude/rules/ directory yields an empty rules[] rather than throwing, and is recorded in undetermined",
    () => {
      const rulesDir = join(dir, ".claude", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(rulesDir, "src.md"), "---\npaths: src/**\n---\n");
      chmodSync(rulesDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.rules).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(rulesDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .claude/commands/ directory yields an empty commands[] rather than throwing, and is recorded in undetermined",
    () => {
      const commandsDir = join(dir, ".claude", "commands");
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, "deploy.md"), "# deploy\n");
      chmodSync(commandsDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.commands).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(commandsDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );
});

describe("surveyHarness: ENOENT (dangling symlink), ELOOP (symlink loop) and EISDIR (a directory where a file was expected) are recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-errno-"));
    undetermined = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a dangling agent .md symlink is excluded from agents[] and recorded in undetermined with ENOENT", () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    const dangling = join(dir, ".claude", "agents", "x.md");
    symlinkSync(join(dir, "does-not-exist-target"), dangling);
    writeFileSync(
      join(dir, ".claude", "agents", "ok.md"),
      "---\nmodel: haiku\n---\n# ok\n",
    );

    let thrown: unknown;
    let survey;
    try {
      survey = surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.agents).toEqual([{ name: "ok", model: "haiku" }]);
    expect(
      undetermined.some(
        (entry) => entry.includes(dangling) && entry.includes("ENOENT"),
      ),
    ).toBe(true);
  });

  it("a dangling rule .md symlink is excluded from rules[] and recorded in undetermined with ENOENT", () => {
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    const dangling = join(dir, ".claude", "rules", "r.md");
    symlinkSync(join(dir, "does-not-exist-target"), dangling);
    writeFileSync(
      join(dir, ".claude", "rules", "ok.md"),
      '---\npaths: "tests/**"\n---\nbody\n',
    );

    let thrown: unknown;
    let survey;
    try {
      survey = surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.rules).toEqual([{ name: "ok", paths: "tests/**" }]);
    expect(
      undetermined.some(
        (entry) => entry.includes(dangling) && entry.includes("ENOENT"),
      ),
    ).toBe(true);
  });

  it("a symlink loop in place of an agent .md is excluded from agents[] and recorded in undetermined with ELOOP", () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    const loopA = join(dir, ".claude", "agents", "x.md");
    const loopB = join(dir, ".claude", "agents", "x-loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    writeFileSync(
      join(dir, ".claude", "agents", "ok.md"),
      "---\nmodel: haiku\n---\n# ok\n",
    );

    let thrown: unknown;
    let survey;
    try {
      survey = surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.agents).toEqual([{ name: "ok", model: "haiku" }]);
    expect(
      undetermined.some(
        (entry) => entry.includes(loopA) && entry.includes("ELOOP"),
      ),
    ).toBe(true);
  });

  it("a directory named <agent>.md is excluded from agents[] and recorded in undetermined with EISDIR", () => {
    const dirPath = join(dir, ".claude", "agents", "y.md");
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dir, ".claude", "agents", "ok.md"),
      "---\nmodel: haiku\n---\n# ok\n",
    );

    let thrown: unknown;
    let survey;
    try {
      survey = surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.agents).toEqual([{ name: "ok", model: "haiku" }]);
    expect(
      undetermined.some(
        (entry) => entry.includes(dirPath) && entry.includes("EISDIR"),
      ),
    ).toBe(true);
  });

  it("a directory named CLAUDE.md reports hasClaudeMd true, empty headings, records EISDIR in undetermined, and does not throw", () => {
    const claudeMdDir = join(dir, "CLAUDE.md");
    mkdirSync(claudeMdDir);

    let thrown: unknown;
    let survey;
    try {
      survey = surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.hasClaudeMd).toBe(true);
    expect(survey?.claudeMdHeadings).toEqual([]);
    expect(
      undetermined.some(
        (entry) => entry.includes(claudeMdDir) && entry.includes("EISDIR"),
      ),
    ).toBe(true);
  });
});

describe("[GAP 2a] surveyHarness: an unenterable `.claude` ITSELF (not a child) is a different failure mode than an unenterable child directory", () => {
  // `existsSync(claudeDir)` succeeds even when `.claude` is chmod 000 (a
  // `stat` on a path needs execute permission on its PARENT, not on itself),
  // so `surveyHarness` takes its `present: true` branch -- but every
  // existsSync-gated read of something INSIDE `.claude` (settings.json,
  // agents/, skills/, hooks/, rules/, commands/) then needs execute
  // permission ON `.claude`, which is denied. `existsSync` swallows ANY
  // error (not just ENOENT) and returns `false`, so each of those silently
  // reports "absent" with NOTHING recorded in `undetermined` -- unlike the
  // sibling suite above, which chmods a CHILD directory/file and so still
  // goes through a real `readdirSync`/`readFileSync` call that properly
  // distinguishes EACCES.
  let dir: string;
  let undetermined: string[];
  let claudeDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-unenterable-parent-"));
    undetermined = [];
    claudeDir = join(dir, ".claude");
    mkdirSync(join(claudeDir, "agents"), { recursive: true });
    writeFileSync(
      join(claudeDir, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: x\n---\nbody\n",
    );
    writeFileSync(join(claudeDir, "settings.json"), "{}");
  });

  afterEach(() => {
    try {
      chmodSync(claudeDir, 0o755);
    } catch {
      // already gone or already readable.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "records an undetermined entry naming `.claude` with EACCES, rather than silently reporting an empty harness (no settingsFile, no agents)",
    () => {
      chmodSync(claudeDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyHarness(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(
        undetermined.some(
          (entry) => entry.includes(claudeDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
      // Still present -- just unreadable -- never silently "no .claude/ at all".
      expect(survey?.present).toBe(true);
    },
  );
});
