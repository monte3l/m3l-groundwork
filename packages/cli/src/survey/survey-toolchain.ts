/**
 * Collects toolchain-enforcement facts: the tsconfig `extends` chain and its
 * effective strict-family flags, which eslint/test/formatter/git-hook tool
 * is in play and its config file, workflow files, and the full `scripts`
 * block. YAML-shaped config (git hooks, workflows) is indexed and excerpted
 * here, never parsed -- see `needsReading` on each -- because this package
 * carries no YAML dependency.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STRICT_FLAGS } from "../toolchain/rules.js";
import { loadTsconfigChain } from "../toolchain/tsconfig-chain.js";
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

function readPackageJson(
  dir: string,
  undetermined: string[],
): Record<string, unknown> | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    undetermined.push(
      `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function findTsconfigPath(dir: string): string | undefined {
  for (const name of ["tsconfig.json"]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
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
  const entryPath = findTsconfigPath(dir);
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

function surveyEslint(dir: string): EslintSurvey {
  const flatCandidates = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
  ];
  const legacyCandidates = [
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc",
  ];

  for (const name of flatCandidates) {
    const path = join(dir, name);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      return {
        configFile: name,
        flat: true,
        referencedPlugins: extractPluginNames(content),
      };
    }
  }
  for (const name of legacyCandidates) {
    const path = join(dir, name);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      return {
        configFile: name,
        flat: false,
        referencedPlugins: extractPluginNames(content),
      };
    }
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
    if (existsSync(join(dir, name))) {
      return { tool, configFile: name };
    }
  }
  const testScript = scripts["test"] ?? "";
  if (/node --test/.test(testScript)) {
    return { tool: "node-test", configFile: undefined };
  }
  return { tool: "unknown", configFile: undefined };
}

function surveyFormatter(dir: string): FormatterSurvey {
  const prettierCandidates = [
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc",
    ".prettierrc.yaml",
    ".prettierrc.yml",
  ];
  for (const name of prettierCandidates) {
    if (existsSync(join(dir, name))) {
      return { tool: "prettier", configFile: name };
    }
  }
  if (existsSync(join(dir, "biome.json"))) {
    return { tool: "biome", configFile: "biome.json" };
  }
  return { tool: "unknown", configFile: undefined };
}

function surveyGitHooks(dir: string, undetermined: string[]): GitHooksSurvey {
  if (
    existsSync(join(dir, "lefthook.yml")) ||
    existsSync(join(dir, "lefthook.yaml"))
  ) {
    const configFile = existsSync(join(dir, "lefthook.yml"))
      ? "lefthook.yml"
      : "lefthook.yaml";
    undetermined.push(
      `${configFile} found -- its stage commands need reading, not parsing`,
    );
    return { manager: "lefthook", configFile, needsReading: true };
  }
  if (existsSync(join(dir, ".husky"))) {
    undetermined.push(
      ".husky/ found -- its hook scripts need reading, not parsing",
    );
    return { manager: "husky", configFile: ".husky", needsReading: true };
  }
  if (existsSync(join(dir, "simple-git-hooks.json"))) {
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
  if (!existsSync(workflowsDir)) {
    return { files: [], needsReading: false };
  }
  const files = readdirSync(workflowsDir).filter((name) =>
    /\.ya?ml$/.test(name),
  );
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

/** Surveys toolchain enforcement at `dir`. Appends anything it could not parse to `undetermined`. */
export function surveyToolchain(
  dir: string,
  undetermined: string[],
): ToolchainSurvey {
  const packageJson = readPackageJson(dir, undetermined);
  const scripts = surveyScripts(packageJson);

  return {
    tsconfig: surveyTsconfig(dir, undetermined),
    eslint: surveyEslint(dir),
    testRunner: surveyTestRunner(dir, scripts),
    formatter: surveyFormatter(dir),
    gitHooks: surveyGitHooks(dir, undetermined),
    workflows: surveyWorkflows(dir, undetermined),
    scripts,
  };
}
