#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Grades the Claude Code harness this repo EMITS -- `templates/core/.claude`
 * plus its `CLAUDE.md` -- so a broken hook registration, a skill with no
 * frontmatter, or a doc path that names a deleted file is caught here, before
 * it ships to every bootstrapped project. Uses the emitted gate's own rule
 * module (not a copy), so what this checks is exactly what every emitted
 * project's `bin/check-harness.mjs` checks. Structural findings fail;
 * rubric findings only warn.
 */
import process from "node:process";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import {
  gradeHarness,
  reportGrade,
  reportOfficialValidation,
} from "../templates/core/bin/lib/harness-rules.mjs";

const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));
const root = join(repoRoot(), "templates", "core");

reportGrade(gradeHarness(root), reporter);
reportOfficialValidation(root, reporter);

reporter.finish();
