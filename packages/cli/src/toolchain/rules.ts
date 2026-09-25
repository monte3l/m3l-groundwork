// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The toolchain grader's rules. Each rule is a pure function over a
 * `ToolchainSnapshot` read once by `grade.ts`, so none of them touches the
 * filesystem. Rules come in two levels.
 *
 * Structural rules are pass/fail wiring checks: they catch defects `tsc` and
 * ESLint do not -- a build project that emits nowhere, a verify step naming a
 * script that does not exist -- and fail a gate.
 *
 * Rubric rules are a quality-judgement checklist rather than a wiring check:
 * each scores how closely the project follows a recommended practice, and a
 * miss only ever warns. What they encode is the floor -- the minimum baseline
 * of practice that current official TypeScript / typescript-eslint guidance
 * recommends (strict-family flags on, a modern module target, type-aware
 * linting, and so on). A project can go beyond the floor; falling below it is
 * what a rubric rule reports.
 *
 * `eslint.config.js`, `vitest.config.ts` and `verify-steps.mjs` are executable
 * JavaScript, so their rules are regex scrapes over comment-stripped source,
 * never evaluation. A scrape that finds the file but cannot tell the answer
 * returns `{ checked: 0 }` rather than a failure: absence, or a shape this
 * module cannot read, is never a defect.
 *
 * `templates/core/bin/lib/toolchain-rules.mjs` carries the same rules for the
 * emitted gate; `tests/toolchain/toolchain-parity.test.ts` runs both over the
 * real baseline and asserts identical findings. Change a rule in one, change
 * the other in the same commit.
 */
import type { RuleLevel } from "../harness/types.js";
import type { ChainLink, TsconfigChain } from "./tsconfig-chain.js";
import type { ToolchainCategory } from "./types.js";

/** A tsconfig file the project itself owns (a `node_modules` base is not graded as ours). */
export interface OwnTsconfigFile {
  rel: string;
  error: string | undefined;
  options: Record<string, unknown>;
}

export interface GateStep {
  id: string;
  group: string | undefined;
  cmd: string[];
}

/** The `verify.mjs` invocations one YAML surface (lefthook, CI workflows) makes, scraped as data. */
export interface LaneSurface {
  surface: string;
  groups: string[];
  steps: string[];
  /** An invocation named no static group or step (a matrix, or a bare full run). */
  dynamic: boolean;
}

export interface ToolchainSnapshot {
  /** Parsed `package.json`, or `undefined` when absent or unparseable. */
  packageJson: Record<string, unknown> | undefined;
  /** `package.json` `scripts`, string values only. */
  scripts: Record<string, string>;
  /** Trimmed `.node-version`, or `undefined` when absent. */
  nodeVersion: string | undefined;
  tsconfigFiles: Map<string, OwnTsconfigFile>;
  tsconfigLinks: ChainLink[];
  /** One chain per root-level `tsconfig*.json`. */
  chains: TsconfigChain[];
  eslint: {
    flatFile: string | undefined;
    /** Comment-stripped source. Rules regex-scrape it; nothing evaluates it. */
    source: string | undefined;
    legacy: string[];
  };
  vitest: { file: string | undefined; source: string | undefined };
  gates: {
    stepsFile: string | undefined;
    groups: string[];
    steps: GateStep[];
    packs: { path: string; error: string | undefined } | undefined;
  };
  /** Surfaces that run `verify.mjs`; one that never does is absent, not failed. */
  lanes: LaneSurface[];
  /** Every project file (bounded walk), project-relative. */
  projectFiles: Set<string>;
}

interface RuleFailure {
  subject: string;
  message: string;
}

interface RuleResult {
  /** How many subjects the rule examined -- the denominator of the rubric score. */
  checked: number;
  failures: RuleFailure[];
}

export interface ToolchainRule {
  id: string;
  level: RuleLevel;
  category: ToolchainCategory;
  check: (snapshot: ToolchainSnapshot) => RuleResult;
}

const NONE: RuleResult = { checked: 0, failures: [] };

interface LegacyOption {
  option: string;
  label: string;
  deprecatedIn: number;
  removedIn: number;
  matches: (value: unknown) => boolean;
}

