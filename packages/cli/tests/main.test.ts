import { describe, expect, it } from "vitest";
import { basename } from "node:path";
import { parseArgs, templatesCoreDir } from "../src/main.js";

describe("parseArgs", () => {
  it("throws with usage text when no target directory is given", () => {
    expect(() => parseArgs([])).toThrow(/usage: m3l-groundwork/);
  });

  it("derives the project name from the target directory basename by default", () => {
    const options = parseArgs(["/tmp/some-project"]);
    expect(options.projectName).toBe("some-project");
    expect(options.skipInstall).toBe(false);
    expect(options.force).toBe(false);
  });

  it("honors an explicit --name over the directory basename", () => {
    const options = parseArgs(["/tmp/some-project", "--name", "widgets"]);
    expect(options.projectName).toBe("widgets");
  });

  it("recognizes --skip-install and --force flags", () => {
    const options = parseArgs([
      "/tmp/some-project",
      "--skip-install",
      "--force",
    ]);
    expect(options.skipInstall).toBe(true);
    expect(options.force).toBe(true);
  });
});

describe("templatesCoreDir", () => {
  it("resolves to a directory literally named templates/core", () => {
    const dir = templatesCoreDir();
    expect(basename(dir)).toBe("core");
    expect(basename(dir.slice(0, dir.length - "/core".length))).toBe(
      "templates",
    );
  });
});
