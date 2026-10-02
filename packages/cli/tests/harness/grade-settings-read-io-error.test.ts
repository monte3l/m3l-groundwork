// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `gradeHarness` must never throw -- it is offline and read-only, safe to
 * point at an adopted project whose `.claude/settings.json` can fail to
 * read for any reason, including one that says something about the
 * machine rather than the project (`EIO`, say). Today `readSettings`
 * (`harness/grade.ts`) delegates to `jsonc.ts`'s `readJsoncFile`, which
 * deliberately THROWS a `SurveyReadError` for any errno it doesn't
 * recognize as a property of the project's tree -- correct for every other
 * `readJsoncFile` caller, but wrong for a grader, which the emitted twin
 * (`templates/core/bin/lib/harness-rules.mjs`'s `readJsonc`) never does:
 * its own `try`/`catch` around `readFileSync` swallows literally every
 * failure and reports the raw error text instead. `node:fs`'s
 * `readFileSync` is mocked (`importOriginal`-preserving) in this file
 * ONLY, matching the isolation pattern every other mocked-`node:fs`
 * sibling file uses (see `packs-observe-wiring-io-error.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, readFileSync: readFileSyncMock };
});

const { gradeHarness } = await import("../../src/harness/grade.js");

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "core",
  "bin",
  "lib",
);
interface EmittedRules {
  gradeHarness: (rootDir: string) => { findings: unknown[] };
}
const emitted = (await import(
  pathToFileURL(join(libDir, "harness-rules.mjs")).href
)) as EmittedRules;

describe("gradeHarness -- a readFileSync failure on settings.json that isn't a recognized project-tree errno", () => {
  let root: string;
  let settingsPath: string;
  let realReadFileSync: typeof FsModule.readFileSync;
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReadFileSync = actual.readFileSync;
    readFileSyncMock.mockReset();
    root = mkdtempSync(join(tmpdir(), "grade-settings-eio-"));
    mkdirSync(join(root, ".claude"), { recursive: true });
    settingsPath = join(root, ".claude", "settings.json");
    writeFileSync(settingsPath, "{}");

    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.readFileSync>) => {
        const [path] = args;
        if (path === settingsPath) {
          throw ioFailure;
        }
        return (
          realReadFileSync as (
            ...callArgs: Parameters<typeof FsModule.readFileSync>
          ) => ReturnType<typeof FsModule.readFileSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    rmSync(root, { recursive: true, force: true });
  });

  it("never throws -- reports a settings-parses finding instead, like the emitted twin does", () => {
    let thrown: unknown;
    let ts: ReturnType<typeof gradeHarness> | undefined;
    try {
      ts = gradeHarness(root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(ts?.findings.some((f) => f.ruleId === "settings-parses")).toBe(true);
  });

  it("never throws on the emitted twin's side either, under the same mocked EIO", () => {
    let thrown: unknown;
    try {
      emitted.gradeHarness(root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
  });
});
