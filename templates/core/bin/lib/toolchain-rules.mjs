/**
 * Grades this project's TypeScript toolchain: the tsconfig `extends` chain,
 * module/target settings, the ESLint config, the coverage gate, the wiring of
 * `bin/lib/verify-steps.mjs`, and the toolchain pins in `package.json`.
 * `gradeToolchain` reads everything once into a snapshot, then runs each rule
 * over it. Structural rules catch wiring defects `tsc` and ESLint do not --
 * a build project that emits nowhere, a verify step naming a script that does
 * not exist -- and fail the gate. Rubric rules encode the floor official
 * TypeScript / typescript-eslint guidance sets and only ever warn.
 *
 * Offline, read-only, and it never executes project code: `eslint.config.js`,
 * `vitest.config.ts` and `verify-steps.mjs` are executable JavaScript, so
 * their rules are regex scrapes over comment-stripped source, never
 * evaluation. A scrape that finds the file but cannot tell the answer returns
 * `{ checked: 0 }` rather than a failure -- absence, or a shape this module
 * cannot read, is never a defect. The comment stripper is a JSONC scanner,
 * not a JavaScript tokenizer; it can mis-handle a regex literal or a template
 * string, which none of the graded baseline files contain.
 *
 * This file is the emitted twin of m3l-groundwork's own
 * `packages/cli/src/toolchain/{rules,grade}.ts`; a parity test runs both over
 * the real baseline and asserts identical findings.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Options TypeScript 6.0 deprecated. `removedIn` is the major that drops them
 * (`outFile` and `moduleResolution: classic` already went in 6.0).
 * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
 * @public Exported for the parity test that compares this file with its TypeScript twin in
 * m3l-groundwork; nothing else in a bootstrapped project imports it.
 */
