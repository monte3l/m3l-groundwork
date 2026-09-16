#!/usr/bin/env node
/**
 * Makes `.node-version` the single authoritative Node version pin. Forbids
 * a hardcoded `node-version:` literal anywhere in `.github/workflows/*.yml`
 * -- every workflow must instead read `node-version-file: .node-version` (or
 * an equivalent file-derived expression), so the pin can never drift between
 * the file a developer's version manager reads and what CI actually runs.
 */
import process from "node:process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot();
const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));

const pinPath = join(root, ".node-version");
if (!existsSync(pinPath)) {
  reporter.fail(".node-version is missing at the repo root");
  reporter.finish();
  process.exit(process.exitCode ?? 1);
}

const pin = readFileSync(pinPath, "utf8").trim();
reporter.ok(`.node-version pins ${pin}`);

const workflowsDir = join(root, ".github", "workflows");
const HARDCODED_VERSION = /node-version:\s*['"]?\d/;
const FILE_DERIVED = /node-version-file:/;

if (existsSync(workflowsDir)) {
  for (const entry of readdirSync(workflowsDir)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const text = readFileSync(join(workflowsDir, entry), "utf8");
    const hasHardcoded = HARDCODED_VERSION.test(text);
    const hasFileDerived = FILE_DERIVED.test(text);
    if (hasHardcoded && !hasFileDerived) {
      reporter.fail(
        `.github/workflows/${entry} hardcodes a node-version literal instead of node-version-file: .node-version`,
      );
    } else {
      reporter.ok(
        `.github/workflows/${entry} derives its Node version from the pin file`,
      );
    }
  }
} else {
  reporter.ok("no .github/workflows directory to check");
}

reporter.finish();
