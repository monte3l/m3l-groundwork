// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--fetch-base` in `runUpdate` and `runCheckUpdate`: `options.fetchBase`
 * and the injected `deps.runNpm`. The fetch runs once, for the resolved base
 * version, only when a base is hash-only/missing or `--base-version` was
 * given; a failure is a `CliUsageError` that leaves the project untouched;
 * `plan.json` records `base.fetched`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate } from "../src/update.js";
import { runCheckUpdate } from "../src/check-update.js";
import { classifyProject } from "../src/update-classify.js";
import { BASE_DIR, BASE_SUFFIX } from "../src/lock.js";
import { CliUsageError } from "../src/usage.js";
import type { TemplateHistory } from "../src/template-history.js";
import { snapshotTree } from "./add-pack-fixtures.js";
import { buildTgz, fakeNpmPack, packageFiles } from "./tarball-fixtures.js";
import type { FakeNpmResult } from "./tarball-fixtures.js";
import { sha256 } from "./update-classify-fixtures.js";
import {
  currentCoreHashes,
  olderProject,
  planEntry,
  readPlan,
  RUNNING,
  TAKE,
  TEXT_CONFLICT,
  TEXT_MERGE,
  updateDeps,
} from "./update-fixtures.js";

let root: string;
let project: string;
let pristine: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "update-fetch-"));
  project = join(root, "project");
  pristine = join(root, "pristine");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_CONFIG_NOSYSTEM"];
  rmSync(root, { recursive: true, force: true });
});

type RunNpmFn = (args: readonly string[], cwd: string) => FakeNpmResult;

/**
 * Makes the merge and conflict files' bases hash-only: the snapshots are
 * removed but the lock keeps their hashes. Returns their old texts, which
 * is what a fetched release would hold.
 */
function dropSnapshots(): Record<string, string> {
  const old: Record<string, string> = {};
  for (const path of [TEXT_MERGE, TEXT_CONFLICT]) {
    const snapshot = join(project, BASE_DIR, `${path}${BASE_SUFFIX}`);
    old[path] = readFileSync(snapshot, "utf8");
    rmSync(snapshot);
  }
  return old;
}

function npmServing(
  old: Readonly<Record<string, string>>,
): ReturnType<typeof vi.fn<RunNpmFn>> {
  const templates = Object.fromEntries(
    Object.entries(old).map(([path, text]) => [`templates/core/${path}`, text]),
  );
  return vi.fn<RunNpmFn>(fakeNpmPack(buildTgz(packageFiles(templates))));
}

