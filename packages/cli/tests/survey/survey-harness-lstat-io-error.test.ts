// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `guardedLstat` (the plugin-layout probe): an errno that is neither "absent"
 * (`ENOENT`/`ENOTDIR`) nor a per-path permission problem (`EACCES`/`EPERM`/
 * `ELOOP`) -- here `EIO` -- must throw a `SurveyReadError` naming the path
 * with the original failure as `cause`, never land in `undetermined`.
 * `node:fs` is mocked (`importOriginal`-preserving) in this file only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";

const { lstatSyncMock } = vi.hoisted(() => ({ lstatSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, lstatSync: lstatSyncMock };
});

const { surveyHarness } = await import("../../src/survey/survey-harness.js");
const { SurveyReadError } =
  await import("../../src/survey/internal/read-guard.js");

describe("surveyHarness -- a non-permission lstat failure on the plugin manifest probe propagates", () => {
  const dir = "/nonexistent-harness-lstat-project";
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(() => {
    lstatSyncMock.mockReset();
    lstatSyncMock.mockImplementation(() => {
      throw ioFailure;
    });
  });

  afterEach(() => {
    lstatSyncMock.mockReset();
  });

  it("throws a SurveyReadError naming the manifest path with the EIO as cause, leaving undetermined empty", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SurveyReadError);
    expect((thrown as Error).message).toContain(
      `${dir}/.claude-plugin/plugin.json`,
    );
    expect((thrown as Error).cause).toBe(ioFailure);
    expect(undetermined).toEqual([]);
  });
});
