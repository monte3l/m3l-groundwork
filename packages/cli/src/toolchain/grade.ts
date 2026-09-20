/**
 * Grades a project's TypeScript toolchain. `gradeToolchain` reads the tsconfig
 * chains, ESLint and vitest configs, `package.json`, and the verify-step
 * wiring once into a `ToolchainSnapshot`, then runs every rule in `rules.ts`
 * over it. Offline and read-only -- it reads project files and never runs
 * them, so it is safe to point at an adopted project.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsoncFile, stripJsoncNoise } from "../jsonc.js";
import { walkBounded } from "../survey/fs-walk.js";
import { RULES } from "./rules.js";
import type {
  GateStep,
  LaneSurface,
  OwnTsconfigFile,
  ToolchainSnapshot,
} from "./rules.js";
import { loadTsconfigChain } from "./tsconfig-chain.js";
import type { ChainLink } from "./tsconfig-chain.js";
import { TOOLCHAIN_CATEGORIES } from "./types.js";
import type {
  ToolchainCategory,
  ToolchainFinding,
  ToolchainGrade,
} from "./types.js";
import type { CheckTally } from "../harness/types.js";

const PROJECT_WALK_DEPTH = 6;
const FLAT_ESLINT = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];
const LEGACY_ESLINT = /^\.eslintrc(\.(js|cjs|json|ya?ml))?$/;
const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
];
const STEPS_PATH = "bin/lib/verify-steps.mjs";
const PACKS_PATH = "bin/lib/verify-steps.packs.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** File text exactly as written, or `undefined` when unreadable. */
function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** File text with comments stripped, or `undefined` when unreadable. */
function readSource(path: string): string | undefined {
  try {
    return stripJsoncNoise(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads `verify-steps.mjs` as data: the `GROUPS` list and every `{ id, group, cmd }` literal. */
function scrapeGateSteps(text: string): {
  groups: string[];
  steps: GateStep[];
} {
  const groupList = /\bGROUPS\s*=\s*\[([^\]]*)\]/.exec(text);
  const groups =
    groupList === null
      ? []
      : [...(groupList[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  const steps: GateStep[] = [];
  for (const match of text.matchAll(
    /\bid:\s*"([^"]+)"([^{}]*?)\bcmd:\s*\[([^\]]*)\]/g,
  )) {
    const group = /\bgroup:\s*"([^"]+)"/.exec(match[2] ?? "");
    steps.push({
      id: match[1] ?? "",
      group: group?.[1],
      cmd: [...(match[3] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? ""),
    });
  }
  return { groups, steps };
}

/**
 * Reads every `verify.mjs` invocation out of one YAML surface as data: the
 * `--group`/`--step` each names. YAML is scraped, never parsed. An invocation
 * naming neither (a matrix, or a bare full run) marks the surface `dynamic`.
 */
function scrapeLaneInvocations(text: string): {
  seen: boolean;
  groups: string[];
  steps: string[];
  dynamic: boolean;
} {
  const groups: string[] = [];
  const steps: string[] = [];
  let dynamic = false;
  let seen = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    const at = line.indexOf("verify.mjs");
    if (at === -1) continue;
    seen = true;
    const rest = line.slice(at);
    const group = /--group[ =]+([A-Za-z][\w-]*)/.exec(rest);
    const step = /--step[ =]+([A-Za-z][\w-]*)/.exec(rest);
    if (group?.[1] !== undefined) groups.push(group[1]);
    else if (step?.[1] !== undefined) steps.push(step[1]);
    else dynamic = true;
  }
  return { seen, groups, steps, dynamic };
}

function loadSnapshot(root: string): ToolchainSnapshot {
  const entries = walkBounded(root, PROJECT_WALK_DEPTH);
  const projectFiles = new Set(
    entries.filter((e) => !e.isDirectory).map((e) => e.relPath),
  );
  const rootFiles = [...projectFiles].filter((p) => !p.includes("/"));

  const packageRead = readJsoncFile(join(root, "package.json"));
  const packageJson =
    packageRead.ok && isRecord(packageRead.value)
      ? packageRead.value
      : undefined;
  const scripts: Record<string, string> = {};
  const rawScripts = packageJson?.["scripts"];
  if (isRecord(rawScripts)) {
    for (const [name, cmd] of Object.entries(rawScripts)) {
      if (typeof cmd === "string") scripts[name] = cmd;
    }
  }

  const tsconfigFiles = new Map<string, OwnTsconfigFile>();
  const tsconfigLinks: ChainLink[] = [];
  const chains = rootFiles
    .filter((name) => /^tsconfig(\..+)?\.json$/.test(name))
    .sort()
    .map((name) => loadTsconfigChain(root, name));
  for (const chain of chains) {
    for (const file of chain.files) {
      // A node_modules base is read for its options, never graded as ours.
      if (file.rel.startsWith("node_modules/") || file.rel.startsWith("..")) {
        continue;
      }
      if (!tsconfigFiles.has(file.rel)) {
        tsconfigFiles.set(file.rel, {
          rel: file.rel,
          error: file.error,
          options: file.options,
        });
      }
    }
    for (const link of chain.links) {
      if (
        !tsconfigLinks.some(
          (l) => l.from === link.from && l.specifier === link.specifier,
        )
      ) {
        tsconfigLinks.push(link);
      }
    }
  }

  const flatFile = FLAT_ESLINT.find((name) => projectFiles.has(name));
  const vitestFile = VITEST_CONFIGS.find((name) => projectFiles.has(name));
  const stepsText = projectFiles.has(STEPS_PATH)
    ? readSource(join(root, STEPS_PATH))
    : undefined;
  const packsRead = projectFiles.has(PACKS_PATH)
    ? readJsoncFile(join(root, PACKS_PATH))
    : undefined;
  const nodeVersionText = projectFiles.has(".node-version")
    ? readSource(join(root, ".node-version"))
    : undefined;

  const lanes: LaneSurface[] = [];
  const laneSurfaces: [string, string[]][] = [
    [
      rootFiles.find((name) => /^lefthook\.ya?ml$/.test(name)) ??
        "lefthook.yml",
      rootFiles.filter((name) => /^lefthook\.ya?ml$/.test(name)),
    ],
    [
      ".github/workflows",
      [...projectFiles].filter((p) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p),
      ),
    ],
  ];
  for (const [surface, paths] of laneSurfaces) {
    const text = paths.map((p) => readRaw(join(root, p)) ?? "").join("\n");
    const lane = scrapeLaneInvocations(text);
    // A surface that never runs verify.mjs is not judged: absence is no defect.
    if (lane.seen) {
      lanes.push({
        surface,
        groups: lane.groups,
        steps: lane.steps,
        dynamic: lane.dynamic,
      });
    }
  }

  return {
    packageJson,
    scripts,
    nodeVersion: nodeVersionText?.trim(),
    tsconfigFiles,
    tsconfigLinks,
    chains,
    eslint: {
      flatFile,
      source:
        flatFile === undefined ? undefined : readSource(join(root, flatFile)),
      legacy: rootFiles.filter((name) => LEGACY_ESLINT.test(name)),
    },
    vitest: {
      file: vitestFile,
      source:
        vitestFile === undefined
          ? undefined
          : readSource(join(root, vitestFile)),
    },
    gates: {
      stepsFile: stepsText === undefined ? undefined : STEPS_PATH,
      ...(stepsText === undefined
        ? { groups: [], steps: [] }
        : scrapeGateSteps(stepsText)),
      packs:
        packsRead === undefined
          ? undefined
          : {
              path: PACKS_PATH,
              error: packsRead.ok ? undefined : packsRead.error,
            },
    },
    lanes,
    projectFiles,
  };
}

