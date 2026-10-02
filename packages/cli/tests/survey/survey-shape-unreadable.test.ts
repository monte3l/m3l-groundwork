// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2: `surveyShape` must never abort because a project file it reads is
 * unreadable (`EACCES`/`EPERM`). `package.json`'s read already lands inside
 * `readPackageJson`'s existing try/catch (so an `EACCES` there already, by
 * accident, lands in `undetermined` rather than throwing -- this file still
 * pins that behavior so a future refactor can't regress it quietly), but
 * `pnpm-workspace.yaml`, `.node-version`/`.nvmrc`, and the root directory
 * listing `detectSourceLayout` uses are read with a bare, unguarded
 * `readFileSync`/`readdirSync` today and must be fixed to match.
 *
 * The non-permission (`EIO`) cases live in `survey-shape-io-error.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyShape } from "../../src/survey/survey-shape.js";
import { chmodIneffective } from "../chmod-ineffective.js";

describe("surveyShape: an unreadable project file is recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shape-unreadable-"));
    undetermined = [];
  });

  afterEach(() => {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone or already readable.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "an unreadable package.json is recorded in undetermined with EACCES rather than thrown (existing guard, pinned against regression)",
    () => {
      const path = join(dir, "package.json");
      writeFileSync(path, JSON.stringify({ name: "acme" }));
      chmodSync(path, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyShape(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.moduleType).toBe("unspecified");
      expect(
        undetermined.some(
          (entry) => entry.includes(path) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable pnpm-workspace.yaml does not throw: monorepoTool stays 'pnpm-workspaces' (from existsSync alone), workspaceGlobs falls back to [], and the path is recorded in undetermined",
    () => {
      const path = join(dir, "pnpm-workspace.yaml");
      writeFileSync(path, 'packages:\n  - "packages/*"\n');
      chmodSync(path, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyShape(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.monorepoTool).toBe("pnpm-workspaces");
      expect(survey?.workspaceGlobs).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(path) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .node-version falls through to a readable .nvmrc instead of aborting node-version detection, and records the unreadable path in undetermined",
    () => {
      const nodeVersionPath = join(dir, ".node-version");
      writeFileSync(nodeVersionPath, "24.0.0\n");
      chmodSync(nodeVersionPath, 0o000);
      writeFileSync(join(dir, ".nvmrc"), "22.0.0\n");

      let thrown: unknown;
      let survey;
      try {
        survey = surveyShape(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.nodeVersionPin).toEqual({
        source: ".nvmrc",
        value: "22.0.0",
      });
      expect(
        undetermined.some(
          (entry) =>
            entry.includes(nodeVersionPath) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable project root directory does not abort surveyShape: sourceLayout falls back to 'unknown' and the directory is recorded in undetermined",
    () => {
      // detectSourceLayout falls through to readdirSync(dir) only when
      // neither src/ nor lib/ exists -- an unreadable root directory makes
      // that call itself fail today, uncaught.
      chmodSync(dir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyShape(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.sourceLayout).toBe("unknown");
      expect(
        undetermined.some(
          (entry) => entry.includes(dir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it("a directory named package.json is recorded in undetermined with EISDIR rather than thrown", () => {
    const path = join(dir, "package.json");
    mkdirSync(path);

    let thrown: unknown;
    let survey;
    try {
      survey = surveyShape(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(survey?.moduleType).toBe("unspecified");
    expect(
      undetermined.some(
        (entry) => entry.includes(path) && entry.includes("EISDIR"),
      ),
    ).toBe(true);
  });
});
