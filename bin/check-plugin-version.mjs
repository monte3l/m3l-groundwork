#!/usr/bin/env node
/**
 * Fails when the plugin's Claude Code identity has drifted from the CLI's
 * release, or when either file has quietly grown npm-publish shape again --
 * the plugin ships only through the marketplace relative-path source, never
 * to npm. The sync half is `sync-plugin-version.mjs`; see lib/plugin-version.mjs.
 */
import process from "node:process";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";
import { readVersions } from "./lib/plugin-version.mjs";

const reporter = createReporter(parseJsonFlag(process.argv.slice(2)));
const v = readVersions(repoRoot());
const expected = v.cliPackage.version;

if (v.manifest.version === expected) {
  reporter.ok(`plugin.json version is ${expected}`);
} else {
  reporter.fail(
    `plugin.json version is ${v.manifest.version ?? "missing"}, but ${v.cliPackage.name} is ${expected} -- run \`node bin/sync-plugin-version.mjs\``,
  );
}

if (v.pluginPackagePrivate) {
  reporter.ok("packages/plugin/package.json stays private (no npm release)");
} else {
  reporter.fail(
    'packages/plugin/package.json is not private -- the plugin ships only through the Claude Code marketplace, not npm; set "private": true, or restore its npm publish setup deliberately',
  );
}

if (v.marketplace.entryName === undefined) {
  reporter.fail(
    `.claude-plugin/marketplace.json has no plugin entry named "${v.manifest.name}"`,
  );
} else {
  reporter.ok(
    `marketplace entry "${v.marketplace.entryName}" matches plugin.json`,
  );
}

if (v.marketplace.sourceIsNpm) {
  reporter.fail(
    ".claude-plugin/marketplace.json points the plugin at an npm source -- it should be a relative path into packages/plugin instead",
  );
}

if (v.marketplace.entryVersion !== undefined) {
  reporter.fail(
    `.claude-plugin/marketplace.json pins the plugin to ${v.marketplace.entryVersion} -- drop that field so it inherits plugin.json's version instead`,
  );
} else {
  reporter.ok(
    "marketplace entry has no separate version pin (inherits plugin.json)",
  );
}

reporter.finish();