export const LEGACY_OPTIONS = [
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
    matches: (value) => ["node", "node10"].includes(lower(value)),
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
      ["amd", "umd", "system", "systemjs", "none"].includes(lower(value)),
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
 * @public Exported for the parity test that compares this file with its TypeScript twin in
 * m3l-groundwork; nothing else in a bootstrapped project imports it.
 */
export const STRICT_FLAGS = [
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

/**
 * The rubric categories, in report order.
 * @public Exported for the parity test that compares this file with its TypeScript twin in
 * m3l-groundwork; nothing else in a bootstrapped project imports it.
 */
export const CATEGORIES = [
  "tsconfig",
  "modules",
  "eslint",
  "testing",
  "gates",
  "deps",
];

const PROJECT_WALK_DEPTH = 6;
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
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm",
  "out",
  ".nx",
]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const lower = (value) =>
  typeof value === "string" ? value.toLowerCase() : value;

// --- reading the project ---------------------------------------------------

/** Bounded recursive listing: skips dependency/build dirs, stops at `maxDepth`. */
function walkBounded(root, maxDepth) {
  const results = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;
      const path = join(dir, entry.name);
      results.push({
        path,
        relPath: relative(root, path).split("\\").join("/"),
        isDirectory: entry.isDirectory(),
      });
      if (entry.isDirectory()) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return results;
}

/** Strips `//` and block comments and trailing commas, leaving string literals alone. */
function stripJsoncNoise(content) {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += ch;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

function readJsonc(path) {
  if (!existsSync(path)) return { ok: false, error: `${path} does not exist` };
  try {
    return {
      ok: true,
      value: JSON.parse(stripJsoncNoise(readFileSync(path, "utf8"))),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** File text with comments stripped, or `undefined` when unreadable. */
function readSource(path) {
  try {
    return stripJsoncNoise(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** File text exactly as written, or `undefined` when unreadable. */
function readRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The `extends` value as a list: a string, or TypeScript 5.0+'s array form. */
function extendsList(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string");
  }
  return [];
}

/**
 * Resolves one `extends` specifier the way TypeScript does for the common
 * cases: a relative path (`x`, `x.json`, `x/tsconfig.json`), or a bare
 * package specifier looked up under every ancestor `node_modules`. A package
 * `exports` map is out of scope -- such a specifier simply stays unresolved.
 */
function resolveExtends(specifier, fromAbs) {
  const candidates = (base) => [
    base,
    `${base}.json`,
    join(base, "tsconfig.json"),
  ];
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return {
      kind: "relative",
      abs: candidates(resolve(dirname(fromAbs), specifier)).find(isFile),
    };
  }
  let dir = dirname(fromAbs);
  for (;;) {
    const abs = candidates(join(dir, "node_modules", specifier)).find(isFile);
    if (abs !== undefined) return { kind: "package", abs };
    const parent = dirname(dir);
    if (parent === dir) return { kind: "package", abs: undefined };
    dir = parent;
  }
}

/**
 * Follows one tsconfig's `extends` chain and folds `compilerOptions` the way
 * TypeScript does: array entries left to right, the file's own options last.
 * `files` collects each project-owned file once across every chain (a
 * `node_modules` base is read for its options but never graded as ours);
 * `links` collects every `extends` edge. `complete` is false when a link could
 * not be followed, so rules that judge effective options stand down.
 */
function loadTsconfigChain(root, entry, files, links) {
  let parsed = true;
  let complete = true;
  const members = [];
  const visit = (abs, stack) => {
    if (stack.includes(abs)) return {};
    const rel = relative(root, abs).split("\\").join("/");
    if (!members.includes(rel)) members.push(rel);
    const read = readJsonc(abs);
    const usable = read.ok && isRecord(read.value);
    const own =
      usable && isRecord(read.value.compilerOptions)
        ? read.value.compilerOptions
        : {};
    if (!rel.startsWith("node_modules/") && !rel.startsWith("..")) {
      if (!files.has(rel)) {
        files.set(rel, {
          rel,
          error: usable
            ? undefined
            : read.ok
              ? "top level is not an object"
              : read.error,
          options: own,
        });
      }
    }
    if (!usable) {
      parsed = false;
      complete = false;
      return {};
    }
    let merged = {};
    for (const specifier of extendsList(read.value.extends)) {
      const target = resolveExtends(specifier, abs);
      if (!links.some((l) => l.from === rel && l.specifier === specifier)) {
        links.push({
          from: rel,
          specifier,
          kind: target.kind,
          resolved: target.abs !== undefined,
        });
      }
      if (target.abs === undefined) {
        complete = false;
        continue;
      }
      merged = { ...merged, ...visit(target.abs, [...stack, abs]) };
    }
    return { ...merged, ...own };
  };
  const options = visit(join(root, entry), []);
  return { entry, options, parsed, complete, members };
}

/** The `.json` file a `tsc -b|-p <file>` script names, if it names one. */
function scriptTsconfig(script) {
  if (typeof script !== "string") return undefined;
  const match =
    /\btsc\b[^&|;\n]*?\s(?:-b|--build|-p|--project)\s+(?:--\S+\s+)*([^\s&|;]+\.json)/.exec(
      script,
    );
  return match === null ? undefined : match[1].replace(/^\.\//, "");
}

/** Reads `verify-steps.mjs` as data: the `GROUPS` list and every `{ id, group, cmd }` literal. */
function scrapeGateSteps(text) {
  const groupList = /\bGROUPS\s*=\s*\[([^\]]*)\]/.exec(text);
  const groups =
    groupList === null
      ? []
      : [...groupList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const steps = [];
  for (const match of text.matchAll(
    /\bid:\s*"([^"]+)"([^{}]*?)\bcmd:\s*\[([^\]]*)\]/g,
  )) {
    const group = /\bgroup:\s*"([^"]+)"/.exec(match[2]);
    steps.push({
      id: match[1],
      group: group === null ? undefined : group[1],
      cmd: [...match[3].matchAll(/"([^"]*)"/g)].map((m) => m[1]),
    });
  }
  return { groups, steps };
}

/**
 * Reads every `verify.mjs` invocation out of one YAML surface as data: the
 * `--group`/`--step` each names. YAML is scraped, never parsed. An invocation
 * naming neither (a matrix, or a bare full run) marks the surface `dynamic`.
 */
function scrapeLaneInvocations(text) {
  const groups = [];
  const steps = [];
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
    if (group !== null) groups.push(group[1]);
    else if (step !== null) steps.push(step[1]);
    else dynamic = true;
  }
  return { seen, groups, steps, dynamic };
}

function loadSnapshot(root) {
  const entries = walkBounded(root, PROJECT_WALK_DEPTH);
  const projectFiles = new Set(
    entries.filter((e) => !e.isDirectory).map((e) => e.relPath),
  );
  const rootFiles = [...projectFiles].filter((p) => !p.includes("/"));

  const packageRead = readJsonc(join(root, "package.json"));
  const pkg =
    packageRead.ok && isRecord(packageRead.value)
      ? packageRead.value
      : undefined;
  const scripts = {};
  if (pkg !== undefined && isRecord(pkg.scripts)) {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (typeof cmd === "string") scripts[name] = cmd;
    }
  }

  const tsconfigFiles = new Map();
  const tsconfigLinks = [];
  const chains = rootFiles
    .filter((name) => /^tsconfig(\..+)?\.json$/.test(name))
    .sort()
    .map((name) => loadTsconfigChain(root, name, tsconfigFiles, tsconfigLinks));

  const flatName = FLAT_ESLINT.find((name) => projectFiles.has(name));
  const vitestName = VITEST_CONFIGS.find((name) => projectFiles.has(name));
  const stepsPath = "bin/lib/verify-steps.mjs";
  const packsPath = "bin/lib/verify-steps.packs.json";
  const stepsText = projectFiles.has(stepsPath)
    ? readSource(join(root, stepsPath))
    : undefined;
  const packsRead = projectFiles.has(packsPath)
    ? readJsonc(join(root, packsPath))
    : undefined;
  const nodeVersionText = projectFiles.has(".node-version")
    ? readSource(join(root, ".node-version"))
    : undefined;

  const lanes = [];
  const laneSurfaces = [
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
    packageJson: pkg,
    scripts,
    nodeVersion: nodeVersionText?.trim(),
    tsconfigFiles,
    tsconfigLinks,
    chains,
    eslint: {
      flatFile: flatName,
      source:
        flatName === undefined ? undefined : readSource(join(root, flatName)),
      legacy: rootFiles.filter((name) => LEGACY_ESLINT.test(name)),
    },
    vitest: {
      file: vitestName,
      source:
        vitestName === undefined
          ? undefined
          : readSource(join(root, vitestName)),
    },
    gates: {
      stepsFile: stepsText === undefined ? undefined : stepsPath,
      ...(stepsText === undefined
        ? { groups: [], steps: [] }
        : scrapeGateSteps(stepsText)),
      packs:
        packsRead === undefined
          ? undefined
          : {
              path: packsPath,
              error: packsRead.ok ? undefined : packsRead.error,
            },
    },
    lanes,
    projectFiles,
  };
}

// --- helpers shared by rules -----------------------------------------------

/** The first number in a range: `^6.0.3` gives 6. `undefined` when there is none (`workspace:*`, `catalog:`). */
function majorOf(spec) {
  const match = /(\d+)/.exec(spec ?? "");
  return match === null ? undefined : Number(match[1]);
}

function depSpec(snapshot, name) {
  const pkg = snapshot.packageJson;
  if (pkg === undefined) return undefined;
  for (const key of ["devDependencies", "dependencies"]) {
    const section = pkg[key];
    if (isRecord(section) && typeof section[name] === "string") {
      return section[name];
    }
  }
  return undefined;
}

const isUnpinned = (spec) => /^\s*(\*|x|latest|next)?\s*$/i.test(spec);

/**
 * The chain a project's strict-flag judgement is made over: `tsconfig.json`,
 * else the first chain no other chain extends (a leaf, not a base), else the
 * first.
 */
function primaryChain(snapshot) {
  const named = snapshot.chains.find(
    (chain) => chain.entry === "tsconfig.json",
  );
  if (named !== undefined) return named;
  const leaf = snapshot.chains.find(
    (chain) =>
      !snapshot.chains.some(
        (other) => other !== chain && other.members.includes(chain.entry),
      ),
  );
  return leaf ?? snapshot.chains[0];
}

function ownFiles(snapshot) {
  return [...snapshot.tsconfigFiles.values()].filter(
    (file) => file.error === undefined,
  );
}

/** The first year an ES target denotes; `Infinity` for `esnext`; `undefined` when unrecognised. */
function targetYear(target) {
  const value = lower(target);
  if (value === "esnext") return Infinity;
  const match = /^es(\d+)$/.exec(value ?? "");
  if (match === null) return undefined;
  const n = Number(match[1]);
  return n < 100 ? n + 2009 : n;
}

const NONE = { checked: 0, failures: [] };

// --- structural rules ------------------------------------------------------

const tsconfigParses = {
  id: "tsconfig-parses",
  level: "structural",
  category: "tsconfig",
  check: (s) => ({
    checked: s.tsconfigFiles.size,
    failures: [...s.tsconfigFiles.values()]
      .filter((file) => file.error !== undefined)
      .map((file) => ({
        subject: file.rel,
        message: `does not parse as JSONC: ${file.error}`,
      })),
  }),
};

const tsconfigExtendsResolves = {
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

const tsconfigEmitCoherence = {
  id: "tsconfig-emit-coherence",
  level: "structural",
  category: "tsconfig",
  check: (s) => {
    const buildName = scriptTsconfig(s.scripts["build"]);
    const build = s.chains.find((chain) => chain.entry === buildName);
    if (build === undefined || !build.complete) return NONE;
    const failures = [];
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

const gateWiring = {
  id: "gate-wiring",
  level: "structural",
  category: "gates",
  check: (s) => {
    const { stepsFile, groups, steps, packs } = s.gates;
    const failures = [];
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
              subject: `${stepsFile} step "${step.id}"`,
              message: `runs \`pnpm ${script}\`, but package.json has no "${script}" script`,
            });
          }
        }
      }
      if (tool === "node" && first !== undefined && !first.startsWith("-")) {
        checked += 1;
        if (!s.projectFiles.has(first)) {
          failures.push({
            subject: `${stepsFile} step "${step.id}"`,
            message: `runs \`node ${first}\`, which does not exist`,
          });
        }
      }
      if (groups.length > 0 && step.group !== undefined) {
        checked += 1;
        if (!groups.includes(step.group)) {
          failures.push({
            subject: `${stepsFile} step "${step.id}"`,
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
            subject: `${stepsFile} group "${group}"`,
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

const gateLaneParity = {
  id: "gate-lane-parity",
  level: "structural",
  category: "gates",
  check: (s) => {
    const { groups } = s.gates;
    if (groups.length === 0) return NONE;
    const failures = [];
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
function enginesBounds(range) {
  if (range.includes("||")) return undefined;
  const low = /(?:^|\s)(?:>=|\^|~|=)?\s*v?(\d+)/.exec(range);
  const high = /<\s*(\d+)/.exec(range);
  return {
    min: low === null ? undefined : Number(low[1]),
    max: high === null ? undefined : Number(high[1]),
  };
}

const nodePinCoherence = {
  id: "node-pin-coherence",
  level: "structural",
  category: "gates",
  check: (s) => {
    const pkg = s.packageJson;
    const engines =
      pkg !== undefined && isRecord(pkg.engines) ? pkg.engines.node : undefined;
    if (s.nodeVersion === undefined || typeof engines !== "string") return NONE;
    const pin = /^v?(\d+)/.exec(s.nodeVersion);
    const bounds = enginesBounds(engines);
    if (pin === null || bounds === undefined) return NONE;
    const major = Number(pin[1]);
    const failures = [];
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

const strictFlags = {
  id: "strict-flags",
  level: "rubric",
  category: "tsconfig",
  check: (s) => {
    const chain = primaryChain(s);
    if (chain === undefined || !chain.complete) return NONE;
    const failures = [];
    const expect = (flag, wanted) => {
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
    for (const flag of STRICT_FLAGS) expect(flag, true);
    expect("allowUnreachableCode", false);
    return { checked: STRICT_FLAGS.length + 1, failures };
  },
};

const tsconfigOptionLifecycle = {
  id: "tsconfig-option-lifecycle",
  level: "rubric",
  category: "tsconfig",
  check: (s) => {
    const major = majorOf(depSpec(s, "typescript"));
    const files = ownFiles(s);
    const failures = [];
    for (const file of files) {
      const hits = [];
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

const moduleTargetModern = {
  id: "module-target-modern",
  level: "rubric",
  category: "modules",
  check: (s) => {
    const chain = primaryChain(s);
    if (chain === undefined || !chain.complete) return NONE;
    const { module, moduleResolution, target } = chain.options;
    const failures = [];
    let checked = 0;
    if (module !== undefined) {
      checked += 1;
      if (!MODERN_MODULES.has(lower(module))) {
        failures.push({
          subject: chain.entry,
          message: `module is ${JSON.stringify(module)}; use nodenext (Node) or preserve (bundler)`,
        });
      }
    }
    if (moduleResolution !== undefined) {
      checked += 1;
      if (!MODERN_RESOLUTIONS.has(lower(moduleResolution))) {
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

const eslintFlatConfig = {
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

const eslintTypedLinting = {
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
    const failures = [];
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

const eslintCoversEmittedCode = {
  id: "eslint-covers-emitted-code",
  level: "rubric",
  category: "eslint",
  check: (s) => {
    const { flatFile, source } = s.eslint;
    if (flatFile === undefined || source === undefined) return NONE;
    const failures = [];
    let checked = 1;
    const ignored = [...source.matchAll(/\bignores\s*:\s*\[([\s\S]*?)\]/g)]
      .flatMap((block) => [...block[1].matchAll(/["']([^"']+)["']/g)])
      .map((literal) => literal[1]);
    const dropsSrc = ignored.filter((glob) => /^(\*\*\/)?src(\/|$)/.test(glob));
    for (const glob of dropsSrc) {
      failures.push({
        subject: flatFile,
        message: `ignores "${glob}", so the project's own source is never linted`,
      });
    }
    const files = [...s.projectFiles];
    const scopes = [
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

const coverageGate = {
  id: "coverage-gate",
  level: "rubric",
  category: "testing",
  check: (s) => {
    const { file, source } = s.vitest;
    if (file === undefined || source === undefined) return NONE;
    const failures = [];
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

const toolchainPinShape = {
  id: "toolchain-pin-shape",
  level: "rubric",
  category: "deps",
  check: (s) => {
    const pkg = s.packageJson;
    if (pkg === undefined) return NONE;
    const failures = [];
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
    if (typeof pkg.packageManager !== "string") {
      failures.push({
        subject: "package.json",
        message:
          "declares no packageManager, so the package-manager version is unpinned",
      });
    }
    const types = majorOf(depSpec(s, "@types/node"));
    const pin = /^v?(\d+)/.exec(s.nodeVersion ?? "");
    if (types !== undefined && pin !== null) {
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

/**
 * Every rule, structural first. Order is the order findings are reported in.
 * @public Exported for the parity test that compares this file with its TypeScript twin in
 * m3l-groundwork; nothing else in a bootstrapped project imports it.
 */
export const RULES = [
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

// --- grading and reporting -------------------------------------------------

/**
 * Prints a grade through a `bin/lib/report.mjs` reporter. Kept here rather
 * than in each gate script so the repo's own wrapper and the emitted gate
 * cannot report the same grade differently.
 */
export function reportGrade(grade, reporter) {
  for (const finding of grade.findings) {
    const line = `[${finding.ruleId}] ${finding.subject} -- ${finding.message}`;
    if (finding.level === "structural") {
      reporter.fail(line);
    } else {
      reporter.warn(line);
    }
  }
  const { checked, failed } = grade.structural;
  if (failed === 0) {
    reporter.ok(`toolchain wiring: ${checked} structural checks passed`);
  }
  const rubricChecked = Object.values(grade.rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  reporter.ok(
    `toolchain rubric: ${(grade.rubricScore * 100).toFixed(0)}% over ${rubricChecked} checks (warnings never fail the gate)`,
  );
}

/** Runs every rule over the project rooted at `rootDir` and tallies the result. */
export function gradeToolchain(rootDir) {
  const snapshot = loadSnapshot(rootDir);
  const findings = [];
  const structural = { checked: 0, failed: 0 };
  const rubric = Object.fromEntries(
    CATEGORIES.map((category) => [category, { checked: 0, failed: 0 }]),
  );

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
