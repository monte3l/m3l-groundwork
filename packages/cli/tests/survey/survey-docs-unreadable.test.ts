// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2: `surveyDocs` must never abort because an indexed doc file, or a
 * named doc directory, is unreadable (`EACCES`/`EPERM`). `indexFile`'s
 * `readFileSync` (headings) and `collectNamedDirectories`'s underlying
 * directory walk are both unguarded today.
 *
 * This pins `surveyDocs(dir, undetermined)` as a REQUIRED two-argument
 * function, the same shape `surveyShape`/`surveyToolchain` already use --
 * `survey-docs.test.ts`'s existing one-argument calls are updated in the
 * same change. An unreadable doc keeps its entry (its size, from `statSync`,
 * which needs no read permission on the file itself, is still determinable)
 * but with empty `headings`, since those can only come from content; the
 * unreadable path is also recorded in `undetermined`.
 *
 * The non-permission (`EIO`) case lives in `survey-docs-io-error.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyDocs } from "../../src/survey/survey-docs.js";
import { chmodIneffective } from "../chmod-ineffective.js";

describe("surveyDocs: an unreadable project file is recorded in undetermined, never thrown", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-unreadable-"));
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
    tryChmod(join(dir, "docs", "adr"));
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(chmodIneffective)(
    "an unreadable README.md keeps its entry (sizeBytes from statSync) with empty headings, rather than throwing, and records the path in undetermined",
    () => {
      const path = join(dir, "README.md");
      writeFileSync(path, "# Title\n\n## Usage\n");
      chmodSync(path, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyDocs(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      const readme = survey?.files.find((f) => f.path === path);
      expect(readme).toBeDefined();
      expect(readme?.headings).toEqual([]);
      expect(readme?.sizeBytes).toBeGreaterThan(0);
      expect(
        undetermined.some(
          (entry) => entry.includes(path) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(chmodIneffective)(
    "an unreadable docs/adr/ directory does not throw: its files are simply absent from files[], and the directory is recorded in undetermined",
    () => {
      mkdirSync(join(dir, "docs", "adr"), { recursive: true });
      writeFileSync(join(dir, "docs", "adr", "0001-foo.md"), "# ADR 1\n");
      const adrDir = join(dir, "docs", "adr");
      chmodSync(adrDir, 0o000);

      let thrown: unknown;
      let survey;
      try {
        survey = surveyDocs(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.files.some((f) => f.path.includes("0001-foo.md"))).toBe(
        false,
      );
      expect(
        undetermined.some(
          (entry) => entry.includes(adrDir) && entry.includes("EACCES"),
        ),
      ).toBe(true);
    },
  );

  it(
    "a symlink loop within docs/adr/ is excluded from files[] and recorded in undetermined with ELOOP, without throwing " +
      "(RED: indexFile's own statSync call only recognizes EACCES/EPERM today, so ELOOP throws)",
    () => {
      mkdirSync(join(dir, "docs", "adr"), { recursive: true });
      const loopA = join(dir, "docs", "adr", "loop.md");
      const loopB = join(dir, "docs", "adr", "loop-b");
      symlinkSync(loopB, loopA);
      symlinkSync(loopA, loopB);
      writeFileSync(join(dir, "docs", "adr", "0001-foo.md"), "# ADR 1\n");

      let thrown: unknown;
      let survey;
      try {
        survey = surveyDocs(dir, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(survey?.files.some((f) => f.path === loopA)).toBe(false);
      expect(survey?.files.some((f) => f.path.includes("0001-foo.md"))).toBe(
        true,
      );
      expect(
        undetermined.some(
          (entry) => entry.includes(loopA) && entry.includes("ELOOP"),
        ),
      ).toBe(true);
    },
  );
});
