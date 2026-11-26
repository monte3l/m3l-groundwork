// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--update` / `--base-version` in `parseArgs`, `USAGE` and `main()`:
 * `CliOptions` gains `update: boolean`; `--base-version` is valid with
 * either `--check-update` or `--update`; `main()` dispatches `runUpdate`
 * before mode detection and returns exit code 0.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/main.js";
import { USAGE, CliUsageError } from "../src/usage.js";
import { runUpdate } from "../src/update.js";

vi.mock("../src/update.js", () => ({ runUpdate: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runUpdate).mockReset();
});

describe("parseArgs: --update", () => {
  it("parses the flag with a target, off by default", () => {
    expect(parseArgs(["./proj", "--update"]).update).toBe(true);
    expect(parseArgs(["./proj"]).update).toBe(false);
  });

  it("accepts --base-version x.y.z", () => {
    const options = parseArgs([
      "./proj",
      "--update",
      "--base-version",
      "1.4.0",
    ]);
    expect(options.update).toBe(true);
    expect(options.baseVersion).toBe("1.4.0");
  });

  it("needs a target directory", () => {
    expect(() => parseArgs(["--update"])).toThrowError(CliUsageError);
  });

  it.each([
    ["--check-update"],
    ["--pack", "quality"],
    ["--add-pack", "quality"],
    ["--reinstall"],
    ["--adopt"],
    ["--fresh"],
    ["--force"],
    ["--skip-install"],
    ["--list-packs"],
    ["--name", "acme"],
  ])("rejects --update combined with %s, naming both flags", (...conflict) => {
    let thrown: unknown;
    try {
      parseArgs(["./proj", "--update", ...conflict]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toContain(conflict[0]);
    expect((thrown as CliUsageError).message).toContain("--update");
  });

  it("still rejects --base-version with neither --update nor --check-update", () => {
    expect(() => parseArgs(["./proj", "--base-version", "1.4.0"])).toThrowError(
      CliUsageError,
    );
  });

  it.each(["1.4", "v1.4.0", "1.4.0-beta.1", "latest", ""])(
    "rejects the malformed --base-version %j with --update",
    (value) => {
      expect(() =>
        parseArgs(["./proj", "--update", "--base-version", value]),
      ).toThrowError(CliUsageError);
    },
  );

  it("keeps --check-update's own --base-version working", () => {
    expect(
      parseArgs(["./proj", "--check-update", "--base-version", "1.4.0"])
        .baseVersion,
    ).toBe("1.4.0");
  });
});

describe("USAGE", () => {
  it("documents --update and that --base-version applies to it", () => {
    expect(USAGE).toContain("--update");
    expect(USAGE).toMatch(/--base-version <[^\n]*--update/);
  });
});

describe("main() with --update", () => {
  it("runs runUpdate with the target and --base-version, returning exit code 0", () => {
    vi.mocked(runUpdate).mockReturnValue(0);
    const result: unknown = main([
      "./proj",
      "--update",
      "--base-version",
      "1.4.0",
    ]);
    expect(result).toBe(0);
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runUpdate).mock.calls[0]?.[0]).toMatchObject({
      targetDir: expect.stringMatching(/proj$/) as unknown,
      baseVersion: "1.4.0",
    });
  });

  it("does not run it for --help", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    main(["--help"]);
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it("propagates a refusal from runUpdate", () => {
    vi.mocked(runUpdate).mockImplementation(() => {
      throw new CliUsageError("refused");
    });
    expect(() => main(["./proj", "--update"])).toThrowError(CliUsageError);
  });
});

describe("main() with --update --fetch-base", () => {
  it("passes fetchBase to runUpdate", () => {
    vi.mocked(runUpdate).mockReturnValue(0);
    main(["./proj", "--update", "--fetch-base", "--base-version", "1.4.0"]);
    expect(vi.mocked(runUpdate).mock.calls[0]?.[0]).toMatchObject({
      baseVersion: "1.4.0",
      fetchBase: true,
    });
  });

  it("passes fetchBase: false when the flag is absent", () => {
    vi.mocked(runUpdate).mockReturnValue(0);
    main(["./proj", "--update"]);
    expect(vi.mocked(runUpdate).mock.calls[0]?.[0]).toMatchObject({
      fetchBase: false,
    });
  });

  it("documents --fetch-base in USAGE, tied to --check-update and --update", () => {
    expect(USAGE).toMatch(
      /--fetch-base[^\n]*\n?[^\n]*--check-update[^\n]*--update/,
    );
    expect(USAGE).toMatch(/--fetch-base[\s\S]*npm/);
  });

  it("refuses --fetch-base with neither update flag before running anything", () => {
    expect(() => main(["./proj", "--fetch-base"])).toThrowError(CliUsageError);
    expect(runUpdate).not.toHaveBeenCalled();
  });
});
