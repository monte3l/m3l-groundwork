// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { AssertionError } from "node:assert/strict";
import { basename, join } from "node:path";
import {
  CliUsageError,
  assertAdoptWriteScope,
  parseArgs,
  templatesCoreDir,
} from "../src/main.js";
import { listPackNames } from "../src/packs.js";

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

  // Contract 3: a repeated --name is a usage error ("last one silently
  // wins" is exactly the surprising-auto-detection shape this CLI's own
  // usage-error design otherwise avoids for --adopt/--fresh) -- tokenizeArgv
  // rejects a second --name rather than letting it overwrite the first.
  it("throws CliUsageError when --name is given more than once", () => {
    expect(() => parseArgs(["/tmp/x", "--name", "a", "--name", "b"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--name", "a", "--name", "b"])).toThrow(
      /--name/,
    );
  });

  it("throws CliUsageError naming the offending value for a --pack containing a path traversal segment", () => {
    expect(() => parseArgs(["/tmp/x", "--pack", "../x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--pack", "../x"])).toThrow(/\.\.\/x/);
  });

  it("throws CliUsageError naming the offending value for a --pack given as an absolute path", () => {
    expect(() => parseArgs(["/tmp/x", "--pack", "/abs"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--pack", "/abs"])).toThrow(/\/abs/);
  });

  it("throws CliUsageError naming the offending value for a --pack containing a path separator", () => {
    expect(() => parseArgs(["/tmp/x", "--pack", "a/b"])).toThrow(CliUsageError);
    expect(() => parseArgs(["/tmp/x", "--pack", "a/b"])).toThrow(/a\/b/);
  });

  it("throws CliUsageError naming the offending value for a --pack of a bare dot", () => {
    expect(() => parseArgs(["/tmp/x", "--pack", "."])).toThrow(CliUsageError);
  });

  it("throws CliUsageError naming the offending value for a --pack with uppercase characters", () => {
    expect(() => parseArgs(["/tmp/x", "--pack", "UPPER"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--pack", "UPPER"])).toThrow(/UPPER/);
  });

  it("throws CliUsageError naming only the invalid value when one of several repeated --pack flags is malformed", () => {
    // Repeatable flag: a valid value alongside an invalid one must still
    // throw -- the invalid value is never silently dropped in favor of the
    // valid one.
    expect(() =>
      parseArgs(["/tmp/x", "--pack", "a", "--pack", "../b"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseArgs(["/tmp/x", "--pack", "a", "--pack", "../b"]),
    ).toThrow(/\.\.\/b/);
  });

  it("accepts a valid, real pack name shape and parses it into packs", () => {
    const options = parseArgs(["/tmp/x", "--pack", "statusline"]);
    expect(options.packs).toEqual(["statusline"]);
  });

  it("accepts every real pack name under templates/packs/ against --pack's shape-validation pattern", () => {
    // Drift guard: a future pack directory whose name --pack's own
    // shape-validation pattern would reject (e.g. "foo_bar") must be caught
    // here immediately, rather than only surfacing once someone tries to
    // use it.
    const names = listPackNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const options = parseArgs(["/tmp/x", "--pack", name]);
      expect(options.packs).toContain(name);
    }
  });

  it("throws CliUsageError naming the offending value for a --name given as a path traversal", () => {
    expect(() => parseArgs(["/tmp/x", "--name", "../evil"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--name", "../evil"])).toThrow(
      /\.\.\/evil/,
    );
  });

  it("throws CliUsageError naming the offending value for a --name with uppercase characters", () => {
    expect(() => parseArgs(["/tmp/x", "--name", "Foo"])).toThrow(CliUsageError);
    expect(() => parseArgs(["/tmp/x", "--name", "Foo"])).toThrow(/Foo/);
  });

  it("throws CliUsageError naming the offending value for a --name containing a space", () => {
    expect(() => parseArgs(["/tmp/x", "--name", "has space"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["/tmp/x", "--name", "has space"])).toThrow(
      /has space/,
    );
  });

  it("throws CliUsageError for a --name longer than 214 characters", () => {
    const tooLong = "a".repeat(215);
    expect(() => parseArgs(["/tmp/x", "--name", tooLong])).toThrow(
      CliUsageError,
    );
  });

  it("accepts a valid scoped npm package name for --name", () => {
    const options = parseArgs(["/tmp/x", "--name", "@scope/widgets"]);
    expect(options.projectName).toBe("@scope/widgets");
  });

  it("accepts a valid unscoped npm package name for --name", () => {
    const options = parseArgs(["/tmp/x", "--name", "widgets-2"]);
    expect(options.projectName).toBe("widgets-2");
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

describe("assertAdoptWriteScope", () => {
  const targetDir = "/work/app";

  it("does not throw for a path genuinely under <targetDir>/.groundwork/", () => {
    expect(() =>
      assertAdoptWriteScope(targetDir, [
        join(targetDir, ".groundwork", "inventory.json"),
      ]),
    ).not.toThrow();
  });

  it("does not throw for a path under <targetDir>/.claude/skills/customize/", () => {
    expect(() =>
      assertAdoptWriteScope(targetDir, [
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
      ]),
    ).not.toThrow();
  });

  it("throws AssertionError for a sibling directory sharing a name prefix with the allowed .groundwork scope", () => {
    const evilPath = join(targetDir, ".groundwork-evil", "x");

    expect(() => assertAdoptWriteScope(targetDir, [evilPath])).toThrow(
      AssertionError,
    );

    let thrown: unknown;
    try {
      assertAdoptWriteScope(targetDir, [evilPath]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssertionError);
    expect((thrown as AssertionError).message).toMatch(
      /adopt mode wrote outside its scope/,
    );
  });

  it("throws AssertionError for an unrelated path outside both allowed roots", () => {
    expect(() =>
      assertAdoptWriteScope(targetDir, [join(targetDir, "package.json")]),
    ).toThrow(AssertionError);
  });
});
