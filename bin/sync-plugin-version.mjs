#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Copies the CLI package's version into plugin.json, the only other file
 * that needs to carry it (see lib/plugin-version.mjs -- the plugin has no
 * npm release of its own). Run as part of `version:packages`, so a "Version
 * Packages" PR bumps both together.
 */
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/report.mjs";
import {
  CLI_PACKAGE,
  PLUGIN_MANIFEST,
  setVersion,
} from "./lib/plugin-version.mjs";

const root = repoRoot();
const { version } = JSON.parse(readFileSync(join(root, CLI_PACKAGE), "utf8"));
if (typeof version !== "string" || version.length === 0) {
  console.error(`${CLI_PACKAGE} has no "version"`);
  process.exit(1);
}

const path = join(root, PLUGIN_MANIFEST);
const before = readFileSync(path, "utf8");
const after = setVersion(before, version);
if (after !== before) {
  writeFileSync(path, after);
  console.log(`${PLUGIN_MANIFEST} -> ${version}`);
}