const lower = (value: unknown): string | undefined =>
  typeof value === "string" ? value.toLowerCase() : undefined;

/**
 * Options TypeScript 6.0 deprecated. `removedIn` is the major that drops them
 * (`outFile` and `moduleResolution: classic` already went in 6.0).
 * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
 */
export const LEGACY_OPTIONS: readonly LegacyOption[] = [
  {
    option: "baseUrl",
    label: "baseUrl",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => value !== undefined,
  },
  {
    option: "outFile",
    label: "outFile",
    deprecatedIn: 6,
    removedIn: 6,
    matches: (value) => value !== undefined,
  },
  {
    option: "moduleResolution",
    label: "moduleResolution: node",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => ["node", "node10"].includes(lower(value) ?? ""),
  },
  {
    option: "moduleResolution",
    label: "moduleResolution: classic",
    deprecatedIn: 6,
    removedIn: 6,
    matches: (value) => lower(value) === "classic",
  },
  {
    option: "target",
    label: "target: es5",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => lower(value) === "es5",
  },
  {
    option: "downlevelIteration",
    label: "downlevelIteration",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => value === true,
  },
  {
    option: "module",
    label: "module: amd|umd|system|none",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) =>
      ["amd", "umd", "system", "systemjs", "none"].includes(lower(value) ?? ""),
  },
  {
    option: "esModuleInterop",
    label: "esModuleInterop: false",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => value === false,
  },
  {
    option: "allowSyntheticDefaultImports",
    label: "allowSyntheticDefaultImports: false",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => value === false,
  },
  {
    option: "alwaysStrict",
    label: "alwaysStrict: false",
    deprecatedIn: 6,
    removedIn: 7,
    matches: (value) => value === false,
  },
];

/**
 * The strict-family flags the baseline enables, plus `skipLibCheck`. Three
 * omissions are deliberate and must not be "completed": `isolatedDeclarations`
 * (the build project sets it alone; the tooling project includes tests/, which
 * it does not tolerate), `noUnusedLocals`/`noUnusedParameters`
 * (`@typescript-eslint/no-unused-vars` covers both with an `^_` escape hatch
 * tsc's flags lack), and `forceConsistentCasingInFileNames` (defaults on).
 * `allowUnreachableCode` is graded separately -- it must be `false`.
 */
export const STRICT_FLAGS: readonly string[] = [
  "strict",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "exactOptionalPropertyTypes",
  "verbatimModuleSyntax",
  "isolatedModules",
  "noFallthroughCasesInSwitch",
  "noImplicitReturns",
  "noPropertyAccessFromIndexSignature",
  "noUncheckedSideEffectImports",
  "skipLibCheck",
];

