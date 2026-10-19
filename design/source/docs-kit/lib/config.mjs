// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Loads and validates a repository's `docs.config.mjs`. The directory that
 * holds the config file is the repository root; every path in the config is
 * relative to it. Validation is exhaustive and throws one `ConfigError`
 * listing every problem, so a bad config is fixed in one pass.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

/** A config the kit cannot run on: reported, exit 2. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED_STRINGS = ["title", "repo", "siteUrl", "designDir"];

/**
 * @param {unknown} config
 * @returns {string[]} one message per problem
 */
export function configProblems(config) {
  const problems = [];
  if (config === null || typeof config !== "object") {
    return ["the default export must be an object"];
  }
  const c = /** @type {Record<string, any>} */ (config);
  for (const key of REQUIRED_STRINGS) {
    if (typeof c[key] !== "string" || c[key] === "") {
      problems.push(`"${key}" must be a non-empty string`);
    }
  }
  if (typeof c.repo === "string" && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(c.repo)) {
    problems.push(`"repo" must look like https://github.com/<owner>/<name>`);
  }
  if (typeof c.siteUrl === "string" && !/^https:\/\/[^/]+$/.test(c.siteUrl)) {
    problems.push(`"siteUrl" must be an https origin with no path or trailing slash`);
  }
  if (!Array.isArray(c.navGroups) || c.navGroups.length === 0) {
    problems.push(`"navGroups" must be a non-empty array of strings`);
  }
  if (!Array.isArray(c.pages) || c.pages.length === 0) {
    problems.push(`"pages" must be a non-empty array`);
  } else {
    const outs = new Set();
    c.pages.forEach((page, i) => {
      const where = `pages[${i}]`;
      for (const key of ["src", "out", "group", "label"]) {
        if (typeof page?.[key] !== "string" || page[key] === "") {
          problems.push(`${where}.${key} must be a non-empty string`);
        }
      }
      if (Array.isArray(c.navGroups) && !c.navGroups.includes(page?.group)) {
        problems.push(`${where}.group "${page?.group}" is not in navGroups`);
      }
      if (typeof page?.out === "string") {
        if (outs.has(page.out)) problems.push(`${where}.out "${page.out}" is used twice`);
        outs.add(page.out);
      }
    });
    if (!c.pages.some((page) => page?.out === "index.html")) {
      problems.push(`one page must have out "index.html"`);
    }
  }
  for (const [key, shape] of [["exclude", "{ glob, reason }"]]) {
    const list = c[key] ?? [];
    if (!Array.isArray(list)) problems.push(`"${key}" must be an array of ${shape}`);
    else
      list.forEach((entry, i) => {
        if (typeof entry?.glob !== "string" || typeof entry?.reason !== "string" || entry.reason.trim() === "") {
          problems.push(`${key}[${i}] needs a "glob" and a non-empty "reason"`);
        }
      });
  }
  for (const key of ["generators", "parity", "nav"]) {
    if (c[key] !== undefined && !Array.isArray(c[key])) problems.push(`"${key}" must be an array`);
  }
  if (c.manifest !== undefined && typeof c.manifest !== "string") {
    problems.push(`"manifest" must be a path string`);
  }
  return problems;
}

/**
 * @param {string} configPath path to docs.config.mjs (absolute or cwd-relative)
 * @returns {Promise<{ root: string, configPath: string } & Record<string, any>>}
 */
export async function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  let module;
  try {
    module = await import(pathToFileURL(abs).href);
  } catch (error) {
    throw new ConfigError(`cannot load ${abs}: ${error.message}`);
  }
  const problems = configProblems(module.default);
  if (problems.length > 0) {
    throw new ConfigError(`${abs}:\n  - ${problems.join("\n  - ")}`);
  }
  return { ...module.default, root: path.dirname(abs), configPath: abs };
}
