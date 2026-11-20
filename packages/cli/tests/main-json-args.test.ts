// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--json` is a boolean flag on parseArgs: CliOptions.json, default false.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { CliUsageError, parseArgs, type CliOptions } from "../src/main.js";

describe("parseArgs --json", () => {
  it("defaults json to false", () => {
    expect(parseArgs(["/tmp/some-project"]).json).toBe(false);
  });

  it("sets json to true when --json is given, in any position", () => {
    expect(parseArgs(["/tmp/some-project", "--json"]).json).toBe(true);
    expect(parseArgs(["--json", "/tmp/some-project"]).json).toBe(true);
  });

  it("types json as boolean", () => {
    expectTypeOf<CliOptions["json"]>().toEqualTypeOf<boolean>();
  });

  it("composes with --adopt, --fresh, --pack, --skip-install and --name", () => {
    const adopt = parseArgs([
      "/tmp/p",
      "--json",
      "--adopt",
      "--pack",
      "quality",
    ]);
    expect(adopt).toMatchObject({
      json: true,
      adopt: true,
      packs: ["quality"],
    });
    const fresh = parseArgs([
      "/tmp/p",
      "--fresh",
      "--skip-install",
      "--name",
      "widgets",
      "--json",
    ]);
    expect(fresh).toMatchObject({
      json: true,
      fresh: true,
      skipInstall: true,
      projectName: "widgets",
    });
  });

  it.each([["--help"], ["--version"], ["--list-packs"]])(
    "still parses %s alongside --json, with json true so main can format it",
    (flag) => {
      expect(parseArgs([flag, "--json"]).json).toBe(true);
    },
  );

  it("still requires a target directory", () => {
    expect(() => parseArgs(["--json"])).toThrowError(CliUsageError);
  });

  it("keeps --adopt and --fresh mutually exclusive under --json", () => {
    expect(() =>
      parseArgs(["/tmp/p", "--json", "--adopt", "--fresh"]),
    ).toThrowError(CliUsageError);
  });
});
