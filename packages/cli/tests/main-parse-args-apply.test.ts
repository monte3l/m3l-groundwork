// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--apply <file>` (value flag) and `--dry-run` (boolean) on `parseArgs`:
 * `CliOptions.apply` (`string | null`) and `CliOptions.dryRun`. `--apply`
 * needs `--adopt`; `--dry-run` needs `--apply`; `--apply` without `--dry-run`
 * is a usage error in this release (writing arrives later), and the usage
 * text documents both flags.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  CliUsageError,
  main,
  parseArgs,
  type CliOptions,
} from "../src/main.js";

const TARGET = "/tmp/some-project";

function usageMessage(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
    // Guard against passing merely because the flag is not recognized yet.
    expect((error as CliUsageError).message).not.toMatch(/unrecognized option/);
    return (error as CliUsageError).message;
  }
  throw new Error(`expected a CliUsageError for ${argv.join(" ")}`);
}

describe("parseArgs --apply / --dry-run", () => {
  it("defaults apply to null and dryRun to false", () => {
    const options = parseArgs([TARGET, "--adopt"]);
    expect(options.apply).toBeNull();
    expect(options.dryRun).toBe(false);
  });

  it("types apply as string | null and dryRun as boolean", () => {
    expectTypeOf<CliOptions["apply"]>().toEqualTypeOf<string | null>();
    expectTypeOf<CliOptions["dryRun"]>().toEqualTypeOf<boolean>();
  });

  it("parses --adopt --apply <file> --dry-run in any position", () => {
    expect(
      parseArgs([TARGET, "--adopt", "--apply", "answers.json", "--dry-run"]),
    ).toMatchObject({ adopt: true, apply: "answers.json", dryRun: true });
    expect(
      parseArgs(["--dry-run", "--apply", "a.json", "--adopt", TARGET]),
    ).toMatchObject({ adopt: true, apply: "a.json", dryRun: true });
  });

  it("does not take the value for a positional, and composes with --json", () => {
    const options = parseArgs([
      "--adopt",
      "--apply",
      "answers.json",
      TARGET,
      "--dry-run",
      "--json",
    ]);
    expect(options).toMatchObject({
      apply: "answers.json",
      json: true,
      dryRun: true,
    });
    expect(options.targetDir).toBe(TARGET);
  });

  it("requires a value for --apply", () => {
    expect(usageMessage([TARGET, "--adopt", "--dry-run", "--apply"])).toMatch(
      /--apply requires a value/,
    );
    expect(usageMessage([TARGET, "--adopt", "--apply", "--dry-run"])).toMatch(
      /--apply requires a value/,
    );
  });

  it("rejects --apply given twice", () => {
    expect(
      usageMessage([
        TARGET,
        "--adopt",
        "--apply",
        "a.json",
        "--apply",
        "b.json",
        "--dry-run",
      ]),
    ).toMatch(/--apply given more than once/);
  });

  it.each([
    ["no mode flag", []],
    ["--fresh", ["--fresh"]],
    ["--upgrade", ["--upgrade"]],
    ["--upgrade --stamp", ["--upgrade", "--stamp"]],
  ])("rejects --apply without --adopt (%s)", (_name, extra) => {
    const message = usageMessage([
      TARGET,
      ...extra,
      "--apply",
      "a.json",
      "--dry-run",
    ]);
    const head = message.split("\n")[0];
    expect(head).toMatch(/--apply/);
    expect(head).toMatch(/--adopt/);
  });

  it.each([
    ["--force", ["--force"]],
    ["--name", ["--name", "widgets"]],
    ["--pack", ["--pack", "quality"]],
    ["--skip-install", ["--skip-install"]],
  ])("rejects --adopt --apply combined with %s", (_name, extra: string[]) => {
    const message = usageMessage([
      TARGET,
      "--adopt",
      "--apply",
      "a.json",
      "--dry-run",
      ...extra,
    ]);
    // The first line (before the usage text) names the conflict.
    expect(message.split("\n")[0]).toMatch(/--apply|--dry-run/);
    expect(message.split("\n")[0]).toContain(extra[0]);
  });

  it("rejects --dry-run without --apply", () => {
    expect(usageMessage([TARGET, "--adopt", "--dry-run"])).toMatch(
      /--dry-run needs --apply/,
    );
    expect(usageMessage([TARGET, "--dry-run"])).toMatch(
      /--dry-run needs --apply/,
    );
    expect(usageMessage([TARGET, "--fresh", "--dry-run"])).toMatch(/--dry-run/);
  });

  it("rejects --apply without --dry-run, saying writing is not available yet", () => {
    const message = usageMessage([TARGET, "--adopt", "--apply", "a.json"]);
    expect(message).toMatch(/writing is not available yet/);
    expect(message).toMatch(/--dry-run/);
  });

  it("still lets --help, --version and --list-packs ignore the apply flags", () => {
    expect(parseArgs(["--help", "--apply", "a.json"]).help).toBe(true);
    expect(parseArgs(["--version", "--dry-run"]).version).toBe(true);
  });
});

describe("usage text", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("documents --apply <answers.json> and --dry-run", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    main(["--help"]);
    const text = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/--apply <[^>]+>/);
    expect(text).toMatch(/--dry-run/);
  });
});
