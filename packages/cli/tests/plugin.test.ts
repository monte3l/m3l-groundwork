import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCustomizeSkill } from "../src/plugin.js";

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
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("copies SKILL.md and both data files into .claude/skills/customize/", () => {
    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toHaveLength(3);

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
  });

  it("resolves a default source directory when none is passed", () => {
    // pluginDir() (the default parameter) resolves relative to this
    // module's own runtime location, which under vitest is not
    // dist/main.js, so it won't find real skill files here -- the point of
    // this test is only that the default-parameter branch executes and
    // degrades to an empty result rather than throwing.
    const result = installCustomizeSkill(targetDir);
    expect(Array.isArray(result.filesWritten)).toBe(true);
  });

  it("skips a missing source file rather than throwing", () => {
    rmSync(join(sourceDir, "src", "domain-map.ts"));

    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toHaveLength(2);
  });
});