const MODERN_MODULES = new Set([
  "nodenext",
  "node16",
  "node18",
  "node20",
  "preserve",
]);
const MODERN_RESOLUTIONS = new Set(["nodenext", "node16", "bundler"]);
const MIN_TARGET_YEAR = 2022;
const PIN_PACKAGES = [
  "typescript",
  "eslint",
  "typescript-eslint",
  "@types/node",
];
const PNPM_BUILTINS = new Set([
  "exec",
  "dlx",
  "install",
  "i",
  "add",
  "remove",
  "update",
  "audit",
  "pack",
  "publish",
  "store",
  "config",
  "env",
  "create",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// --- helpers shared by rules -----------------------------------------------

/** The first number in a range: `^6.0.3` gives 6. `undefined` when there is none (`workspace:*`, `catalog:`). */
function majorOf(spec: string | undefined): number | undefined {
  const match = /(\d+)/.exec(spec ?? "");
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function depSpec(
  snapshot: ToolchainSnapshot,
  name: string,
): string | undefined {
  const pkg = snapshot.packageJson;
  if (pkg === undefined) return undefined;
  for (const key of ["devDependencies", "dependencies"]) {
    const section = pkg[key];
    if (isRecord(section)) {
      const spec = section[name];
      if (typeof spec === "string") return spec;
    }
  }
  return undefined;
}

const isUnpinned = (spec: string): boolean =>
  /^\s*(\*|x|latest|next)?\s*$/i.test(spec);

/**
 * The chain a project's strict-flag judgement is made over: `tsconfig.json`,
 * else the first chain no other chain extends (a leaf, not a base), else the
 * first.
 */
function primaryChain(snapshot: ToolchainSnapshot): TsconfigChain | undefined {
  const named = snapshot.chains.find(
    (chain) => chain.entry === "tsconfig.json",
  );
  if (named !== undefined) return named;
  const leaf = snapshot.chains.find(
    (chain) =>
      !snapshot.chains.some(
        (other) =>
          other !== chain && other.files.some((f) => f.rel === chain.entry),
      ),
  );
  return leaf ?? snapshot.chains[0];
}

function ownFiles(snapshot: ToolchainSnapshot): OwnTsconfigFile[] {
  return [...snapshot.tsconfigFiles.values()].filter(
    (file) => file.error === undefined,
  );
}

/** The first year an ES target denotes; `Infinity` for `esnext`; `undefined` when unrecognised. */
function targetYear(target: unknown): number | undefined {
  const value = lower(target);
  if (value === "esnext") return Infinity;
  const match = /^es(\d+)$/.exec(value ?? "");
  if (match?.[1] === undefined) return undefined;
  const n = Number(match[1]);
  return n < 100 ? n + 2009 : n;
}

/** The `.json` file a `tsc -b|-p <file>` script names, if it names one. */
function scriptTsconfig(script: string | undefined): string | undefined {
  if (script === undefined) return undefined;
  const match =
    /\btsc\b[^&|;\n]*?\s(?:-b|--build|-p|--project)\s+(?:--\S+\s+)*([^\s&|;]+\.json)/.exec(
      script,
    );
  return match?.[1]?.replace(/^\.\//, "");
}

/** Confirms every CI/lefthook lane invokes verify.mjs by static group name, not by step id or a dynamic matrix -- otherwise a new gate can silently go unenforced in one surface while it passes in another. */
const gateLaneParity: ToolchainRule = {
  id: "gate-lane-parity",
  level: "structural",
  category: "gates",
  check: (s) => {
    const { groups } = s.gates;
    if (groups.length === 0) return NONE;
    const failures: RuleFailure[] = [];
    let checked = 0;
    for (const lane of s.lanes) {
      // A lane that runs verify.mjs with no static group (a matrix, or a bare
      // full run) cannot be judged by reading it.
      if (lane.dynamic) continue;
      for (const group of groups) {
        checked += 1;
        if (!lane.groups.includes(group)) {
          failures.push({
            subject: lane.surface,
            message: `has no \`verify.mjs --group ${group}\` invocation, so that group's steps are never gated here`,
          });
        }
      }
      for (const named of new Set(lane.groups)) {
        if (groups.includes(named)) continue;
        checked += 1;
        failures.push({
          subject: lane.surface,
          message: `runs \`verify.mjs --group ${named}\`, but ${named} is not in GROUPS (${groups.join(", ")})`,
        });
      }
      for (const step of new Set(lane.steps)) {
        checked += 1;
        failures.push({
          subject: lane.surface,
          message: `runs \`verify.mjs --step ${step}\` by id; name a group instead so a new step joins this lane without editing it`,
        });
      }
    }
    return { checked, failures };
  },
};

/** The lower and upper major an `engines.node` range implies; `undefined` for `||` ranges. */
function enginesBounds(
  range: string,
): { min: number | undefined; max: number | undefined } | undefined {
  if (range.includes("||")) return undefined;
  const low = /(?:^|\s)(?:>=|\^|~|=)?\s*v?(\d+)/.exec(range);
  const high = /<\s*(\d+)/.exec(range);
  return {
    min: low?.[1] === undefined ? undefined : Number(low[1]),
    max: high?.[1] === undefined ? undefined : Number(high[1]),
  };
}

// --- structural rules ------------------------------------------------------

/** A tsconfig that fails to parse breaks every rule that reads its chain -- reporting the parse error itself, first, keeps a later rule's silence from being mistaken for a clean file. */
const tsconfigParses: ToolchainRule = {
  id: "tsconfig-parses",
  level: "structural",
  category: "tsconfig",
  check: (s) => ({
    checked: s.tsconfigFiles.size,
    failures: [...s.tsconfigFiles.values()]
      .filter((file) => file.error !== undefined)
      .map((file) => ({
        subject: file.rel,
        message: `does not parse as JSONC: ${file.error ?? ""}`,
      })),
  }),
};

/** An `extends` specifier that resolves to no file silently drops every option the base file would have set -- tsc itself gives no error until something downstream trips on the missing option. */
const tsconfigExtendsResolves: ToolchainRule = {
  id: "tsconfig-extends-resolves",
  level: "structural",
  category: "tsconfig",
  check: (s) => {
    // A bare specifier that resolves nowhere is not a failure: before
    // `pnpm install` there is no node_modules to look in.
    const judged = s.tsconfigLinks.filter(
      (link) => link.kind === "relative" || link.resolved,
    );
    return {
      checked: judged.length,
      failures: judged
        .filter((link) => !link.resolved)
        .map((link) => ({
          subject: link.from,
          message: `extends "${link.specifier}", which resolves to no file`,
        })),
    };
  },
};

/** The tsconfig `build` compiles must actually set an outDir (or `build` emits .js next to sources) and must not set noEmit -- and if a separate tooling tsconfig sits beside it, that one must set noEmit, or typecheck starts emitting too. */
const tsconfigEmitCoherence: ToolchainRule = {
  id: "tsconfig-emit-coherence",
  level: "structural",
  category: "tsconfig",
  check: (s) => {
    const buildName = scriptTsconfig(s.scripts["build"]);
    const build = s.chains.find((chain) => chain.entry === buildName);
    if (build === undefined || !build.complete) return NONE;
    const failures: RuleFailure[] = [];
    let checked = 2;
    if (build.options["outDir"] === undefined) {
      failures.push({
        subject: build.entry,
        message:
          "is compiled by the `build` script but sets no outDir, so tsc emits .js next to the sources",
      });
    }
    if (build.options["noEmit"] === true) {
      failures.push({
        subject: build.entry,
        message:
          "is compiled by the `build` script but sets noEmit: true, so `build` emits nothing",
      });
    }
    const tooling = s.chains.find((chain) => chain.entry === "tsconfig.json");
    if (tooling !== undefined && tooling.complete && tooling !== build) {
      checked += 1;
      if (tooling.options["noEmit"] !== true) {
        failures.push({
          subject: tooling.entry,
          message: `sits beside ${build.entry} as the tooling project but does not set noEmit: true, so typecheck would emit`,
        });
      }
    }
    return { checked, failures };
  },
};

/** A verify step naming a package.json script, a file, or a group that doesn't exist is a wiring defect no offline check other than this one would catch before someone actually runs it. */
const gateWiring: ToolchainRule = {
  id: "gate-wiring",
  level: "structural",
  category: "gates",
  check: (s) => {
    const { stepsFile, groups, steps, packs } = s.gates;
    const failures: RuleFailure[] = [];
    let checked = 0;

    const scripts = s.packageJson === undefined ? undefined : s.scripts;
    for (const step of steps) {
      const [tool, first, second] = step.cmd;
      if (tool === "pnpm" && scripts !== undefined && first !== undefined) {
        const script = first === "run" ? second : first;
        if (script !== undefined && !PNPM_BUILTINS.has(script)) {
          checked += 1;
          if (scripts[script] === undefined) {
            failures.push({
              subject: `${stepsFile ?? ""} step "${step.id}"`,
              message: `runs \`pnpm ${script}\`, but package.json has no "${script}" script`,
            });
          }
        }
      }
      if (tool === "node" && first !== undefined && !first.startsWith("-")) {
        checked += 1;
        if (!s.projectFiles.has(first)) {
          failures.push({
            subject: `${stepsFile ?? ""} step "${step.id}"`,
            message: `runs \`node ${first}\`, which does not exist`,
          });
        }
      }
      if (groups.length > 0 && step.group !== undefined) {
        checked += 1;
        if (!groups.includes(step.group)) {
          failures.push({
            subject: `${stepsFile ?? ""} step "${step.id}"`,
            message: `names group "${step.group}", which is not in GROUPS (${groups.join(", ")})`,
          });
        }
      }
    }
    if (steps.length > 0) {
      for (const group of groups) {
        checked += 1;
        if (!steps.some((step) => step.group === group)) {
          failures.push({
            subject: `${stepsFile ?? ""} group "${group}"`,
            message:
              "has no step, so its lefthook lane and CI job gate nothing",
          });
        }
      }
    }
    if (packs !== undefined) {
      checked += 1;
      if (packs.error !== undefined) {
        failures.push({
          subject: packs.path,
          message: `does not parse as JSON: ${packs.error}`,
        });
      }
    }
    return { checked, failures };
  },
};

/** `.node-version` outside the range package.json's `engines.node` declares means the pinned dev/CI Node isn't even a Node version the project claims to support. */
const nodePinCoherence: ToolchainRule = {
  id: "node-pin-coherence",
  level: "structural",
  category: "gates",
  check: (s) => {
    const pkg = s.packageJson;
    const engines =
      pkg !== undefined && isRecord(pkg["engines"])
        ? pkg["engines"]["node"]
        : undefined;
    if (s.nodeVersion === undefined || typeof engines !== "string") return NONE;
    const pin = /^v?(\d+)/.exec(s.nodeVersion);
    const bounds = enginesBounds(engines);
    if (pin?.[1] === undefined || bounds === undefined) return NONE;
    const major = Number(pin[1]);
    const failures: RuleFailure[] = [];
    if (bounds.min !== undefined && major < bounds.min) {
      failures.push({
        subject: ".node-version",
        message: `pins Node ${major}, below the ${bounds.min} that package.json engines.node ("${engines}") requires`,
      });
    }
    if (bounds.max !== undefined && major >= bounds.max) {
      failures.push({
        subject: ".node-version",
        message: `pins Node ${major}, at or above the ${bounds.max} that package.json engines.node ("${engines}") excludes`,
      });
    }
    return { checked: 1, failures };
  },
};

// --- rubric rules ----------------------------------------------------------

/** The strict-family flags are the floor current TypeScript guidance recommends; tsc raises no warning for a flag simply left off, so this is the only check that notices. */
const strictFlags: ToolchainRule = {
  id: "strict-flags",
  level: "rubric",
  category: "tsconfig",
  check: (s) => {
    const chain = primaryChain(s);
    if (chain === undefined || !chain.complete) return NONE;
    const failures: RuleFailure[] = [];
    const expectValue = (flag: string, wanted: boolean): void => {
      const value = chain.options[flag];
      if (value === wanted) return;
      failures.push({
        subject: chain.entry,
        message:
          value === undefined
            ? `${flag} is not set (want ${wanted})`
            : `${flag} is ${JSON.stringify(value)} (want ${wanted})`,
      });
    };
    for (const flag of STRICT_FLAGS) expectValue(flag, true);
    expectValue("allowUnreachableCode", false);
    return { checked: STRICT_FLAGS.length + 1, failures };
  },
};

/** Warns ahead of a TypeScript major that removes an option outright -- by the time tsc itself rejects it, the fix is no longer a choice, it's an emergency. */
const tsconfigOptionLifecycle: ToolchainRule = {
  id: "tsconfig-option-lifecycle",
  level: "rubric",
  category: "tsconfig",
  check: (s) => {
    const major = majorOf(depSpec(s, "typescript"));
    const files = ownFiles(s);
    const failures: RuleFailure[] = [];
    for (const file of files) {
      const hits: string[] = [];
      if (major !== undefined) {
        for (const row of LEGACY_OPTIONS) {
          if (!row.matches(file.options[row.option])) continue;
          if (major >= row.removedIn) hits.push(`${row.label} (removed)`);
          else if (major >= row.deprecatedIn)
            hits.push(`${row.label} (deprecated)`);
          else if (major + 1 >= row.removedIn) {
            hits.push(`${row.label} (removed in TypeScript ${row.removedIn})`);
          }
        }
      }
      if (file.options["ignoreDeprecations"] !== undefined) {
        hits.push(
          "ignoreDeprecations (a migration aid, not a long-term setting)",
        );
      }
      if (hits.length > 0) {
        failures.push({
          subject: file.rel,
          message: `sets ${hits.join(", ")}`,
        });
      }
    }
    return { checked: files.length, failures };
  },
};

/** An outdated `module`/`moduleResolution`/`target` still compiles fine today, but forgoes current Node/bundler resolution semantics and syntax the project doesn't need to lower. */
const moduleTargetModern: ToolchainRule = {
  id: "module-target-modern",
  level: "rubric",
  category: "modules",
  check: (s) => {
    const chain = primaryChain(s);
    if (chain === undefined || !chain.complete) return NONE;
    const module = chain.options["module"];
    const moduleResolution = chain.options["moduleResolution"];
    const target = chain.options["target"];
    const failures: RuleFailure[] = [];
    let checked = 0;
    if (module !== undefined) {
      checked += 1;
      if (!MODERN_MODULES.has(lower(module) ?? "")) {
        failures.push({
          subject: chain.entry,
          message: `module is ${JSON.stringify(module)}; use nodenext (Node) or preserve (bundler)`,
        });
      }
    }
    if (moduleResolution !== undefined) {
      checked += 1;
      if (!MODERN_RESOLUTIONS.has(lower(moduleResolution) ?? "")) {
        failures.push({
          subject: chain.entry,
          message: `moduleResolution is ${JSON.stringify(moduleResolution)}; use nodenext or bundler`,
        });
      }
    }
    const year = targetYear(target);
    if (year !== undefined) {
      checked += 1;
      if (year < MIN_TARGET_YEAR) {
        failures.push({
          subject: chain.entry,
          message: `target is ${JSON.stringify(target)}; es2022 or later is the floor`,
        });
      }
    }
    return { checked, failures };
  },
};

/** ESLint 10 reads only eslint.config.* -- a lingering legacy eslintrc file means either an old ESLint is still in play, or a current one is silently linting nothing. */
const eslintFlatConfig: ToolchainRule = {
  id: "eslint-flat-config",
  level: "rubric",
  category: "eslint",
  check: (s) => {
    const { flatFile, legacy } = s.eslint;
    if (flatFile !== undefined) return { checked: 1, failures: [] };
    if (legacy.length === 0) return NONE;
    return {
      checked: 1,
      failures: legacy.map((name) => ({
        subject: name,
        message:
          "is a legacy eslintrc config; ESLint 10 reads only eslint.config.*",
      })),
    };
  },
};

/** Without a type-checked preset and `projectService`, typescript-eslint runs syntax-only rules and silently skips every rule that needs real type information. */
const eslintTypedLinting: ToolchainRule = {
  id: "eslint-typed-linting",
  level: "rubric",
  category: "eslint",
  check: (s) => {
    const { flatFile, source } = s.eslint;
    if (flatFile === undefined || source === undefined) return NONE;
    const direct =
      /\bfrom\s+["']typescript-eslint["']|require\(\s*["']typescript-eslint["']\s*\)/.test(
        source,
      );
    if (!direct) {
      // A preset composed through a shared config package cannot be judged
      // from this file alone -- say nothing rather than claim it is untyped.
      if (/["'](?:@[^/"']+\/)?eslint-config[^"']*["']/.test(source))
        return NONE;
      return {
        checked: 1,
        failures: [
          {
            subject: flatFile,
            message:
              "does not use typescript-eslint, so no TypeScript-aware rules run",
          },
        ],
      };
    }
    const failures: RuleFailure[] = [];
    if (!/\b(?:recommended|strict)TypeChecked\b/.test(source)) {
      failures.push({
        subject: flatFile,
        message:
          "uses typescript-eslint without a type-checked preset (recommendedTypeChecked or strictTypeChecked)",
      });
    }
    if (!/\bprojectService\s*:/.test(source)) {
      failures.push({
        subject: flatFile,
        message:
          "does not set parserOptions.projectService, so type-aware rules cannot read type information",
      });
    }
    return { checked: 2, failures };
  },
};

/** `bin/**` and `.claude/hooks/**` are code this project actually runs, not incidental scripts -- if ESLint has no config block for them, or actively ignores src, they ship unlinted. */
const eslintCoversEmittedCode: ToolchainRule = {
  id: "eslint-covers-emitted-code",
  level: "rubric",
  category: "eslint",
  check: (s) => {
    const { flatFile, source } = s.eslint;
    if (flatFile === undefined || source === undefined) return NONE;
    const failures: RuleFailure[] = [];
    let checked = 1;
    const ignored = [...source.matchAll(/\bignores\s*:\s*\[([\s\S]*?)\]/g)]
      .flatMap((block) => [...(block[1] ?? "").matchAll(/["']([^"']+)["']/g)])
      .map((literal) => literal[1] ?? "");
    for (const glob of ignored.filter((g) => /^(\*\*\/)?src(\/|$)/.test(g))) {
      failures.push({
        subject: flatFile,
        message: `ignores "${glob}", so the project's own source is never linted`,
      });
    }
    const files = [...s.projectFiles];
    const scopes: [string, RegExp, RegExp][] = [
      ["bin/", /\.(?:mjs|js)$/, /["']bin\/[^"']*["']/],
      [".claude/hooks/", /\.(?:mjs|js)$/, /["']\.claude\/hooks\/[^"']*["']/],
    ];
    for (const [prefix, extension, block] of scopes) {
      if (!files.some((p) => p.startsWith(prefix) && extension.test(p)))
        continue;
      checked += 1;
      if (!block.test(source)) {
        failures.push({
          subject: flatFile,
          message: `has no config block for ${prefix}**, whose scripts are code this project runs`,
        });
      }
    }
    return { checked, failures };
  },
};

/** A coverage threshold without `perFile: true` lets one well-tested file's coverage average out another file with none -- the gate passes while a whole file goes untested. */
const coverageGate: ToolchainRule = {
  id: "coverage-gate",
  level: "rubric",
  category: "testing",
  check: (s) => {
    const { file, source } = s.vitest;
    if (file === undefined || source === undefined) return NONE;
    const failures: RuleFailure[] = [];
    if (!/\bthresholds\s*:/.test(source)) {
      failures.push({
        subject: file,
        message:
          "sets no coverage thresholds, so coverage can fall without failing anything",
      });
    }
    if (!/\bperFile\s*:\s*true\b/.test(source)) {
      failures.push({
        subject: file,
        message:
          "does not set coverage.thresholds.perFile: true, so one well-covered file hides an untested one",
      });
    }
    return { checked: 2, failures };
  },
};

/** An unpinned toolchain package, a missing `packageManager`, or an `@types/node` major that doesn't match the pinned Node version each make installs non-reproducible across machines and CI runs. */
const toolchainPinShape: ToolchainRule = {
  id: "toolchain-pin-shape",
  level: "rubric",
  category: "deps",
  check: (s) => {
    const pkg = s.packageJson;
    if (pkg === undefined) return NONE;
    const failures: RuleFailure[] = [];
    let checked = 0;
    const packages = [...PIN_PACKAGES];
    if (s.vitest.file !== undefined || depSpec(s, "vitest") !== undefined) {
      packages.push("vitest");
    }
    for (const name of packages) {
      checked += 1;
      const spec = depSpec(s, name);
      if (spec === undefined) {
        failures.push({
          subject: name,
          message: "is not declared in package.json",
        });
      } else if (isUnpinned(spec)) {
        failures.push({
          subject: name,
          message: `is "${spec}", not a real version range, so installs are not reproducible`,
        });
      }
    }
    checked += 1;
    if (typeof pkg["packageManager"] !== "string") {
      failures.push({
        subject: "package.json",
        message:
          "declares no packageManager, so the package-manager version is unpinned",
      });
    }
    const types = majorOf(depSpec(s, "@types/node"));
    const pin = /^v?(\d+)/.exec(s.nodeVersion ?? "");
    if (types !== undefined && pin?.[1] !== undefined) {
      checked += 1;
      if (types !== Number(pin[1])) {
        failures.push({
          subject: "@types/node",
          message: `is major ${types}, but .node-version pins Node ${pin[1]}, so types describe a different runtime`,
        });
      }
    }
    return { checked, failures };
  },
};

/** Every rule, structural first. Order is the order findings are reported in. */
export const RULES: readonly ToolchainRule[] = [
  tsconfigParses,
  tsconfigExtendsResolves,
  tsconfigEmitCoherence,
  gateWiring,
  gateLaneParity,
  nodePinCoherence,
  strictFlags,
  tsconfigOptionLifecycle,
  moduleTargetModern,
  eslintFlatConfig,
  eslintTypedLinting,
  eslintCoversEmittedCode,
  coverageGate,
  toolchainPinShape,
];
