// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--check-update` / `--base-version` in `parseArgs`, `USAGE` and `main()`'s
 * return value (the exit code to set, `undefined` to leave it).
 * `CliOptions` gains `checkUpdate: boolean` and `baseVersion: string |
 * undefined`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/main.js";
import { USAGE, CliUsageError } from "../src/usage.js";
import { runCheckUpdate } from "../src/check-update.js";

vi.mock("../src/check-update.js", () => ({ runCheckUpdate: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runCheckUpdate).mockReset();
});

describe("parseArgs: --check-update", () => {
  it("parses the flag with a target", () => {
    const options = parseArgs(["./proj", "--check-update"]);
    expect(options.checkUpdate).toBe(true);
    expect(options.baseVersion).toBeUndefined();
    expect(options.targetDir).toMatch(/proj$/);
  });

  it("is off by default", () => {
    expect(parseArgs(["./proj"]).checkUpdate).toBe(false);
  });

  it("parses --base-version x.y.z", () => {
    expect(
      parseArgs(["./proj", "--check-update", "--base-version", "1.4.0"])
        .baseVersion,
    ).toBe("1.4.0");
  });

  it("needs a target directory", () => {
    expect(() => parseArgs(["--check-update"])).toThrowError(CliUsageError);
  });

  it.each([
    ["--pack", "quality"],
    ["--add-pack", "quality"],
    ["--reinstall"],
    ["--adopt"],
    ["--fresh"],
    ["--force"],
    ["--skip-install"],
    ["--list-packs"],
    ["--name", "acme"],
  ])("rejects --check-update combined with %s", (...conflict) => {
    let thrown: unknown;
    try {
      parseArgs(["./proj", "--check-update", ...conflict]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toContain(conflict[0]);
    expect((thrown as CliUsageError).message).toContain("--check-update");
  });

  it("rejects --base-version without --check-update", () => {
    expect(() => parseArgs(["./proj", "--base-version", "1.4.0"])).toThrowError(
      CliUsageError,
    );
  });

  it("rejects --base-version with no value", () => {
    expect(() =>
      parseArgs(["./proj", "--check-update", "--base-version"]),
    ).toThrowError(/requires a value/);
  });

  it.each(["1.4", "v1.4.0", "1.4.0-beta.1", "latest", "1.4.0.1", ""])(
    "rejects the malformed --base-version %j",
    (value) => {
      expect(() =>
        parseArgs(["./proj", "--check-update", "--base-version", value]),
      ).toThrowError(CliUsageError);
    },
  );
});

describe("USAGE", () => {
  it("documents both flags", () => {
    expect(USAGE).toContain("--check-update");
    expect(USAGE).toContain("--base-version <");
  });

  it("lists --name among the flags --check-update refuses", () => {
    const paragraph =
      USAGE.split("\n\n").find((block) =>
        block.startsWith("--check-update skips mode detection"),
      ) ?? "";
    expect(paragraph).toMatch(/cannot be\s+combined with/);
    expect(paragraph.replaceAll(/\s+/g, " ")).toContain("--name");
  });
});

describe("main() return value", () => {
  it.each([0, 3])("returns runCheckUpdate's exit code %i", (code) => {
    vi.mocked(runCheckUpdate).mockReturnValue(code);
    const result: unknown = main(["./proj", "--check-update"]);
    expect(result).toBe(code);
    expect(runCheckUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCheckUpdate).mock.calls[0]?.[0]).toMatchObject({
      targetDir: expect.stringMatching(/proj$/) as unknown,
    });
  });

  it("passes --base-version through to runCheckUpdate", () => {
    vi.mocked(runCheckUpdate).mockReturnValue(0);
    main(["./proj", "--check-update", "--base-version", "1.4.0"]);
    expect(vi.mocked(runCheckUpdate).mock.calls[0]?.[0]).toMatchObject({
      baseVersion: "1.4.0",
    });
  });

  it("returns undefined for --help and never runs the check", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result: unknown = main(["--help"]);
    expect(result).toBeUndefined();
    expect(runCheckUpdate).not.toHaveBeenCalled();
  });

  it("returns undefined for --version", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result: unknown = main(["--version"]);
    expect(result).toBeUndefined();
  });
});
