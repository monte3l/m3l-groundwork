/**
 * Collects toolchain-enforcement facts: the tsconfig `extends` chain and its
 * effective strict-family flags, which eslint/test/formatter/git-hook tool
 * is in play and its config file, workflow files, and the full `scripts`
 * block. YAML-shaped config (git hooks, workflows) is indexed and excerpted
 * here, never parsed -- see `needsReading` on each -- because this package
 * carries no YAML dependency.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJsoncFile } from "../jsonc.js";
import type {
  EslintSurvey,
  FormatterSurvey,
  GitHooksSurvey,
  TestRunnerSurvey,
  ToolchainSurvey,
  TsconfigSurvey,
  WorkflowsSurvey,
} from "./types.js";

const STRICT_FLAG_NAMES = [
  "strict",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "exactOptionalPropertyTypes",
  "verbatimModuleSyntax",
  "isolatedModules",
  "noPropertyAccessFromIndexSignature",
  "noImplicitReturns",
];

const ESLINT_PLUGIN_PATTERN =
  /["']((?:eslint-plugin-|@typescript-eslint\/)[a-z0-9-]+)["']/gi;

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
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

/** Follows a tsconfig's `extends` chain, resolving Node-style relative paths, and merges compilerOptions root-first-overridden-by-child. */
function resolveTsconfigChain(
  entryPath: string,
  undetermined: string[],
): TsconfigSurvey {
  const effectiveFlags: Record<string, unknown> = {};
  let parsed = true;
  let currentPath: string | undefined = entryPath;
  const visited = new Set<string>();
  const chain: string[] = [];

  while (currentPath !== undefined && !visited.has(currentPath)) {
    visited.add(currentPath);
    chain.push(currentPath);

    const result = readJsoncFile(currentPath);
    if (!result.ok) {
      parsed = false;
      undetermined.push(`could not parse ${currentPath}: ${result.error}`);
      break;
    }

    const value = result.value as Record<string, unknown>;
    const extendsField = value["extends"];
    currentPath =
      typeof extendsField === "string"
        ? resolve(
            dirname(currentPath),
            extendsField.endsWith(".json")
              ? extendsField
              : `${extendsField}.json`,
          )
        : undefined;
  }

  // Apply root-first so a child file's flags override its parent's.
  for (const path of [...chain].reverse()) {
    const result = readJsoncFile(path);
    if (!result.ok) continue;
    const value = result.value as Record<string, unknown>;
    const compilerOptions = value["compilerOptions"];
    if (typeof compilerOptions === "object" && compilerOptions !== null) {
      for (const flag of STRICT_FLAG_NAMES) {
        const flagValue = (compilerOptions as Record<string, unknown>)[flag];
        if (flagValue !== undefined) {
          effectiveFlags[flag] = flagValue;
        }
      }
    }
  }

  return { files: chain, effectiveFlags, parsed };
}

function surveyTsconfig(dir: string, undetermined: string[]): TsconfigSurvey {
  const entryPath = findTsconfigPath(dir);
  if (entryPath === undefined) {
    return { files: [], effectiveFlags: {}, parsed: false };
  }
  return resolveTsconfigChain(entryPath, undetermined);
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
  const packageJson = readPackageJson(dir);
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
