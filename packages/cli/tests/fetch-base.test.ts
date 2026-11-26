// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `fetchBase({ version, runNpm })`: rebuilds a release's templates from
 * `npm pack` (the injected `runNpm`, never a real network call here) and
 * exposes them through `fetchedBaseFile`. Every failure is a
 * `CliUsageError` that tells the owner how to carry on without
 * `--fetch-base`; the temp directory is always removed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fetchBase, fetchedBaseFile } from "../src/fetch-base.js";
import type { FetchedBase } from "../src/fetch-base.js";
import { CliUsageError } from "../src/usage.js";
import { buildTgz, fakeNpmPack, packageFiles } from "./tarball-fixtures.js";
import type { FakeNpmResult } from "./tarball-fixtures.js";

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const TGZ = buildTgz(
  packageFiles({
    "package.json": "{}",
    "templates/core/package.json": '{"name":"__PROJECT_NAME__"}',
    "templates/core/_gitignore": "node_modules\n",
    "templates/core/src/_package-lock.json": "{}\n",
    "templates/packs/quality/files/_npmrc": "x=1\n",
    "templates/packs/quality/files/bin/check.mjs": "export {};\n",
    "templates/packs/quality/pack.json": "{}",
  }),
);

afterEach(() => {
  vi.restoreAllMocks();
});

/** The directory `--pack-destination` named, from a recorded call. */
function destinationOf(args: readonly string[]): string {
  const dest = args[args.indexOf("--pack-destination") + 1];
  if (dest === undefined) throw new Error("no --pack-destination");
  return dest;
}

function recording(
  impl: (args: readonly string[], cwd: string) => FakeNpmResult,
): ReturnType<
  typeof vi.fn<(args: readonly string[], cwd: string) => FakeNpmResult>
> {
  return vi.fn(impl);
}

function expectAdvice(error: unknown): void {
  expect(error).toBeInstanceOf(CliUsageError);
  const message = (error as CliUsageError).message;
  expect(message).toContain("--fetch-base");
  expect(message).toContain("--base-version");
}