const refused = (attempt: () => unknown): unknown => {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("runUpdate --fetch-base", () => {
  it("turns hash-only bases into merge and conflict, fetching the lock's base once", () => {
    olderProject(project, pristine);
    const runNpm = npmServing(dropSnapshots());
    expect(
      runUpdate(
        { targetDir: project, fetchBase: true },
        { ...updateDeps(), runNpm },
      ),
    ).toBe(0);
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runNpm.mock.calls[0]?.[0]).toContain("@monte3l/groundwork@1.0.0");
    const plan = readPlan(project);
    expect(plan.base).toMatchObject({ version: "1.0.0", fetched: true });
    expect(planEntry(plan, TEXT_MERGE).action).toBe("merge");
    expect(planEntry(plan, TEXT_CONFLICT).action).toBe("conflict");
  });

  it("without --fetch-base the same project reviews, never calls npm, and records fetched: false", () => {
    olderProject(project, pristine);
    dropSnapshots();
    const runNpm = vi.fn<RunNpmFn>();
    runUpdate({ targetDir: project }, { ...updateDeps(), runNpm });
    expect(runNpm).not.toHaveBeenCalled();
    const plan = readPlan(project);
    expect(plan.base).toMatchObject({ fetched: false });
    expect(planEntry(plan, TEXT_MERGE).action).toBe("review");
  });

  it("does not call npm when every base resolves offline, and records fetched: false", () => {
    olderProject(project, pristine);
    const runNpm = vi.fn<RunNpmFn>();
    runUpdate(
      { targetDir: project, fetchBase: true },
      { ...updateDeps(), runNpm },
    );
    expect(runNpm).not.toHaveBeenCalled();
    expect(readPlan(project).base).toMatchObject({ fetched: false });
  });

  it("fetches for the --base-version release even when everything resolves offline", () => {
    olderProject(project, pristine);
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.0.5": {
          core: { ...currentCoreHashes(), [TAKE]: sha256("older: true\n") },
          packs: {},
        },
      },
      blobs: {},
    };
    const runNpm = npmServing({ [TAKE]: "older: true\n" });
    runUpdate(
      { targetDir: project, baseVersion: "1.0.5", fetchBase: true },
      { history: { history }, runningVersion: RUNNING, runNpm },
    );
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runNpm.mock.calls[0]?.[0]).toContain("@monte3l/groundwork@1.0.5");
    expect(readPlan(project).base).toMatchObject({
      version: "1.0.5",
      source: "flag",
      fetched: true,
    });
  });

  it.each<[string, FakeNpmResult]>([
    [
      "npm is missing",
      { status: 0, stdout: "", stderr: "", error: new Error("ENOENT") },
    ],
    ["npm fails", { status: 1, stdout: "", stderr: "npm error E404" }],
    ["npm prints nonsense", { status: 0, stdout: "???", stderr: "" }],
  ])(
    "a failed fetch (%s) is a CliUsageError and writes nothing",
    (_label, result) => {
      olderProject(project, pristine);
      dropSnapshots();
      const before = snapshotTree(root);
      const thrown = refused(() =>
        runUpdate(
          { targetDir: project, fetchBase: true },
          { ...updateDeps(), runNpm: () => result },
        ),
      );
      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as CliUsageError).message).toContain("--fetch-base");
      expect(snapshotTree(root)).toEqual(before);
    },
  );
});

describe("runCheckUpdate --fetch-base", () => {
  /** Runs the check with a spy classifier, returning what it was given. */
  function check(
    options: { fetchBase?: boolean; baseVersion?: string },
    runNpm: RunNpmFn,
  ): ReturnType<typeof vi.fn<typeof classifyProject>> {
    const classify = vi.fn<typeof classifyProject>(classifyProject);
    runCheckUpdate(
      { targetDir: project, ...options },
      { ...updateDeps(), runNpm, classify },
    );
    return classify;
  }

  it("hands the fetched base to the classifier when a base is hash-only", () => {
    olderProject(project, pristine);
    const runNpm = npmServing(dropSnapshots());
    const classify = check({ fetchBase: true }, runNpm);
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runNpm.mock.calls[0]?.[0]).toContain("@monte3l/groundwork@1.0.0");
    expect(classify.mock.calls[0]?.[0].fetchedBase).toBeDefined();
  });

  it("does not fetch, and passes no fetched base, without the flag", () => {
    olderProject(project, pristine);
    dropSnapshots();
    const runNpm = vi.fn<RunNpmFn>();
    const classify = check({}, runNpm);
    expect(runNpm).not.toHaveBeenCalled();
    expect(classify.mock.calls[0]?.[0].fetchedBase).toBeUndefined();
  });

  it("does not call npm when every base resolves offline", () => {
    olderProject(project, pristine);
    const runNpm = vi.fn<RunNpmFn>();
    const classify = check({ fetchBase: true }, runNpm);
    expect(runNpm).not.toHaveBeenCalled();
    expect(classify.mock.calls[0]?.[0].fetchedBase).toBeUndefined();
  });

  it("is a CliUsageError, writing nothing, when the fetch fails", () => {
    olderProject(project, pristine);
    dropSnapshots();
    const before = snapshotTree(root);
    const thrown = refused(() =>
      runCheckUpdate(
        { targetDir: project, fetchBase: true },
        {
          ...updateDeps(),
          runNpm: () => ({ status: 1, stdout: "", stderr: "npm error" }),
        },
      ),
    );
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect(snapshotTree(root)).toEqual(before);
  });
});
