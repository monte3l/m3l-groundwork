/**
 * Shared type definitions for the four survey collectors and their
 * aggregate. Kept in one file since every collector's output composes into
 * `ProjectSurvey`, and `conflicts.ts`/`report.ts` need to name these shapes
 * without importing a collector module just for its types.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type MonorepoTool =
  "pnpm-workspaces" | "turbo" | "nx" | "lerna" | "npm-workspaces" | "none";

export type ModuleType = "module" | "commonjs" | "unspecified";

export type SourceLayout = "src" | "lib" | "root" | "unknown";

export type TestPlacement = "tests-dir" | "colocated" | "unknown";

export interface NodeVersionPin {
  source: string;
  value: string;
}

export interface KindEvidence {
  hasExportsMap: boolean;
  hasBinField: boolean;
  hasMainField: boolean;
  frameworkDeps: string[];
}

export interface ShapeSurvey {
  packageManager: PackageManager;
  monorepoTool: MonorepoTool;
  workspaceGlobs: string[];
  moduleType: ModuleType;
  typescriptVersion: string | undefined;
  nodeVersionPin: NodeVersionPin | undefined;
  sourceLayout: SourceLayout;
  testPlacement: TestPlacement;
  kindEvidence: KindEvidence;
}

export interface TsconfigSurvey {
  /** The extends chain, root file first, as resolved paths relative to the project dir. */
  files: string[];
  /** The effective value of each strict-family flag this baseline cares about, after following `extends`. */
  effectiveFlags: Record<string, unknown>;
  /** False if any file in the chain failed to parse -- see `undetermined` on the parent survey. */
  parsed: boolean;
}

export interface EslintSurvey {
  configFile: string | undefined;
  flat: boolean;
  referencedPlugins: string[];
}

type TestRunnerTool = "vitest" | "jest" | "mocha" | "node-test" | "unknown";

export interface TestRunnerSurvey {
  tool: TestRunnerTool;
  configFile: string | undefined;
}

type FormatterTool = "prettier" | "biome" | "unknown";

export interface FormatterSurvey {
  tool: FormatterTool;
  configFile: string | undefined;
}

type GitHookManager = "lefthook" | "husky" | "simple-git-hooks" | "none";

export interface GitHooksSurvey {
  manager: GitHookManager;
  configFile: string | undefined;
  /** True whenever the manager's config is YAML/shell-script shaped -- this module indexes it, never parses it. */
  needsReading: boolean;
}

export interface WorkflowsSurvey {
  files: string[];
  needsReading: boolean;
}

export interface ToolchainSurvey {
  tsconfig: TsconfigSurvey;
  eslint: EslintSurvey;
  testRunner: TestRunnerSurvey;
  formatter: FormatterSurvey;
  gitHooks: GitHooksSurvey;
  workflows: WorkflowsSurvey;
  scripts: Record<string, string>;
}

export interface HarnessAgent {
  name: string;
  model: string | undefined;
}

export interface HarnessSkill {
  name: string;
  description: string | undefined;
}

export interface HarnessRule {
  name: string;
  paths: string | undefined;
}

export interface HarnessSurvey {
  present: boolean;
  settingsFile: string | undefined;
  agents: HarnessAgent[];
  skills: HarnessSkill[];
  hooks: string[];
  rules: HarnessRule[];
  commands: string[];
  hasSettingsLocal: boolean;
  hasClaudeMd: boolean;
  claudeMdHeadings: string[];
}

export interface DocFile {
  path: string;
  sizeBytes: number;
  headings: string[];
}

export interface DocsSurvey {
  files: DocFile[];
}

export interface ProjectSurvey {
  shape: ShapeSurvey;
  toolchain: ToolchainSurvey;
  harness: HarnessSurvey;
  docs: DocsSurvey;
  /** Things the survey attempted and could not parse or classify -- never silently dropped. */
  undetermined: string[];
}
