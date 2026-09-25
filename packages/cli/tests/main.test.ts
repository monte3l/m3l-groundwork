import { describe, expect, it } from "vitest";
import { basename } from "node:path";
import { CliUsageError, parseArgs, templatesCoreDir } from "../src/main.js";

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

  it("defaults packs to an empty array", () => {
    expect(parseArgs(["/tmp/some-project"]).packs).toEqual([]);
  });

  it("collects a repeated --pack flag into a sorted, deduplicated array", () => {
    const options = parseArgs([
      "/tmp/some-project",
      "--pack",
      "harness-extras",
      "--pack",
      "harness-extras",
      "--pack",
      "another-pack",
    ]);
    expect(options.packs).toEqual(["another-pack", "harness-extras"]);
  });

  it("does not treat --pack's value as the target directory", () => {
    const options = parseArgs([
      "--pack",
      "harness-extras",
      "/tmp/some-project",
    ]);
    expect(options.targetDir).toBe("/tmp/some-project");
    expect(options.packs).toEqual(["harness-extras"]);
  });

  it("recognizes --list-packs without requiring a target directory", () => {
    const options = parseArgs(["--list-packs"]);
    expect(options.listPacks).toBe(true);
    expect(options.targetDir).toBe("");
  });
});

describe("parseArgs (CliUsageError)", () => {
  it("throws CliUsageError (not a plain Error) with usage text and the short-alias hints when no target directory is given", () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
    expect(() => parseArgs([])).toThrow(/usage: m3l-groundwork/i);
    expect(() => parseArgs([])).toThrow(/--help, -h/);
    expect(() => parseArgs([])).toThrow(/--version, -v/);
  });

  it("throws CliUsageError naming the flag for an unrecognized option", () => {
    expect(() => parseArgs(["/tmp/x", "--bogus"])).toThrow(CliUsageError);
    expect(() => parseArgs(["/tmp/x", "--bogus"])).toThrow(
      /unrecognized option: --bogus/,
    );
  });

  it("throws CliUsageError when --name has no following value", () => {
    expect(() => parseArgs(["/tmp/x", "--name"])).toThrow(CliUsageError);
    expect(() => parseArgs(["/tmp/x", "--name"])).toThrow(
      /--name requires a value/,
    );
  });

  it("throws CliUsageError when --pack has no following value", () => {
    expect(() => parseArgs(["/tmp/x", "--pack"])).toThrow(CliUsageError);
    expect(() => parseArgs(["/tmp/x", "--pack"])).toThrow(
      /--pack requires a value/,
    );
  });

  it("throws CliUsageError when --adopt and --fresh are both given", () => {
    expect(() => parseArgs(["/tmp/x", "--adopt", "--fresh"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--adopt", "--fresh"])).toThrow(
      /--adopt and --fresh are mutually exclusive/,
    );
  });

  it("throws CliUsageError when --name's following token looks like another flag rather than a value", () => {
    expect(() => parseArgs(["/tmp/x", "--name", "--force"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--name", "--force"])).toThrow(
      /--name requires a value/,
    );
  });

  it("throws CliUsageError when --pack's following token looks like another flag rather than a value", () => {
    expect(() => parseArgs(["/tmp/x", "--pack", "--adopt"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--pack", "--adopt"])).toThrow(
      /--pack requires a value/,
    );
  });

  it("throws CliUsageError naming the surplus argument when more than one positional is given", () => {
    expect(() => parseArgs(["/tmp/x", "/tmp/y"])).toThrow(CliUsageError);
    expect(() => parseArgs(["/tmp/x", "/tmp/y"])).toThrow(
      /unexpected argument\(s\): \/tmp\/y/,
    );
  });

  it("throws CliUsageError for a surplus positional left over after a value-flag consumes its value", () => {
    expect(() => parseArgs(["--name", "my", "app", "/tmp/x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["--name", "my", "app", "/tmp/x"])).toThrow(
      /unexpected argument\(s\)/,
    );
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
