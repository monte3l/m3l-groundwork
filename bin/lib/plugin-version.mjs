#!/usr/bin/env node
/**
 * The plugin never has an npm release of its own -- it ships only through the
 * Claude Code marketplace, as a relative-path source pointed straight at
 * `packages/plugin` (`.claude-plugin/marketplace.json`). Its user-facing
 * identity, `packages/plugin/.claude-plugin/plugin.json`'s version, is instead
 * kept in step with the CLI's (`packages/cli/package.json`) so the two carry
 * one number: `sync-plugin-version.mjs` writes it, `check-plugin-version.mjs`
 * is the gate that fails when it has drifted, or when either file has quietly
 * grown npm-publish shape again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CLI_PACKAGE = "packages/cli/package.json";
export const PLUGIN_MANIFEST = "packages/plugin/.claude-plugin/plugin.json";
// Read by readVersions() only -- sync-plugin-version.mjs never writes to
// either, so neither needs to be exported.
const PLUGIN_PACKAGE = "packages/plugin/package.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";

function readJson(root, relPath) {
  return JSON.parse(readFileSync(join(root, relPath), "utf8"));
}

/** True for the shape `{ source: "npm", package: ..., version: ... }`. */
function isNpmSource(source) {
  return (
    typeof source === "object" && source !== null && source.source === "npm"
  );
}

/**
 * Every version, name and source fact the gate compares. A field that cannot
 * be found is `undefined` rather than a throw, so the gate can name exactly
 * what is missing.
 */
export function readVersions(root) {
  const cli = readJson(root, CLI_PACKAGE);
  const manifest = readJson(root, PLUGIN_MANIFEST);
  const pluginPackage = readJson(root, PLUGIN_PACKAGE);
  const marketplace = readJson(root, MARKETPLACE);

  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = entries.find((candidate) => candidate?.name === manifest.name);

  return {
    cliPackage: { name: cli.name, version: cli.version },
    manifest: { name: manifest.name, version: manifest.version },
    pluginPackagePrivate: pluginPackage.private === true,
    marketplace: {
      entryName: entry?.name,
      entryVersion: entry?.version,
      sourceIsNpm: isNpmSource(entry?.source),
    },
  };
}

/**
 * Replaces the value of the file's single `"version"` key in place. Editing the
 * text instead of re-serializing keeps Prettier's formatting intact, so a
 * version PR does not fail `format:check`. Throws unless there is exactly one
 * such key -- a second would make "the" version ambiguous.
 */
export function setVersion(text, version) {
  const pattern = /("version"\s*:\s*")[^"]*(")/g;
  const matches = text.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "version" key, found ${matches.length}`,
    );
  }
  return text.replace(
    pattern,
    (_whole, open, close) => `${open}${version}${close}`,
  );
}
