// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Collects codebase-shape facts: package manager, monorepo tooling, module
 * system, pinned versions, source/test layout, and the evidence (not the
 * verdict) for what kind of project this is. `/customize`'s interview step
 * does the inferring; this module only records what is literally on disk.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { walkBounded } from "./fs-walk.js";
import { readPackageJson } from "./internal/package-json.js";
import { guardedRead } from "./internal/read-guard.js";
import type {
  KindEvidence,
  ModuleType,
  MonorepoTool,
  NodeVersionPin,
  PackageManager,
  ShapeSurvey,
  SourceLayout,
  TestPlacement,
} from "./types.js";

const FRAMEWORK_DEP_NAMES = [
  "react",
  "vue",
  "svelte",
  "next",
  "nuxt",
  "@angular/core",
  "express",
  "fastify",
  "koa",
  "@nestjs/core",
  "hono",
];

function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return "unknown";
}

function extractYamlStringListUnder(content: string, key: string): string[] {
  const lines = content.split("\n");
  const keyIndex = lines.findIndex((line) => line.trim() === `${key}:`);
  if (keyIndex === -1) {
    return [];
  }
  const items: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    const match = /^\s*-\s*["']?([^"'#]+)["']?\s*$/.exec(line);
    if (match?.[1] === undefined) {
      break;
    }
    items.push(match[1].trim());
  }
  return items;
}

function detectMonorepo(
  dir: string,
  packageJson: Record<string, unknown> | undefined,
  undetermined: string[],
): { tool: MonorepoTool; globs: string[] } {
  const pnpmWorkspacePath = join(dir, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspacePath)) {
    const content = guardedRead(
      pnpmWorkspacePath,
      () => readFileSync(pnpmWorkspacePath, "utf8"),
      undetermined,
    );
    return {
      tool: "pnpm-workspaces",
      globs:
        content === undefined
          ? []
          : extractYamlStringListUnder(content, "packages"),
    };
  }
  if (existsSync(join(dir, "turbo.json"))) {
    return { tool: "turbo", globs: [] };
  }
  if (existsSync(join(dir, "nx.json"))) {
    return { tool: "nx", globs: [] };
  }
  if (existsSync(join(dir, "lerna.json"))) {
    return { tool: "lerna", globs: [] };
  }
  const workspaces = packageJson?.["workspaces"];
  if (Array.isArray(workspaces)) {
    return {
      tool: "npm-workspaces",
      globs: workspaces.filter((w) => typeof w === "string"),
    };
  }
  return { tool: "none", globs: [] };
}

function detectModuleType(
  packageJson: Record<string, unknown> | undefined,
): ModuleType {
  const type = packageJson?.["type"];
  if (type === "module") return "module";
  if (type === "commonjs") return "commonjs";
  return "unspecified";
}

function detectTypescriptVersion(
  packageJson: Record<string, unknown> | undefined,
): string | undefined {
  const deps = packageJson?.["dependencies"];
  const devDeps = packageJson?.["devDependencies"];
  const fromDeps =
    typeof deps === "object" && deps !== null
      ? (deps as Record<string, unknown>)["typescript"]
      : undefined;
  const fromDevDeps =
    typeof devDeps === "object" && devDeps !== null
      ? (devDeps as Record<string, unknown>)["typescript"]
      : undefined;
  const value = fromDevDeps ?? fromDeps;
  return typeof value === "string" ? value : undefined;
}

function detectNodeVersionPin(
  dir: string,
  packageJson: Record<string, unknown> | undefined,
  undetermined: string[],
): NodeVersionPin | undefined {
  for (const [source, filename] of [
    [".node-version", ".node-version"],
    [".nvmrc", ".nvmrc"],
  ] as const) {
    const path = join(dir, filename);
    if (!existsSync(path)) continue;
    // An unreadable pin file falls through to the next source.
    const content = guardedRead(
      path,
      () => readFileSync(path, "utf8"),
      undetermined,
    );
    if (content !== undefined) return { source, value: content.trim() };
  }
  const engines = packageJson?.["engines"];
  const nodeEngine =
    typeof engines === "object" && engines !== null
      ? (engines as Record<string, unknown>)["node"]
      : undefined;
  if (typeof nodeEngine === "string") {
    return { source: "package.json#engines.node", value: nodeEngine };
  }
  return undefined;
}

function detectSourceLayout(dir: string, undetermined: string[]): SourceLayout {
  if (existsSync(join(dir, "src"))) return "src";
  if (existsSync(join(dir, "lib"))) return "lib";
  const names = guardedRead(dir, () => readdirSync(dir), undetermined) ?? [];
  const rootEntries = names.filter((name) => /\.(ts|tsx|js|mjs)$/.test(name));
  if (rootEntries.length > 0) return "root";
  return "unknown";
}

function hasColocatedTests(dir: string, undetermined: string[]): boolean {
  return walkBounded(dir, 2, undetermined).some(
    (entry) =>
      !entry.isDirectory && /\.(test|spec)\.[jt]sx?$/.test(entry.relPath),
  );
}

function detectTestPlacement(
  dir: string,
  undetermined: string[],
): TestPlacement {
  if (existsSync(join(dir, "tests")) || existsSync(join(dir, "test"))) {
    return "tests-dir";
  }
  if (hasColocatedTests(dir, undetermined)) {
    return "colocated";
  }
  return "unknown";
}

function collectKindEvidence(
  packageJson: Record<string, unknown> | undefined,
): KindEvidence {
  const deps = packageJson?.["dependencies"];
  const devDeps = packageJson?.["devDependencies"];
  const allDepNames = new Set([
    ...(typeof deps === "object" && deps !== null ? Object.keys(deps) : []),
    ...(typeof devDeps === "object" && devDeps !== null
      ? Object.keys(devDeps)
      : []),
  ]);

  return {
    hasExportsMap: packageJson?.["exports"] !== undefined,
    hasBinField: packageJson?.["bin"] !== undefined,
    hasMainField: packageJson?.["main"] !== undefined,
    frameworkDeps: FRAMEWORK_DEP_NAMES.filter((name) => allDepNames.has(name)),
  };
}

/**
 * Surveys codebase shape at `dir`. Offline, read-only, records evidence
 * rather than verdicts. Appends anything it could not parse (a malformed
 * `package.json`) or could not read (`EACCES`/`EPERM`) to `undetermined`;
 * an absent file is not recorded. Any other read failure throws, naming the
 * path, with the original failure as `cause`.
 *
 * @example
 * ```ts
 * import { surveyShape } from "./survey-shape.js";
 *
 * const undetermined: string[] = [];
 * const shape = surveyShape("/path/to/project", undetermined);
 * console.log(shape.packageManager, undetermined);
 * ```
 */
export function surveyShape(dir: string, undetermined: string[]): ShapeSurvey {
  const packageJson = readPackageJson(dir, undetermined);
  const monorepo = detectMonorepo(dir, packageJson, undetermined);

  return {
    packageManager: detectPackageManager(dir),
    monorepoTool: monorepo.tool,
    workspaceGlobs: monorepo.globs,
    moduleType: detectModuleType(packageJson),
    typescriptVersion: detectTypescriptVersion(packageJson),
    nodeVersionPin: detectNodeVersionPin(dir, packageJson, undetermined),
    sourceLayout: detectSourceLayout(dir, undetermined),
    testPlacement: detectTestPlacement(dir, undetermined),
    kindEvidence: collectKindEvidence(packageJson),
  };
}
