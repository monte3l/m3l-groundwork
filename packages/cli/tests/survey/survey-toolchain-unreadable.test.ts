// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2: `surveyToolchain` must never abort because a project file it reads
 * is unreadable (`EACCES`/`EPERM`). `package.json`'s read already lands
 * inside `readPackageJson`'s existing try/catch (pinned here against
 * regression, same as `survey-shape-unreadable.test.ts`), but the tsconfig
 * chain (via `loadTsconfigChain` -> `readJsoncFile`, whose own header comment
 * claims "nothing here throws" while its `readFileSync` call is in fact
 * unguarded), the ESLint config file content, and the
 * `.github/workflows/` directory listing are not -- they throw raw and
 * uncaught today.
 *
 * The non-permission (`EIO`) case lives in `survey-toolchain-io-error.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyToolchain } from "../../src/survey/survey-toolchain.js";
import { chmodIneffective } from "../chmod-ineffective.js";

describe("surveyToolchain: an unreadable project file is recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-unreadable-"));
    undetermined = [];
  });

  afterEach(() => {
    const tryChmod = (path: string): void => {
      try {
        chmodSync(path, 0o755);
      } catch {
        // already gone or already readable.
      }
    };
    tryChmod(join(dir, ".github", "workflows"));
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
        survey = surveyToolchain(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.scripts).toEqual({});
      expect(
        undetermined.some(
          (entry) => entry.includes(path) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable tsconfig.json does not throw: tsconfig.parsed is false and the path is recorded in undetermined",
    () => {
      const path = join(dir, "tsconfig.json");
      writeFileSync(
        path,
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      chmodSync(path, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyToolchain(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.tsconfig.parsed).toBe(false);
      expect(
        undetermined.some(
          (entry) => entry.includes(path) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable eslint.config.js does not throw: configFile is still reported (from existsSync), referencedPlugins falls back to [], and the path is recorded in undetermined",
    () => {
      const path = join(dir, "eslint.config.js");
      writeFileSync(path, "export default [{ plugins: ['foo'] }];\n");
      chmodSync(path, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyToolchain(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.eslint.configFile).toBe("eslint.config.js");
      expect(survey?.eslint.referencedPlugins).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(path) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable .github/workflows/ directory does not throw: files falls back to [] and the directory is recorded in undetermined",
    () => {
      const workflowsDir = join(dir, ".github", "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, "ci.yml"), "name: ci\n");
      chmodSync(workflowsDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyToolchain(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.workflows.files).toEqual([]);
      expect(
        undetermined.some(
          (entry) => entry.includes(workflowsDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );
});
