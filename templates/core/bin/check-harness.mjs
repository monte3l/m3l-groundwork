#!/usr/bin/env node
/**
 * Grades this project's Claude Code harness (`.claude/` plus `CLAUDE.md`).
 * A structural defect -- a hook registration that points at a missing file, a
 * hook script nothing registers, a skill or agent with unreadable
 * frontmatter, a `CLAUDE.md` path that no longer exists -- fails the gate.
 * A rubric finding -- an oversized skill, a thin description, an unpinned
 * model, a dead rule glob -- only warns, because a subjective rule must never
 * block a push. Rules live in bin/lib/harness-rules.mjs. When the `claude`
 * CLI is installed it also relays Anthropic's own `claude plugin validate`
 * findings, as warnings only.
 */
import process from "node:process";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import {
  gradeHarness,
  reportGrade,
  reportOfficialValidation,
} from "./lib/harness-rules.mjs";

const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));
const root = repoRoot();

reportGrade(gradeHarness(root), reporter);
reportOfficialValidation(root, reporter);

reporter.finish();
