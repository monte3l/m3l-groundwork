#!/usr/bin/env node
/**
 * Grades the TypeScript toolchain this repo EMITS -- `templates/core`'s
 * tsconfig chain, ESLint config, coverage gate, verify-step wiring and
 * toolchain pins -- so a bad edit to the baseline is caught here, before it
 * ships to every bootstrapped project. Uses the emitted gate's own rule
 * module (not a copy), so what this checks is exactly what every emitted
 * project's `bin/check-toolchain.mjs` checks. Structural findings fail;
 * rubric findings only warn. `templates/core` is expected to score clean.
 */
import process from "node:process";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import {
  gradeToolchain,
  reportGrade,
} from "../templates/core/bin/lib/toolchain-rules.mjs";

const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));
const root = join(repoRoot(), "templates", "core");

reportGrade(gradeToolchain(root), reporter);

reporter.finish();
