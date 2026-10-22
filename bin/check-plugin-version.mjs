#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Fails when the plugin's Claude Code identity has drifted from the CLI's
 * release, or when the plugin package has quietly grown npm-publish shape
 * again -- the plugin is listed by the central `monte3l/m3l-plugins`
 * marketplace, pinned to a release tag, never published to npm. release-please writes both versions (`extra-files` in release-please-config.json); see lib/plugin-version.mjs.
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
    `plugin.json version is ${v.manifest.version ?? "missing"}, but ${v.cliPackage.name} is ${expected} -- release-please writes both from \`extra-files\` in release-please-config.json, so check that entry and do not edit either version by hand`,
  );
}

if (v.pluginPackagePrivate) {
  reporter.ok("packages/plugin/package.json stays private (no npm release)");
} else {
  reporter.fail(
    'packages/plugin/package.json is not private -- the plugin ships only through the central monte3l/m3l-plugins marketplace, not npm; set "private": true, or restore its npm publish setup deliberately',
  );
}

reporter.finish();
