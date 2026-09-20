#!/usr/bin/env node
/**
 * Grades this project's TypeScript toolchain. A structural defect -- a build
 * project that emits nowhere, a tsconfig `extends` that resolves to nothing,
 * a verify step naming a script that does not exist, a `.node-version` that
 * contradicts `engines.node` -- fails the gate. A rubric finding -- a missing
 * strict flag, an option TypeScript has deprecated, an ESLint config without
 * type-aware linting, a coverage gate that is not per-file -- only warns,
 * because a subjective rule must never block a push. Rules live in
 * bin/lib/toolchain-rules.mjs. Offline: it reads files and never runs them.
 */
import process from "node:process";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import { gradeToolchain, reportGrade } from "./lib/toolchain-rules.mjs";

const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));

reportGrade(gradeToolchain(repoRoot()), reporter);

reporter.finish();
