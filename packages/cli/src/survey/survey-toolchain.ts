// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Collects toolchain-enforcement facts: the tsconfig `extends` chain and its
 * effective strict-family flags, which eslint/test/formatter/git-hook tool
 * is in play and its config file, workflow files, and the full `scripts`
 * block. YAML-shaped config (git hooks, workflows) is indexed and excerpted
 * here, never parsed -- see `needsReading` on each -- because this package
 * carries no YAML dependency.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STRICT_FLAGS } from "../toolchain/rules.js";
import { loadTsconfigChain } from "../toolchain/tsconfig-chain.js";
import { readPackageJson } from "./internal/package-json.js";
import { guardedExists, guardedRead } from "./internal/read-guard.js";
import type {
  EslintSurvey,
  FormatterSurvey,
  GitHooksSurvey,
  TestRunnerSurvey,
  ToolchainSurvey,
  TsconfigSurvey,
  WorkflowsSurvey,
} from "./types.js";

/** Every flag the toolchain grader judges, so `effectiveFlags` and the grade cannot disagree. */
const STRICT_FLAG_NAMES = [...STRICT_FLAGS, "allowUnreachableCode"];

const ESLINT_PLUGIN_PATTERN =
  /["']((?:eslint-plugin-|@typescript-eslint\/)[a-z0-9-]+)["']/gi;

function findTsconfigPath(
  dir: string,
  undetermined: string[],
): string | undefined {
  for (const name of ["tsconfig.json"]) {
    const path = join(dir, name);
    if (guardedExists(path, undetermined)) return path;
  }
  return undefined;
}

/**
 * Follows a tsconfig's `extends` chain with the resolver the toolchain grader
 * shares, so the survey and the grade cannot disagree about a project's
 * effective flags. `files` are absolute and child-first. A file that fails to
 * parse, or a relative `extends` that points at nothing, is a parse failure; a
 * bare package specifier that is not installed is only a note -- the flags it
 * would contribute are simply absent.
 */
function surveyTsconfig(dir: string, undetermined: string[]): TsconfigSurvey {
  const entryPath = findTsconfigPath(dir, undetermined);
  if (entryPath === undefined) {
    return { files: [], effectiveFlags: {}, parsed: false };
  }

  const chain = loadTsconfigChain(dir, "tsconfig.json");
  let parsed = chain.parsed;
  for (const file of chain.files) {
    if (file.error !== undefined) {
      undetermined.push(`could not parse ${file.abs}: ${file.error}`);
    }
  }
  for (const link of chain.links) {
    if (link.resolved) continue;
    if (link.kind === "relative") {
      parsed = false;
      undetermined.push(
        `could not parse ${link.attempted}: ${link.attempted} does not exist`,
      );
    } else {
      undetermined.push(
        `tsconfig extends "${link.specifier}" from ${link.from} could not be resolved (is it installed?) -- the flags it sets are not in the effective set`,
      );
    }
  }

  const effectiveFlags: Record<string, unknown> = {};
  for (const flag of STRICT_FLAG_NAMES) {
    const value = chain.options[flag];
    if (value !== undefined) effectiveFlags[flag] = value;
  }
  return { files: chain.files.map((file) => file.abs), effectiveFlags, parsed };
}

const ESLINT_CANDIDATES: readonly (readonly [name: string, flat: boolean])[] = [
  ["eslint.config.js", true],
  ["eslint.config.mjs", true],
  ["eslint.config.ts", true],
  [".eslintrc.js", false],
  [".eslintrc.cjs", false],
  [".eslintrc.json", false],
  [".eslintrc", false],
];

/**
 * The first ESLint config present, flat configs first. An unreadable config
 * is still reported (its presence is known) with no plugins, and recorded.
 */
function surveyEslint(dir: string, undetermined: string[]): EslintSurvey {
  for (const [name, flat] of ESLINT_CANDIDATES) {
    const path = join(dir, name);
    if (!guardedExists(path, undetermined)) continue;
    const content = guardedRead(
      path,
      () => readFileSync(path, "utf8"),
      undetermined,
    );
    return {
      configFile: name,
      flat,
      referencedPlugins:
        content === undefined ? [] : extractPluginNames(content),
    };
  }
  return { configFile: undefined, flat: false, referencedPlugins: [] };
}

function extractPluginNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(ESLINT_PLUGIN_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

function surveyTestRunner(
  dir: string,
  scripts: Record<string, string>,
  undetermined: string[],
): TestRunnerSurvey {
  const candidates: [string, TestRunnerSurvey["tool"]][] = [
    ["vitest.config.ts", "vitest"],
    ["vitest.config.js", "vitest"],
    ["jest.config.js", "jest"],
    ["jest.config.cjs", "jest"],
    ["jest.config.ts", "jest"],
    ["jest.config.json", "jest"],
    [".mocharc.json", "mocha"],
    [".mocharc.js", "mocha"],
  ];
  for (const [name, tool] of candidates) {
    if (guardedExists(join(dir, name), undetermined)) {
      return { tool, configFile: name };
    }
  }
  const testScript = scripts["test"] ?? "";
  if (/node --test/.test(testScript)) {
    return { tool: "node-test", configFile: undefined };
  }
  return { tool: "unknown", configFile: undefined };
}

function surveyFormatter(dir: string, undetermined: string[]): FormatterSurvey {
  const prettierCandidates = [
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc",
    ".prettierrc.yaml",
    ".prettierrc.yml",
  ];
  for (const name of prettierCandidates) {
    if (guardedExists(join(dir, name), undetermined)) {
      return { tool: "prettier", configFile: name };
    }
  }
  if (guardedExists(join(dir, "biome.json"), undetermined)) {
    return { tool: "biome", configFile: "biome.json" };
  }
  return { tool: "unknown", configFile: undefined };
}

function surveyGitHooks(dir: string, undetermined: string[]): GitHooksSurvey {
  if (
    guardedExists(join(dir, "lefthook.yml"), undetermined) ||
    guardedExists(join(dir, "lefthook.yaml"), undetermined)
  ) {
    const configFile = guardedExists(join(dir, "lefthook.yml"), undetermined)
      ? "lefthook.yml"
      : "lefthook.yaml";
    undetermined.push(
      `${configFile} found -- its stage commands need reading, not parsing`,
    );
    return { manager: "lefthook", configFile, needsReading: true };
  }
  if (guardedExists(join(dir, ".husky"), undetermined)) {
    undetermined.push(
      ".husky/ found -- its hook scripts need reading, not parsing",
    );
    return { manager: "husky", configFile: ".husky", needsReading: true };
  }
  if (guardedExists(join(dir, "simple-git-hooks.json"), undetermined)) {
    return {
      manager: "simple-git-hooks",
      configFile: "simple-git-hooks.json",
      needsReading: true,
    };
  }
  return { manager: "none", configFile: undefined, needsReading: false };
}

function surveyWorkflows(dir: string, undetermined: string[]): WorkflowsSurvey {
  const workflowsDir = join(dir, ".github", "workflows");
  if (!guardedExists(workflowsDir, undetermined)) {
    return { files: [], needsReading: false };
  }
  const names =
    guardedRead(workflowsDir, () => readdirSync(workflowsDir), undetermined) ??
    [];
  const files = names.filter((name) => /\.ya?ml$/.test(name));
  if (files.length > 0) {
    undetermined.push(
      `${files.length} workflow file(s) under .github/workflows -- their job steps need reading, not parsing`,
    );
  }
  return { files, needsReading: files.length > 0 };
}

function surveyScripts(
  packageJson: Record<string, unknown> | undefined,
): Record<string, string> {
  const scripts = packageJson?.["scripts"];
  if (typeof scripts !== "object" || scripts === null) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/**
 * Surveys toolchain enforcement at `dir`. Appends anything it could not
 * parse, or could not read (`EACCES`/`EPERM`), to `undetermined`; any other
 * read failure throws, naming the path, with the original failure as
 * `cause`.
 *
 * @example
 * ```ts
 * import { surveyToolchain } from "./survey-toolchain.js";
 *
 * const undetermined: string[] = [];
 * const toolchain = surveyToolchain("/path/to/project", undetermined);
 * console.log(toolchain.tsconfig.effectiveFlags, undetermined);
 * ```
 */
export function surveyToolchain(
  dir: string,
  undetermined: string[],
): ToolchainSurvey {
  const packageJson = readPackageJson(dir, undetermined);
  const scripts = surveyScripts(packageJson);

  return {
    tsconfig: surveyTsconfig(dir, undetermined),
    eslint: surveyEslint(dir, undetermined),
    testRunner: surveyTestRunner(dir, scripts, undetermined),
    formatter: surveyFormatter(dir, undetermined),
    gitHooks: surveyGitHooks(dir, undetermined),
    workflows: surveyWorkflows(dir, undetermined),
    scripts,
  };
}