/** Runs every rule over the project rooted at `rootDir` and tallies the result. */
export function gradeToolchain(rootDir: string): ToolchainGrade {
  const snapshot = loadSnapshot(rootDir);
  const findings: ToolchainFinding[] = [];
  const structural: CheckTally = { checked: 0, failed: 0 };
  const rubric = Object.fromEntries(
    TOOLCHAIN_CATEGORIES.map((category) => [
      category,
      { checked: 0, failed: 0 },
    ]),
  ) as Record<ToolchainCategory, CheckTally>;

  for (const rule of RULES) {
    const result = rule.check(snapshot);
    const tally =
      rule.level === "structural" ? structural : rubric[rule.category];
    tally.checked += result.checked;
    tally.failed += result.failures.length;
    for (const failure of result.failures) {
      findings.push({
        ruleId: rule.id,
        level: rule.level,
        category: rule.category,
        subject: failure.subject,
        message: failure.message,
      });
    }
  }

  const rubricChecked = Object.values(rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  const rubricFailed = Object.values(rubric).reduce(
    (sum, tally) => sum + tally.failed,
    0,
  );
  return {
    findings,
    structural,
    rubric,
    rubricScore: rubricChecked === 0 ? 1 : 1 - rubricFailed / rubricChecked,
  };
}
