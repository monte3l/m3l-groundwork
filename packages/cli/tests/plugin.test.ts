import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";

describe("installCustomizeSkill", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-target-"));

    mkdirSync(join(sourceDir, "skills", "customize"), { recursive: true });
    mkdirSync(join(sourceDir, "src"), { recursive: true });
    writeFileSync(
      join(sourceDir, "skills", "customize", "SKILL.md"),
      "---\nname: customize\n---\n# customize\n",
    );
    writeFileSync(
      join(sourceDir, "src", "kind-facet-map.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(
      join(sourceDir, "src", "domain-map.ts"),
      "export const y = 2;\n",
    );
    writeFileSync(
      join(sourceDir, "src", "pack-map.ts"),
      "export const z = 3;\n",
    );
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("copies SKILL.md and all three data files into .claude/skills/customize/", () => {
    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toHaveLength(4);

    const destDir = join(targetDir, ".claude", "skills", "customize");
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toContain(
      "name: customize",
    );
    expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(destDir, "domain-map.ts"), "utf8")).toBe(
      "export const y = 2;\n",
    );
    expect(readFileSync(join(destDir, "pack-map.ts"), "utf8")).toBe(
      "export const z = 3;\n",
    );
  });

  it("resolves a default source directory when none is passed", () => {
    // pluginDir() (the default parameter) resolves relative to this
    // module's own runtime location. Under vitest that's this repo's own
    // packages/plugin, which really exists, so this just confirms the
    // default-parameter branch resolves to real files rather than throwing.
    const result = installCustomizeSkill(targetDir);
    expect(result.filesWritten).toHaveLength(4);
  });

  it("throws rather than silently skip a missing source file", () => {
    rmSync(join(sourceDir, "src", "domain-map.ts"));

    expect(() => installCustomizeSkill(targetDir, sourceDir)).toThrow(
      /source file is missing/,
    );
  });

  it("throws when the newly-added pack-map.ts source file is missing", () => {
    rmSync(join(sourceDir, "src", "pack-map.ts"));

    expect(() => installCustomizeSkill(targetDir, sourceDir)).toThrow(
      /source file is missing/,
    );
  });
});

describe("installCustomizeSkillGuarded", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-guarded-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-guarded-target-"));

    mkdirSync(join(sourceDir, "skills", "customize"), { recursive: true });
    mkdirSync(join(sourceDir, "src"), { recursive: true });
    writeFileSync(
      join(sourceDir, "skills", "customize", "SKILL.md"),
      "---\nname: customize\n---\n# customize\n",
    );
    writeFileSync(
      join(sourceDir, "src", "kind-facet-map.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(
      join(sourceDir, "src", "domain-map.ts"),
      "export const y = 2;\n",
    );
    writeFileSync(
      join(sourceDir, "src", "pack-map.ts"),
      "export const z = 3;\n",
    );
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("installs into .claude/skills/customize/ when nothing is there yet", () => {
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("claude");
    expect(
      existsSync(join(targetDir, ".claude", "skills", "customize", "SKILL.md")),
    ).toBe(true);
  });

  it("reports already-present without writing when the existing skill is byte-identical", () => {
    installCustomizeSkillGuarded(targetDir, sourceDir);
    const result = installCustomizeSkillGuarded(targetDir, sourceDir);
    expect(result.location).toBe("already-present");
    expect(result.filesWritten).toEqual([]);
  });

  it("diverts to .groundwork/customize/ when the project has its own different customize skill", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    writeFileSync(
      join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
      "---\nname: customize\n---\n# a project-authored version\n",
    );

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(
      existsSync(join(targetDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
    // The project's own version under .claude/ is untouched.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");
  });
});