function failure(attempt: () => unknown): unknown {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("fetchBase: the npm invocation", () => {
  it("packs the exact version into a fresh temp directory, without scripts", () => {
    const runNpm = recording(fakeNpmPack(TGZ));
    fetchBase({ version: "1.0.0", runNpm });
    expect(runNpm).toHaveBeenCalledTimes(1);
    const [args, cwd] = runNpm.mock.calls[0] ?? [];
    expect(args).toEqual([
      "pack",
      "@monte3l/groundwork@1.0.0",
      "--pack-destination",
      destinationOf(args ?? []),
      "--json",
      "--ignore-scripts",
    ]);
    expect(typeof cwd).toBe("string");
    expect(destinationOf(args ?? [])).not.toBe(cwd);
  });

  it("removes its temp directory after a success", () => {
    const runNpm = recording(fakeNpmPack(TGZ));
    fetchBase({ version: "1.0.0", runNpm });
    expect(existsSync(destinationOf(runNpm.mock.calls[0]?.[0] ?? []))).toBe(
      false,
    );
  });

  it.each([
    "1.0",
    "1.0.0 --foo",
    "latest",
    "1.0.0-beta.1",
    "../x",
    "",
    "v1.0.0",
    "1.0.0\n",
  ])("refuses the version %j before running npm", (version) => {
    const runNpm = recording(fakeNpmPack(TGZ));
    expect(failure(() => fetchBase({ version, runNpm }))).toBeInstanceOf(
      CliUsageError,
    );
    expect(runNpm).not.toHaveBeenCalled();
  });
});

describe("fetchBase: the result", () => {
  let base: FetchedBase;
  beforeAll(() => {
    base = fetchBase({ version: "1.0.0", runNpm: fakeNpmPack(TGZ) });
  });

  it("records the version", () => {
    expect(base.version).toBe("1.0.0");
  });

  it("looks a core file up by its project path, bytes untouched by tokens", () => {
    expect(text(fetchedBaseFile(base, "core", "package.json"))).toBe(
      '{"name":"__PROJECT_NAME__"}',
    );
  });

  it("restores dotfile names", () => {
    expect(text(fetchedBaseFile(base, "core", ".gitignore"))).toBe(
      "node_modules\n",
    );
    expect(text(fetchedBaseFile(base, "core", "src/package-lock.json"))).toBe(
      "{}\n",
    );
    expect(fetchedBaseFile(base, "core", "_gitignore")).toBeUndefined();
  });

  it("looks a pack file up under its pack, from templates/packs/<n>/files/", () => {
    expect(text(fetchedBaseFile(base, "pack:quality", ".npmrc"))).toBe("x=1\n");
    expect(text(fetchedBaseFile(base, "pack:quality", "bin/check.mjs"))).toBe(
      "export {};\n",
    );
  });

  it("does not leak a pack's files into core, nor the manifest into files", () => {
    expect(fetchedBaseFile(base, "core", "bin/check.mjs")).toBeUndefined();
    expect(fetchedBaseFile(base, "pack:quality", "pack.json")).toBeUndefined();
  });

  it("returns undefined for an unknown path or pack", () => {
    expect(fetchedBaseFile(base, "core", "nope.txt")).toBeUndefined();
    expect(fetchedBaseFile(base, "pack:missing", "a")).toBeUndefined();
    expect(fetchedBaseFile(base, "skill", "a")).toBeUndefined();
  });
});

describe("fetchBase: failures are usage errors with advice", () => {
  const cases: [string, FakeNpmResult][] = [
    [
      "npm is not installed",
      {
        status: 0,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync npm ENOENT"), {
          code: "ENOENT",
        }),
      },
    ],
    [
      "npm exits non-zero",
      { status: 1, stdout: "", stderr: "npm error network" },
    ],
    [
      "the version was never published",
      {
        status: 1,
        stdout: "",
        stderr:
          "npm error code ETARGET\nnpm error notarget No matching version",
      },
    ],
    ["its output is not JSON", { status: 0, stdout: "not json", stderr: "" }],
    ["its output lists no tarball", { status: 0, stdout: "[]", stderr: "" }],
    [
      "its output has no filename",
      { status: 0, stdout: '[{"name":"x"}]', stderr: "" },
    ],
    [
      "its filename escapes the destination",
      {
        status: 0,
        stdout: '[{"filename":"../../etc/passwd"}]',
        stderr: "",
      },
    ],
  ];

  it.each(cases)("when %s", (_label, result) => {
    const runNpm = recording(() => result);
    expectAdvice(failure(() => fetchBase({ version: "1.0.0", runNpm })));
  });

  it("when npm reports a tarball it did not write", () => {
    const runNpm = recording(() => ({
      status: 0,
      stdout: '[{"filename":"missing.tgz"}]',
      stderr: "",
    }));
    expectAdvice(failure(() => fetchBase({ version: "1.0.0", runNpm })));
  });

  it("creates the --pack-destination directory before npm runs (npm will not)", () => {
    const runNpm = recording((args, cwd) => {
      expect(existsSync(destinationOf(args))).toBe(true);
      return fakeNpmPack(TGZ)(args, cwd);
    });
    const base = fetchBase({ version: "1.0.0", runNpm });
    expect(base.version).toBe("1.0.0");
  });

  it("says npm was killed by the signal, not that it exited with null", () => {
    const runNpm = recording(() => ({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    }));
    const error = failure(() => fetchBase({ version: "1.0.0", runNpm }));
    expectAdvice(error);
    const message = (error as CliUsageError).message;
    expect(message).toContain("SIGKILL");
    expect(message).not.toContain("exited with null");
  });

  it("when the tarball is corrupt", () => {
    const runNpm = recording(fakeNpmPack(new TextEncoder().encode("junk")));
    expectAdvice(failure(() => fetchBase({ version: "1.0.0", runNpm })));
  });

  it("when the tarball holds a hostile templates entry", () => {
    const runNpm = recording(
      fakeNpmPack(buildTgz([{ name: "package/templates/../evil", data: "x" }])),
    );
    expectAdvice(failure(() => fetchBase({ version: "1.0.0", runNpm })));
  });

  it("when the tarball carries no templates at all", () => {
    const runNpm = recording(
      fakeNpmPack(buildTgz(packageFiles({ "package.json": "{}" }))),
    );
    expectAdvice(failure(() => fetchBase({ version: "1.0.0", runNpm })));
  });

  it("removes the temp directory after a failure too", () => {
    const runNpm = recording(fakeNpmPack(new TextEncoder().encode("junk")));
    failure(() => fetchBase({ version: "1.0.0", runNpm }));
    expect(existsSync(destinationOf(runNpm.mock.calls[0]?.[0] ?? []))).toBe(
      false,
    );
  });
});
