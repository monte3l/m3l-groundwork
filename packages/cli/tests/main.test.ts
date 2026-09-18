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
    expect(options.adopt).toBe(false);
    expect(options.fresh).toBe(false);
  });

  it("honors an explicit --name over the directory basename", () => {
    const options = parseArgs(["/tmp/some-project", "--name", "widgets"]);
    expect(options.projectName).toBe("widgets");
  });

  it("does not treat --name's value as the target directory", () => {
    // Regression: --name's value used to leak into the positional list,
    // so `m3l-groundwork --name foo /tmp/some-project` (flag before the
    // target) would previously have taken "foo" as the target dir.
    const options = parseArgs(["--name", "widgets", "/tmp/some-project"]);
    expect(options.targetDir).toBe("/tmp/some-project");
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

  it("recognizes --adopt and --fresh flags", () => {
    const adopt = parseArgs(["/tmp/some-project", "--adopt"]);
    expect(adopt.adopt).toBe(true);
    const fresh = parseArgs(["/tmp/some-project", "--fresh"]);
    expect(fresh.fresh).toBe(true);
  });

  it("recognizes --help without requiring a target directory", () => {
    const options = parseArgs(["--help"]);
    expect(options.help).toBe(true);
  });

  it("recognizes -h as a short form of --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("recognizes --version and -v without requiring a target directory", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
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
