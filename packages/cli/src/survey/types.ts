/**
 * Shared type definitions for the four survey collectors and their
 * aggregate. Kept in one file since every collector's output composes into
 * `ProjectSurvey`, and `conflicts.ts`/`report.ts` need to name these shapes
 * without importing a collector module just for its types.
 */

/** The package manager, inferred from which lockfile is present -- `unknown` when none is. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

/** The monorepo tooling, inferred from its marker file (or `package.json`'s `workspaces`) -- `none` when nothing is found. */
export type MonorepoTool =
  "pnpm-workspaces" | "turbo" | "nx" | "lerna" | "npm-workspaces" | "none";

/** `package.json`'s `type` field as declared -- `unspecified` when it is absent or not one of the two known values. */
export type ModuleType = "module" | "commonjs" | "unspecified";

/** Where source lives: a `src/` or `lib/` directory, loose source files at the root, or `unknown`. */
export type SourceLayout = "src" | "lib" | "root" | "unknown";

/** Where tests live: a `tests/`/`test/` directory, `*.test`/`*.spec` files next to the source, or `unknown`. */
export type TestPlacement = "tests-dir" | "colocated" | "unknown";

/** A Node.js version pin, and the file or field it was read from. */
export interface NodeVersionPin {
  /** Where the pin was found: `.node-version`, `.nvmrc`, or `package.json#engines.node`. */
  source: string;
  /** The pin's value verbatim (trimmed), never normalized to a semver range. */
  value: string;
}

/** Raw `package.json` facts that hint at what kind of project this is -- evidence only, never the verdict. */
export interface KindEvidence {
  /** Whether `package.json` declares an `exports` field. */
  hasExportsMap: boolean;
  /** Whether `package.json` declares a `bin` field. */
  hasBinField: boolean;
  /** Whether `package.json` declares a `main` field. */
  hasMainField: boolean;
  /** Well-known framework packages found among `dependencies`/`devDependencies`. */
  frameworkDeps: string[];
}

/** Codebase-shape facts: package manager, monorepo tooling, module system, pins, and layout. */
export interface ShapeSurvey {
  /** The package manager, from which lockfile is present. */
  packageManager: PackageManager;
  /** The monorepo tool, from its marker file or `package.json`'s `workspaces`. */
  monorepoTool: MonorepoTool;
  /** The workspace package globs the monorepo tool declares -- empty when it declares none or none were read. */
  workspaceGlobs: string[];
  /** `package.json`'s declared module system. */
  moduleType: ModuleType;
  /** The `typescript` version range from `devDependencies` (preferred) or `dependencies`, verbatim. */
  typescriptVersion: string | undefined;
  /** The first Node.js version pin found, or `undefined` when there is none. */
  nodeVersionPin: NodeVersionPin | undefined;
  /** Where the project's source files live. */
  sourceLayout: SourceLayout;
  /** Where the project's test files live. */
  testPlacement: TestPlacement;
  /** Evidence for what kind of project this is, left for `/customize` to interpret. */
  kindEvidence: KindEvidence;
}

/** The project's tsconfig `extends` chain and the strict-family flags it resolves to. */
export interface TsconfigSurvey {
  /** The extends chain, entry file first (child before parent), as absolute paths. */
  files: string[];
  /** The effective value of each strict-family flag this baseline cares about, after following `extends`. */
  effectiveFlags: Record<string, unknown>;
  /** False if any file in the chain failed to parse -- see `undetermined` on the parent survey. */
  parsed: boolean;
}

/** The project's ESLint config file and what it references. */
export interface EslintSurvey {
  /** The config file found at the project root, or `undefined` when there is none. */
  configFile: string | undefined;
  /** True for a flat config (`eslint.config.*`); false for a legacy `.eslintrc*` one or when there is no config. */
  flat: boolean;
  /** Plugin names found in the config's source text -- scraped, never by executing it. */
  referencedPlugins: string[];
}

type TestRunnerTool = "vitest" | "jest" | "mocha" | "node-test" | "unknown";

/** The project's test runner, from its config file or `test` script. */
export interface TestRunnerSurvey {
  /** The runner detected -- `unknown` when neither a config file nor the `test` script names one. */
  tool: TestRunnerTool;
  /** The runner's config file, or `undefined` when none was found. */
  configFile: string | undefined;
}

type FormatterTool = "prettier" | "biome" | "unknown";

/** The project's code formatter, from its config file. */
export interface FormatterSurvey {
  /** The formatter detected -- `unknown` when no known config file is present. */
  tool: FormatterTool;
  /** The formatter's config file, or `undefined` when none was found. */
  configFile: string | undefined;
}

type GitHookManager = "lefthook" | "husky" | "simple-git-hooks" | "none";

