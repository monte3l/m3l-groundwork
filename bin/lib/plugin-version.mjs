#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The plugin never has an npm release of its own -- it is listed by the
 * central `monte3l/m3l-plugins` Claude Code marketplace, pinned to a release
 * tag of this repo, and this repo ships no marketplace manifest of its own. Its
 * user-facing identity, `packages/plugin/.claude-plugin/plugin.json`'s version,
 * is instead kept in step with the CLI's (`packages/cli/package.json`) so the two carry
 * one number: release-please writes both (`extra-files` in
 * `release-please-config.json`), `check-plugin-version.mjs` is the gate that
 * fails when they have drifted, or when the plugin package has
 * quietly grown npm-publish shape again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_PACKAGE = "packages/cli/package.json";
const PLUGIN_MANIFEST = "packages/plugin/.claude-plugin/plugin.json";
// Read by readVersions() only, so it does not need to be exported.
const PLUGIN_PACKAGE = "packages/plugin/package.json";

function readJson(root, relPath) {
  return JSON.parse(readFileSync(join(root, relPath), "utf8"));
}

/**
 * Every version and name fact the gate compares. A field that cannot
 * be found is `undefined` rather than a throw, so the gate can name exactly
 * what is missing.
 */
export function readVersions(root) {
  const cli = readJson(root, CLI_PACKAGE);
  const manifest = readJson(root, PLUGIN_MANIFEST);
  const pluginPackage = readJson(root, PLUGIN_PACKAGE);

  return {
    cliPackage: { name: cli.name, version: cli.version },
    manifest: { name: manifest.name, version: manifest.version },
    pluginPackagePrivate: pluginPackage.private === true,
  };
}
