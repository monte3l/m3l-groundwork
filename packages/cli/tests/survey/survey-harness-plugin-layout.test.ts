// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `HarnessSurvey.pluginLayout`: a Claude Code plugin repository keeps its
 * components at the repository root (`.claude-plugin/plugin.json`,
 * `hooks/hooks.json`, `skills/`, ...), outside `.claude/`. The survey records
 * that fact (an index, never a verdict) so the report can say so.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyHarness } from "../../src/survey/survey-harness.js";
import { chmodIneffective } from "../chmod-ineffective.js";

describe("surveyHarness: pluginLayout", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-plugin-"));
    undetermined = [];
  });

  afterEach(() => {
    try {
      chmodSync(join(dir, ".claude-plugin"), 0o755);
    } catch {
      // absent or already readable -- fine either way.
    }
    try {
      chmodSync(join(dir, "hooks"), 0o755);
    } catch {
      // absent or already readable -- fine either way.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(): void {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
  }

  it("is null for a project with no plugin manifest", () => {
    expect(surveyHarness(dir, undetermined).pluginLayout).toBeNull();
  });

  it("lists the manifest and every component that exists, in the fixed order", () => {
    writeManifest();
    // Created in a different order than the expected output, so the result
    // order can only come from the collector's own fixed order.
    writeFileSync(join(dir, ".mcp.json"), "{}");
    mkdirSync(join(dir, "commands"));
    mkdirSync(join(dir, "agents"));
    mkdirSync(join(dir, "skills"));
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "hooks.json"), "{}");

    expect(surveyHarness(dir, undetermined).pluginLayout).toEqual({
      manifest: ".claude-plugin/plugin.json",
      components: [
        "hooks/hooks.json",
        "skills/",
        "agents/",
        "commands/",
        ".mcp.json",
      ],
    });
    expect(undetermined).toEqual([]);
  });

  it("lists only the components that exist", () => {
    writeManifest();
    mkdirSync(join(dir, "skills"));

    expect(surveyHarness(dir, undetermined).pluginLayout).toEqual({
      manifest: ".claude-plugin/plugin.json",
      components: ["skills/"],
    });
  });

  it("has an empty components list when only the manifest exists", () => {
    writeManifest();

    expect(surveyHarness(dir, undetermined).pluginLayout).toEqual({
      manifest: ".claude-plugin/plugin.json",
      components: [],
    });
  });

  it("is null for a root hooks/ directory without the manifest (it could be React hooks)", () => {
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
    mkdirSync(join(dir, "skills"));

    expect(surveyHarness(dir, undetermined).pluginLayout).toBeNull();
  });

  it("is null when the manifest is a directory, not a regular file", () => {
    mkdirSync(join(dir, ".claude-plugin", "plugin.json"), { recursive: true });

    expect(surveyHarness(dir, undetermined).pluginLayout).toBeNull();
    const note = undetermined.find((n) =>
      n.includes(join(dir, ".claude-plugin", "plugin.json")),
    );
    expect(note).toContain("not a regular file");
    expect(note).toContain("directory or special file");
    expect(note).toContain("plugin layout not surveyed");
  });

  it("records no note when the manifest is simply absent", () => {
    surveyHarness(dir, undetermined);
    expect(undetermined).toEqual([]);
  });

  it("refuses a symlinked manifest: pluginLayout is null", () => {
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, "real-plugin.json"), "{}");
    symlinkSync(
      join(dir, "real-plugin.json"),
      join(dir, ".claude-plugin", "plugin.json"),
    );

    expect(surveyHarness(dir, undetermined).pluginLayout).toBeNull();
    const note = undetermined.find((n) =>
      n.includes(join(dir, ".claude-plugin", "plugin.json")),
    );
    expect(note).toContain("not a regular file");
    expect(note).toContain("symlink");
    expect(note).toContain("plugin layout not surveyed");
  });

  it("does not count a symlinked component", () => {
    writeManifest();
    mkdirSync(join(dir, "real-skills"));
    symlinkSync(join(dir, "real-skills"), join(dir, "skills"));
    writeFileSync(join(dir, "real-mcp.json"), "{}");
    symlinkSync(join(dir, "real-mcp.json"), join(dir, ".mcp.json"));
    mkdirSync(join(dir, "agents"));

    expect(surveyHarness(dir, undetermined).pluginLayout).toEqual({
      manifest: ".claude-plugin/plugin.json",
      components: ["agents/"],
    });
    for (const linked of [join(dir, "skills"), join(dir, ".mcp.json")]) {
      const note = undetermined.find((n) => n.includes(linked));
      expect(note).toContain("symlink");
      expect(note).toContain("not followed");
    }
    expect(undetermined.some((n) => n.includes(join(dir, "agents")))).toBe(
      false,
    );
  });

  it("does not count a regular file where a component directory is expected", () => {
    writeManifest();
    writeFileSync(join(dir, "skills"), "not a directory");

    expect(surveyHarness(dir, undetermined).pluginLayout).toEqual({
      manifest: ".claude-plugin/plugin.json",
      components: [],
    });
    // Existing behaviour kept: a wrong-type component is silently not counted.
    expect(undetermined).toEqual([]);
  });

  it.skipIf(chmodIneffective)(
    "keeps the layout and records EACCES when a component probe is unreadable",
    () => {
      writeManifest();
      mkdirSync(join(dir, "hooks"));
      writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
      mkdirSync(join(dir, "skills"));
      chmodSync(join(dir, "hooks"), 0o000);

      const survey = surveyHarness(dir, undetermined);

      expect(survey.pluginLayout).toEqual({
        manifest: ".claude-plugin/plugin.json",
        components: ["skills/"],
      });
      expect(
        undetermined.some(
          (n) => n.includes(join(dir, "hooks")) && n.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "records an unreadable manifest probe in undetermined instead of throwing",
    () => {
      writeManifest();
      chmodSync(join(dir, ".claude-plugin"), 0o000);

      let survey: ReturnType<typeof surveyHarness> | undefined;
      expect(() => {
        survey = surveyHarness(dir, undetermined);
      }).not.toThrow();

      expect(survey?.pluginLayout).toBeNull();
      expect(undetermined.length).toBeGreaterThan(0);
      expect(undetermined.some((note) => note.includes("EACCES"))).toBe(true);
      expect(undetermined.some((note) => note.includes(".claude-plugin"))).toBe(
        true,
      );
    },
  );
});