/** The project's git-hook manager and where its config lives. */
export interface GitHooksSurvey {
  /** The hook manager detected from its config file or directory -- `none` when none is found. */
  manager: GitHookManager;
  /** The manager's config file or directory, or `undefined` when there is no manager. */
  configFile: string | undefined;
  /** True whenever the manager's config is YAML/shell-script shaped -- this module indexes it, never parses it. */
  needsReading: boolean;
}

/** The project's CI workflow files under `.github/workflows/`. */
export interface WorkflowsSurvey {
  /** Workflow file names (`.yml`/`.yaml`), relative to `.github/workflows/`. */
  files: string[];
  /** True whenever any workflow file exists -- YAML is indexed, never parsed, so its steps need reading. */
  needsReading: boolean;
}

/** Every toolchain enforcement mechanism the survey found in effect. */
export interface ToolchainSurvey {
  /** The tsconfig `extends` chain and its effective strict-family flags. */
  tsconfig: TsconfigSurvey;
  /** The ESLint config, if any. */
  eslint: EslintSurvey;
  /** The test runner, if one was detected. */
  testRunner: TestRunnerSurvey;
  /** The code formatter, if one was detected. */
  formatter: FormatterSurvey;
  /** The git-hook manager, if one was detected. */
  gitHooks: GitHooksSurvey;
  /** The CI workflow files, if any. */
  workflows: WorkflowsSurvey;
  /** `package.json`'s `scripts`, name to command, verbatim (string values only). */
  scripts: Record<string, string>;
}

/** One agent file under `.claude/agents/`. */
export interface HarnessAgent {
  /** The agent's file name without its `.md` extension. */
  name: string;
  /** The agent's frontmatter `model` field, or `undefined` when absent or empty. */
  model: string | undefined;
}

/** One skill directory under `.claude/skills/` that has a `SKILL.md`. */
export interface HarnessSkill {
  /** The skill's frontmatter `name`, falling back to its directory name. */
  name: string;
  /** The skill's frontmatter `description`, or `undefined` when absent or empty. */
  description: string | undefined;
}

/** One rule file under `.claude/rules/` -- the survey's index entry, unrelated to the harness grader's rule type. */
export interface HarnessRule {
  /** The rule's file name without its `.md` extension. */
  name: string;
  /** The rule's frontmatter `paths` scope as text (a list joined with commas), or `undefined` when absent or empty. */
  paths: string | undefined;
}

/** The project's existing Claude Code harness: its `.claude/` directory plus `CLAUDE.md`. */
export interface HarnessSurvey {
  /** Whether a `.claude/` directory exists at all. */
  present: boolean;
  /** `settings.json` when `.claude/settings.json` exists, otherwise `undefined`. */
  settingsFile: string | undefined;
  /** Every agent found under `.claude/agents/`. */
  agents: HarnessAgent[];
  /** Every skill found under `.claude/skills/`. */
  skills: HarnessSkill[];
  /** Hook script file names (`.mjs`/`.js`) under `.claude/hooks/`. */
  hooks: string[];
  /** Every rule file found under `.claude/rules/`. */
  rules: HarnessRule[];
  /** Command file names (`.md`) under `.claude/commands/`. */
  commands: string[];
  /** Whether a `.claude/settings.local.json` exists, which may shadow shared settings. */
  hasSettingsLocal: boolean;
  /** Whether a root `CLAUDE.md` exists -- recorded even when `.claude/` does not. */
  hasClaudeMd: boolean;
  /** `CLAUDE.md`'s level 1-3 headings in document order -- empty when there is no `CLAUDE.md`. */
  claudeMdHeadings: string[];
}

/** One indexed human-facing doc: where it is and its outline, never its content. */
export interface DocFile {
  /** The doc's path on disk. */
  path: string;
  /** The doc's size on disk, in bytes. */
  sizeBytes: number;
  /** The doc's level 1-3 Markdown headings in document order. */
  headings: string[];
}

/** The index of human-facing docs and guidelines the survey found. */
export interface DocsSurvey {
  /** Every indexed doc: root README/CONTRIBUTING/style guides, then named doc directories. */
  files: DocFile[];
}

/** The aggregate output of all four survey collectors -- adopt mode's offline index of the project. */
export interface ProjectSurvey {
  /** Codebase-shape facts. */
  shape: ShapeSurvey;
  /** Toolchain enforcement in effect. */
  toolchain: ToolchainSurvey;
  /** The existing Claude Code harness. */
  harness: HarnessSurvey;
  /** The human-facing docs index. */
  docs: DocsSurvey;
  /** Things the survey attempted and could not parse or classify -- never silently dropped. */
  undetermined: string[];
}
