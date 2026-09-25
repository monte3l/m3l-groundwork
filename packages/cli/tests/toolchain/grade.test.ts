import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeToolchain } from "../../src/toolchain/grade.js";
import { RULES, STRICT_FLAGS } from "../../src/toolchain/rules.js";
import type { ToolchainGrade } from "../../src/toolchain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesCoreDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "core",
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolchain-grade-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(rel: string, value: unknown): void {
  write(rel, JSON.stringify(value, null, 2));
}

const PACKAGE = {
  scripts: {
    build: "tsc -b tsconfig.build.json",
    typecheck: "tsc -b --force",
    lint: "eslint .",
    test: "vitest run",
  },
  engines: { node: ">=24" },
  packageManager: "pnpm@12.4.0",
  devDependencies: {
    typescript: "^6.0.3",
    eslint: "^10.9.1",
    "typescript-eslint": "^8.69.0",
    "@types/node": "^24.13.3",
    vitest: "^4.1.11",
  },
};

const BASE_OPTIONS: Record<string, unknown> = {
  ...Object.fromEntries(STRICT_FLAGS.map((flag) => [flag, true])),
  allowUnreachableCode: false,
  module: "nodenext",
  moduleResolution: "nodenext",
  target: "es2023",
};

/** Lints TypeScript type-aware, but has no block for the scripts under bin/. */
const ESLINT_UNSCOPED = `import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
);
`;

/** The same, plus the block that covers bin/ -- clean for a project with bin/ scripts. */
const ESLINT_CONFIG = ESLINT_UNSCOPED.replace(
  "{ ignores:",
  '{ files: ["bin/**/*.mjs"] },\n  { ignores:',
);

const VITEST_CONFIG = `export default {
  test: { coverage: { thresholds: { lines: 80, perFile: true } } },
};
`;

/**
 * Otherwise-clean, but the `ignores` array is single-quoted and sits BEFORE
 * the `files: ["bin/**\/*.mjs"]` block. `readSource`'s JS-aware stripper
 * (`stripJsComments`, see packages/cli/src/jsonc.ts) tracks `'`/`` ` `` in
 * addition to `"`, so the `'dist/**'` entry's `/**` does not open a fake
 * block comment, and the real `files: ["bin/**\/*.mjs"]` block that follows
 * is read intact.
 */
const ESLINT_SINGLE_QUOTED_IGNORES = `import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
  { ignores: ['dist/**', 'coverage/**'] },
  { files: ["bin/**/*.mjs"] },
);
`;

/**
 * Otherwise-clean, but `coverage.exclude` is a single-quoted array sitting
 * before `thresholds`. Same shape as {@link ESLINT_SINGLE_QUOTED_IGNORES}:
 * the JS-aware stripper tracks the `'dist/**'` entry's quotes correctly, so
 * its `/**` never opens a fake block comment and the real
 * `thresholds: { ..., perFile: true }` block that follows is read intact.
 */
const VITEST_SINGLE_QUOTED_EXCLUDE = `export default {
  test: {
    coverage: {
      exclude: ['dist/**', 'coverage/**'],
      thresholds: { lines: 80, perFile: true },
    },
  },
};
`;

const VERIFY_STEPS = `export const GROUPS = ["lint", "build"];
export const CORE_STEPS = [
  { id: "lint", group: "lint", name: "Lint", cmd: ["pnpm", "lint"] },
  { id: "build", group: "build", name: "Build", cmd: ["pnpm", "build"] },
  {
    id: "check",
    group: "build",
    name: "Check",
    cmd: ["node", "bin/check.mjs"],
  },
];
`;

const LEFTHOOK = `pre-push:
  parallel: true
  commands:
    lint:
      run: node bin/verify.mjs --group lint
    build:
      run: node bin/verify.mjs --group build
`;

const CI = `# Each job invokes \`node bin/verify.mjs --group <name>\`.
jobs:
  lint:
    steps:
      - run: node bin/verify.mjs --group lint
  build:
    steps:
      - run: node bin/verify.mjs --group build
`;

/** A project clean under every rule, so each test degrades exactly one thing. */
function writeCleanProject(): void {
  writeJson("package.json", PACKAGE);
  write(".node-version", "24\n");
  writeJson("tsconfig.base.json", { compilerOptions: BASE_OPTIONS });
  writeJson("tsconfig.json", {
    extends: "./tsconfig.base.json",
    compilerOptions: { noEmit: true },
  });
  writeJson("tsconfig.build.json", {
    extends: "./tsconfig.base.json",
    compilerOptions: { outDir: "./dist" },
  });
  write("eslint.config.js", ESLINT_CONFIG);
  write("vitest.config.ts", VITEST_CONFIG);
  write("bin/lib/verify-steps.mjs", VERIFY_STEPS);
  write("bin/check.mjs", "// a check\n");
  writeJson("bin/lib/verify-steps.packs.json", []);
  write("lefthook.yml", LEFTHOOK);
  write(".github/workflows/ci.yml", CI);
}

/** Rewrites one JSON file in place. */
function editJson(
  rel: string,
  edit: (value: Record<string, unknown>) => void,
): void {
  const path = join(root, rel);
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  edit(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function ids(grade: ToolchainGrade, level?: "structural" | "rubric"): string[] {
  return grade.findings
    .filter((finding) => level === undefined || finding.level === level)
    .map((finding) => `${finding.ruleId}:${finding.subject}`)
    .sort();
}

/** Findings of one rule only, so a test about one rule is not hostage to another. */
function idsFor(ruleId: string): string[] {
  return ids({
    ...grade(),
    findings: grade().findings.filter((f) => f.ruleId === ruleId),
  });
}

function grade(): ToolchainGrade {
  return gradeToolchain(root);
}

describe("a clean project", () => {
  it("has no findings and a perfect rubric score", () => {
    writeCleanProject();
    const result = grade();
    expect(result.findings, JSON.stringify(result.findings, null, 2)).toEqual(
      [],
    );
    expect(result.rubricScore).toBe(1);
    expect(result.structural.checked).toBeGreaterThan(0);
  });

  it("grades an empty directory as nothing checked, never as a defect", () => {
    const result = grade();
    expect(result.findings).toEqual([]);
    expect(result.structural).toEqual({ checked: 0, failed: 0 });
    expect(result.rubricScore).toBe(1);
  });
});

// readSource (grade.ts) strips comments out of eslint.config.js/vitest.config.ts
// with stripJsComments, a JS-aware stripper that tracks `'`/`` ` `` in
// addition to `"` -- so a single-quoted string carrying a `//`/`/*`-shaped
// substring is never misread as a real comment, and nothing after it is
// corrupted. These two tests assert exactly that: a rule sees the real
// content that follows a single-quoted array, not a false positive from
// corrupted source.
describe("readSource must not corrupt single-quoted JS/TS source", () => {
  it("a single-quoted ignores array in eslint.config.js does not swallow the real bin/** coverage block after it", () => {
    writeCleanProject();
    write("eslint.config.js", ESLINT_SINGLE_QUOTED_IGNORES);
    expect(
      grade().findings.filter((f) => f.ruleId === "eslint-covers-emitted-code"),
    ).toEqual([]);
  });

  it("a single-quoted coverage.exclude array in vitest.config.ts does not swallow the real thresholds block after it", () => {
    writeCleanProject();
    write("vitest.config.ts", VITEST_SINGLE_QUOTED_EXCLUDE);
    expect(
      grade().findings.filter((f) => f.ruleId === "coverage-gate"),
    ).toEqual([]);
  });
});

describe("structural rules", () => {
  it("tsconfig-parses: an unparseable chain member fails, and only that project stands down", () => {
    writeCleanProject();
    write("tsconfig.json", "{not json");
    expect(ids(grade())).toEqual(["tsconfig-parses:tsconfig.json"]);
  });

  it("tsconfig-parses: a top level that is not an object fails", () => {
    writeCleanProject();
    write("tsconfig.json", "[]");
    expect(ids(grade())).toEqual(["tsconfig-parses:tsconfig.json"]);
  });

  it("tsconfig-extends-resolves: a missing relative target fails", () => {
    writeCleanProject();
    writeJson("tsconfig.json", { extends: "./nope.json" });
    expect(ids(grade())).toEqual(["tsconfig-extends-resolves:tsconfig.json"]);
  });

  it("tsconfig-extends-resolves: an uninstalled bare specifier is never a failure", () => {
    writeCleanProject();
    writeJson("tsconfig.json", {
      extends: "@tsconfig/node24/tsconfig.json",
      compilerOptions: { noEmit: true },
    });
    // The chain is incomplete, so the flag rules stand down rather than warn.
    expect(ids(grade())).toEqual([]);
  });

  it("tsconfig-extends-resolves: an installed bare specifier is followed", () => {
    writeCleanProject();
    writeJson("node_modules/@tsconfig/node24/tsconfig.json", {
      compilerOptions: BASE_OPTIONS,
    });
    writeJson("tsconfig.json", {
      extends: "@tsconfig/node24/tsconfig.json",
      compilerOptions: { noEmit: true },
    });
    expect(ids(grade())).toEqual([]);
  });

  it("tsconfig-emit-coherence: a build project with no outDir fails", () => {
    writeCleanProject();
    writeJson("tsconfig.build.json", { extends: "./tsconfig.base.json" });
    expect(ids(grade(), "structural")).toEqual([
      "tsconfig-emit-coherence:tsconfig.build.json",
    ]);
  });

  it("tsconfig-emit-coherence: a build project that sets noEmit fails", () => {
    writeCleanProject();
    writeJson("tsconfig.build.json", {
      extends: "./tsconfig.base.json",
      compilerOptions: { outDir: "./dist", noEmit: true },
    });
    expect(ids(grade(), "structural")).toEqual([
      "tsconfig-emit-coherence:tsconfig.build.json",
    ]);
  });

  it("tsconfig-emit-coherence: a tooling project that emits fails", () => {
    writeCleanProject();
    writeJson("tsconfig.json", { extends: "./tsconfig.base.json" });
    expect(ids(grade(), "structural")).toEqual([
      "tsconfig-emit-coherence:tsconfig.json",
    ]);
  });

  it("tsconfig-emit-coherence: a single-tsconfig project is not judged", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      pkg["scripts"] = {
        ...(pkg["scripts"] as Record<string, string>),
        build: "tsc",
      };
    });
    writeJson("tsconfig.json", {
      extends: "./tsconfig.base.json",
      compilerOptions: { outDir: "dist" },
    });
    expect(ids(grade(), "structural")).toEqual([]);
  });

  it("gate-wiring: a step naming a missing pnpm script fails", () => {
    writeCleanProject();
    write(
      "bin/lib/verify-steps.mjs",
      VERIFY_STEPS.replace('"pnpm", "build"', '"pnpm", "compile"'),
    );
    expect(ids(grade(), "structural")).toEqual([
      'gate-wiring:bin/lib/verify-steps.mjs step "build"',
    ]);
  });

  it("gate-wiring: `pnpm run <script>` is resolved, and pnpm builtins are not scripts", () => {
    writeCleanProject();
    write(
      "bin/lib/verify-steps.mjs",
      VERIFY_STEPS.replace('"pnpm", "build"', '"pnpm", "run", "build"').replace(
        '"pnpm", "lint"',
        '"pnpm", "exec", "eslint"',
      ),
    );
    expect(ids(grade(), "structural")).toEqual([]);
  });

  it("gate-wiring: a step running a missing node file fails", () => {
    writeCleanProject();
    write(
      "bin/lib/verify-steps.mjs",
      VERIFY_STEPS.replace("bin/check.mjs", "bin/gone.mjs"),
    );
    expect(ids(grade(), "structural")).toEqual([
      'gate-wiring:bin/lib/verify-steps.mjs step "check"',
    ]);
  });

  it("gate-wiring: a step in an unknown group fails", () => {
    writeCleanProject();
    write(
      "bin/lib/verify-steps.mjs",
      VERIFY_STEPS.replace(
        'group: "build", name: "Build"',
        'group: "ship", name: "Build"',
      ),
    );
    expect(ids(grade(), "structural")).toEqual([
      'gate-wiring:bin/lib/verify-steps.mjs step "build"',
    ]);
  });

  it("gate-wiring: a group with no step fails", () => {
    writeCleanProject();
    write(
      "bin/lib/verify-steps.mjs",
      VERIFY_STEPS.replace('["lint", "build"]', '["lint", "build", "test"]'),
    );
    expect(idsFor("gate-wiring")).toEqual([
      'gate-wiring:bin/lib/verify-steps.mjs group "test"',
    ]);
  });

  it("gate-wiring: a malformed packs file fails", () => {
    writeCleanProject();
    write("bin/lib/verify-steps.packs.json", "{oops");
    expect(ids(grade(), "structural")).toEqual([
      "gate-wiring:bin/lib/verify-steps.packs.json",
    ]);
  });

  it("gate-wiring: a project with no verify-steps file is not judged", () => {
    writeCleanProject();
    rmSync(join(root, "bin", "lib"), { recursive: true });
    expect(ids(grade(), "structural")).toEqual([]);
  });

  it("gate-lane-parity: a group with no lefthook lane fails", () => {
    writeCleanProject();
    write("lefthook.yml", LEFTHOOK.replace(/ {4}build:\n.*\n/, ""));
    expect(idsFor("gate-lane-parity")).toEqual([
      "gate-lane-parity:lefthook.yml",
    ]);
    expect(
      grade().findings.find((f) => f.ruleId === "gate-lane-parity")?.message,
    ).toContain("--group build");
  });

  it("gate-lane-parity: a group with no CI job fails", () => {
    writeCleanProject();
    write(".github/workflows/ci.yml", CI.replace(/ {2}build:\n.*\n.*\n/, ""));
    expect(idsFor("gate-lane-parity")).toEqual([
      "gate-lane-parity:.github/workflows",
    ]);
  });

  it("gate-lane-parity: a lane naming a group that does not exist fails", () => {
    writeCleanProject();
    write(
      "lefthook.yml",
      LEFTHOOK + "    ship:\n      run: node bin/verify.mjs --group ship\n",
    );
    const finding = grade().findings.find(
      (f) => f.ruleId === "gate-lane-parity",
    );
    expect(finding?.subject).toBe("lefthook.yml");
    expect(finding?.message).toContain("ship is not in GROUPS (lint, build)");
  });

  it("gate-lane-parity: naming a step by id is flagged as the drift-prone form", () => {
    writeCleanProject();
    write(
      ".github/workflows/ci.yml",
      CI + "      - run: node bin/verify.mjs --step lint\n",
    );
    const finding = grade().findings.find(
      (f) => f.ruleId === "gate-lane-parity",
    );
    expect(finding?.message).toContain("--step lint");
    expect(finding?.message).toContain("name a group instead");
  });

  it("gate-lane-parity: accepts --group=<name> and aggregates several workflow files", () => {
    writeCleanProject();
    write(
      ".github/workflows/ci.yml",
      "jobs:\n  a:\n    steps:\n      - run: node bin/verify.mjs --group=lint\n",
    );
    expect(idsFor("gate-lane-parity")).toEqual([
      "gate-lane-parity:.github/workflows",
    ]);
    write(
      ".github/workflows/more.yaml",
      "jobs:\n  b:\n    steps:\n      - run: node bin/verify.mjs --group build\n",
    );
    expect(idsFor("gate-lane-parity")).toEqual([]);
  });

  // These two tests document a genuine, accepted limitation (a matrix
  // expansion or a bare full-coverage run can't be read statically) --
  // they must keep passing UNCHANGED after the three new parsing-bug tests
  // below land; they are not bugs to fix.
  it("gate-lane-parity: a lane it cannot read statically is not judged", () => {
    writeCleanProject();
    write(
      ".github/workflows/ci.yml",
      "jobs:\n  a:\n    strategy:\n      matrix:\n        group: [lint]\n    steps:\n      - run: node bin/verify.mjs --group ${{ matrix.group }}\n",
    );
    write(
      "lefthook.yml",
      "pre-push:\n  commands:\n    all:\n      run: node bin/verify.mjs\n",
    );
    expect(idsFor("gate-lane-parity")).toEqual([]);
  });

  it("gate-lane-parity: a verify.mjs mention in a YAML comment is not an invocation", () => {
    writeCleanProject();
    write("lefthook.yml", "# node bin/verify.mjs --group lint\npre-push: {}\n");
    expect(idsFor("gate-lane-parity")).toEqual([]);
  });

  it("gate-lane-parity: a project whose YAML never runs verify.mjs is not judged", () => {
    writeCleanProject();
    write(
      "lefthook.yml",
      "pre-push:\n  commands:\n    t:\n      run: pnpm test\n",
    );
    rmSync(join(root, ".github"), { recursive: true });
    expect(idsFor("gate-lane-parity")).toEqual([]);
  });

  it("gate-lane-parity: a quoted --group value is read as a real group name, not silently treated as dynamic", () => {
    writeCleanProject();
    // "ship" is not in GROUPS (lint, build) -- same shape as the existing
    // "a lane naming a group that does not exist fails" test above, just
    // quoted. The regex tolerates an optional surrounding quote around the
    // value, so a quoted --group is read the same as a bare one rather than
    // marking the whole lefthook.yml surface dynamic.
    write(
      "lefthook.yml",
      LEFTHOOK + '    ship:\n      run: node bin/verify.mjs --group "ship"\n',
    );
    const finding = grade().findings.find(
      (f) =>
        f.ruleId === "gate-lane-parity" &&
        f.subject === "lefthook.yml" &&
        f.message.includes("ship is not in GROUPS"),
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("ship is not in GROUPS (lint, build)");
  });

  it("gate-lane-parity: a line-continuation-split invocation is still read as one invocation", () => {
    writeCleanProject();
    // "ship" is not in GROUPS. The command is split across two lines with a
    // trailing `\`, a real `run: |` shape. The continuation is joined into
    // one logical line before scraping, so the --group token on the second
    // physical line is read as part of the same invocation as the first.
    write(
      "lefthook.yml",
      "pre-push:\n  commands:\n    all:\n      run: |\n        node bin/verify.mjs \\\n          --group ship\n",
    );
    const finding = grade().findings.find(
      (f) =>
        f.ruleId === "gate-lane-parity" &&
        f.message.includes("ship is not in GROUPS"),
    );
    expect(finding).toBeDefined();
  });

  it("gate-lane-parity: a `name:` field merely mentioning verify.mjs must not suppress judgment of a real invocation in the same surface", () => {
    writeCleanProject();
    // Job "a"'s step name is plain text that happens to contain the string
    // "verify.mjs" -- not an invocation. Job "b" runs a real, badly-named
    // invocation ("ship" is not in GROUPS), on its own line with no `name:`
    // text before it, so it is read as a real invocation rather than the
    // `name:` mention marking the whole .github/workflows surface dynamic.
    write(
      ".github/workflows/ci.yml",
      "jobs:\n  a:\n    steps:\n      - name: Explain verify.mjs\n        run: pnpm test\n  b:\n    steps:\n      - run: node bin/verify.mjs --group ship\n",
    );
    const finding = grade().findings.find(
      (f) =>
        f.ruleId === "gate-lane-parity" &&
        f.subject === ".github/workflows" &&
        f.message.includes("ship is not in GROUPS"),
    );
    expect(finding).toBeDefined();
  });

  it("[bug] gate-lane-parity: an `echo` log-grouping idiom before a real invocation on the same line must not suppress judgment of that invocation", () => {
    // A GitHub Actions log-grouping idiom: a real `echo` call BEFORE the real
    // invocation, on the same line. Today the name:/echo exclusion tests the
    // ENTIRE line prefix before "verify.mjs", not just the shell-command
    // segment that actually contains it, so the `echo` earlier in the line
    // wrongly excludes the whole line -- and, since one unreadable line marks
    // the entire surface dynamic, the whole surface -- from judgment.
    writeCleanProject();
    write(
      "lefthook.yml",
      'pre-push:\n  commands:\n    all:\n      run: echo "::group::x" && node bin/verify.mjs --group ship\n',
    );
    const finding = grade().findings.find(
      (f) =>
        f.ruleId === "gate-lane-parity" &&
        f.message.includes("ship is not in GROUPS"),
    );
    expect(finding).toBeDefined();
  });

  it("[bug] gate-lane-parity: `name:` and `run:` on the same flow-mapping line must not suppress judgment of the real invocation", () => {
    // Same over-broad-prefix mechanism as above, triggered by a YAML
    // flow-mapping step where `name:` and `run:` sit on the same line. Today
    // the `name:` token before "verify.mjs" wrongly excludes the real `run:`
    // invocation that follows it on that same line.
    writeCleanProject();
    write(
      ".github/workflows/ci.yml",
      "jobs:\n  a:\n    steps:\n      - { name: Lint, run: node bin/verify.mjs --group ship }\n",
    );
    const finding = grade().findings.find(
      (f) =>
        f.ruleId === "gate-lane-parity" &&
        f.message.includes("ship is not in GROUPS"),
    );
    expect(finding).toBeDefined();
  });

  it("[bug] gate-lane-parity: a comment ending in a line continuation must not swallow a real invocation on the next line", () => {
    // Today the `\`-continuation join runs BEFORE comment-stripping, so a
    // YAML comment ending in a trailing `\` gets joined with the NEXT
    // physical line before that comment's leading `#` is stripped -- and the
    // merged line's `#` then strips the WHOLE thing, including a real
    // invocation that should have stood on its own.
    writeCleanProject();
    write(
      "lefthook.yml",
      "pre-push:\n  commands:\n    a:\n      run: |\n        # see C:\\\n        node bin/verify.mjs --group ship\n",
    );
    // Sanity: the file on disk actually carries a literal trailing backslash
    // at the end of the comment line, immediately followed by a newline and
    // the real invocation -- otherwise this test would not exercise the
    // continuation-before-comment-strip ordering it claims to.
    const written = readFileSync(join(root, "lefthook.yml"), "utf8");
    expect(written).toContain("# see C:\\\n        node bin/verify.mjs");
    const finding = grade().findings.find(
      (f) =>
        f.ruleId === "gate-lane-parity" &&
        f.message.includes("ship is not in GROUPS"),
    );
    expect(finding).toBeDefined();
  });

  it("node-pin-coherence: a pin below the engines floor fails", () => {
    writeCleanProject();
    write(".node-version", "22\n");
    expect(ids(grade(), "structural")).toEqual([
      "node-pin-coherence:.node-version",
    ]);
  });

  it("node-pin-coherence: a pin at or above an engines ceiling fails", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      pkg["engines"] = { node: ">=20 <24" };
    });
    expect(ids(grade(), "structural")).toEqual([
      "node-pin-coherence:.node-version",
    ]);
  });

  it("node-pin-coherence: a range it cannot read is left alone", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      pkg["engines"] = { node: ">=20 || >=24" };
    });
    write(".node-version", "lts/*\n");
    expect(ids(grade(), "structural")).toEqual([]);
  });
});

describe("rubric rules", () => {
  it("strict-flags: an unset flag warns, naming it", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      delete options["noUncheckedIndexedAccess"];
      options["strict"] = false;
      options["allowUnreachableCode"] = true;
    });
    const messages = grade()
      .findings.filter((f) => f.ruleId === "strict-flags")
      .map((f) => f.message);
    expect(messages).toEqual([
      "strict is false (want true)",
      "noUncheckedIndexedAccess is not set (want true)",
      "allowUnreachableCode is true (want false)",
    ]);
  });

  it("strict-flags: stands down when the chain is incomplete", () => {
    writeCleanProject();
    writeJson("tsconfig.json", {
      extends: "@acme/tsconfig",
      compilerOptions: { noEmit: true },
    });
    expect(ids(grade())).toEqual([]);
  });

  it("strict-flags: judges the first tsconfig when there is no tsconfig.json", () => {
    writeCleanProject();
    rmSync(join(root, "tsconfig.json"));
    writeJson("tsconfig.build.json", {
      extends: "./tsconfig.base.json",
      compilerOptions: { outDir: "dist", strict: false },
    });
    expect(idsFor("strict-flags")).toEqual([
      "strict-flags:tsconfig.build.json",
    ]);
  });

  it("tsconfig-option-lifecycle: an option deprecated at the pinned major warns", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["baseUrl"] = ".";
      options["esModuleInterop"] = false;
    });
    const finding = grade().findings.find(
      (f) => f.ruleId === "tsconfig-option-lifecycle",
    );
    expect(finding).toEqual({
      ruleId: "tsconfig-option-lifecycle",
      level: "rubric",
      category: "tsconfig",
      subject: "tsconfig.base.json",
      message: "sets baseUrl (deprecated), esModuleInterop: false (deprecated)",
    });
  });

  it("tsconfig-option-lifecycle: an option already removed is reported as removed", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["outFile"] = "out.js";
    });
    const finding = grade().findings.find(
      (f) => f.ruleId === "tsconfig-option-lifecycle",
    );
    expect(finding?.message).toBe("sets outFile (removed)");
  });

  it("tsconfig-option-lifecycle: warns one major ahead of a removal, and not before", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      (pkg["devDependencies"] as Record<string, string>)["typescript"] =
        "^5.9.0";
    });
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["outFile"] = "out.js"; // removed in 6: warn at 5
      options["baseUrl"] = "."; // removed in 7: silent at 5
    });
    const finding = grade().findings.find(
      (f) => f.ruleId === "tsconfig-option-lifecycle",
    );
    expect(finding?.message).toBe("sets outFile (removed in TypeScript 6)");
  });

  it("tsconfig-option-lifecycle: ignoreDeprecations warns even when the major is unknown", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      (pkg["devDependencies"] as Record<string, string>)["typescript"] =
        "workspace:*";
    });
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["ignoreDeprecations"] = "6.0";
      options["baseUrl"] = ".";
    });
    const finding = grade().findings.find(
      (f) => f.ruleId === "tsconfig-option-lifecycle",
    );
    expect(finding?.message).toBe(
      "sets ignoreDeprecations (a migration aid, not a long-term setting)",
    );
  });

  it("tsconfig-option-lifecycle: matches each legacy option by its own value", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["moduleResolution"] = "Node10";
      options["module"] = "AMD";
      options["target"] = "ES5";
      options["downlevelIteration"] = true;
      options["allowSyntheticDefaultImports"] = false;
      options["alwaysStrict"] = false;
    });
    const finding = grade().findings.find(
      (f) => f.ruleId === "tsconfig-option-lifecycle",
    );
    expect(finding?.message).toBe(
      "sets " +
        [
          "moduleResolution: node (deprecated)",
          "target: es5 (deprecated)",
          "downlevelIteration (deprecated)",
          "module: amd|umd|system|none (deprecated)",
          "allowSyntheticDefaultImports: false (deprecated)",
          "alwaysStrict: false (deprecated)",
        ].join(", "),
    );
  });

  it("tsconfig-option-lifecycle: `moduleResolution: classic` is removed", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["moduleResolution"] = "classic";
    });
    const finding = grade().findings.find(
      (f) => f.ruleId === "tsconfig-option-lifecycle",
    );
    expect(finding?.message).toBe("sets moduleResolution: classic (removed)");
  });

  it("module-target-modern: legacy module, resolution and target each warn", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["module"] = "commonjs";
      options["moduleResolution"] = "bundler-ish";
      options["target"] = "es2015";
    });
    expect(
      grade()
        .findings.filter((f) => f.ruleId === "module-target-modern")
        .map((f) => f.message),
    ).toEqual([
      'module is "commonjs"; use nodenext (Node) or preserve (bundler)',
      'moduleResolution is "bundler-ish"; use nodenext or bundler',
      'target is "es2015"; es2022 or later is the floor',
    ]);
  });

  it("module-target-modern: accepts esnext and an unset module", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      delete options["module"];
      delete options["moduleResolution"];
      options["target"] = "ESNext";
    });
    expect(
      grade().findings.filter((f) => f.ruleId === "module-target-modern"),
    ).toEqual([]);
  });

  it("module-target-modern: an unrecognised target is left alone", () => {
    writeCleanProject();
    editJson("tsconfig.base.json", (config) => {
      const options = config["compilerOptions"] as Record<string, unknown>;
      options["target"] = "latest";
    });
    expect(
      grade().findings.filter((f) => f.ruleId === "module-target-modern"),
    ).toEqual([]);
  });

  it("eslint-flat-config: a legacy eslintrc without a flat config warns", () => {
    writeCleanProject();
    rmSync(join(root, "eslint.config.js"));
    write(".eslintrc.json", "{}");
    expect(ids(grade(), "rubric")).toEqual([
      "eslint-flat-config:.eslintrc.json",
    ]);
  });

  it("eslint-typed-linting: a config that never uses typescript-eslint warns", () => {
    writeCleanProject();
    write("eslint.config.js", "export default [];\n");
    expect(idsFor("eslint-typed-linting")).toEqual([
      "eslint-typed-linting:eslint.config.js",
    ]);
  });

  it("eslint-typed-linting: a shared config package is undetermined, not a failure", () => {
    writeCleanProject();
    write(
      "eslint.config.js",
      'import base from "@acme/eslint-config";\nexport default [...base];\n',
    );
    expect(idsFor("eslint-typed-linting")).toEqual([]);
  });

  it("eslint-typed-linting: an untyped preset and a missing projectService each warn", () => {
    writeCleanProject();
    write(
      "eslint.config.js",
      'import tseslint from "typescript-eslint";\nexport default tseslint.config(...tseslint.configs.recommended, ...tseslint.configs.disableTypeChecked);\n',
    );
    expect(
      grade()
        .findings.filter((f) => f.ruleId === "eslint-typed-linting")
        .map((f) => f.message),
    ).toEqual([
      "uses typescript-eslint without a type-checked preset (recommendedTypeChecked or strictTypeChecked)",
      "does not set parserOptions.projectService, so type-aware rules cannot read type information",
    ]);
  });

  it("eslint-typed-linting: strictTypeChecked and a CommonJS require count", () => {
    writeCleanProject();
    write(
      "eslint.config.js",
      'const tseslint = require("typescript-eslint");\nmodule.exports = tseslint.config(...tseslint.configs.strictTypeChecked, { languageOptions: { parserOptions: { projectService: true } } });\n',
    );
    expect(idsFor("eslint-typed-linting")).toEqual([]);
  });

  it("eslint-covers-emitted-code: ignoring src warns", () => {
    writeCleanProject();
    write(
      "eslint.config.js",
      ESLINT_CONFIG.replace('"**/dist/**"', '"**/dist/**", "src/**"'),
    );
    expect(ids(grade(), "rubric")).toEqual([
      "eslint-covers-emitted-code:eslint.config.js",
    ]);
  });

  it("eslint-covers-emitted-code: scripts under bin/ and .claude/hooks/ need a config block", () => {
    writeCleanProject();
    write("eslint.config.js", ESLINT_UNSCOPED);
    write(".claude/hooks/guard.mjs", "// hook\n");
    const bare = grade().findings.filter(
      (f) => f.ruleId === "eslint-covers-emitted-code",
    );
    expect(bare.map((f) => f.message)).toEqual([
      "has no config block for bin/**, whose scripts are code this project runs",
      "has no config block for .claude/hooks/**, whose scripts are code this project runs",
    ]);
    write(
      "eslint.config.js",
      ESLINT_UNSCOPED.replace(
        "{ ignores:",
        '{ files: ["bin/**/*.mjs", ".claude/hooks/**/*.mjs"] },\n  { ignores:',
      ),
    );
    expect(
      grade().findings.filter((f) => f.ruleId === "eslint-covers-emitted-code"),
    ).toEqual([]);
  });

  it("coverage-gate: missing thresholds and a non-per-file gate each warn", () => {
    writeCleanProject();
    write("vitest.config.ts", "export default { test: {} };\n");
    expect(
      grade()
        .findings.filter((f) => f.ruleId === "coverage-gate")
        .map((f) => f.message),
    ).toEqual([
      "sets no coverage thresholds, so coverage can fall without failing anything",
      "does not set coverage.thresholds.perFile: true, so one well-covered file hides an untested one",
    ]);
  });

  it("coverage-gate: a `perFile` mention in a comment does not count", () => {
    writeCleanProject();
    write(
      "vitest.config.ts",
      "export default {\n  // perFile: true would be better\n  test: { coverage: { thresholds: { perFile: false } } },\n};\n",
    );
    expect(ids(grade(), "rubric")).toEqual(["coverage-gate:vitest.config.ts"]);
  });

  it("toolchain-pin-shape: missing and unpinned packages and an unpinned package manager each warn", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      const deps = pkg["devDependencies"] as Record<string, string>;
      delete deps["typescript-eslint"];
      deps["vitest"] = "latest";
      delete pkg["packageManager"];
    });
    expect(ids(grade(), "rubric")).toEqual([
      "toolchain-pin-shape:package.json",
      "toolchain-pin-shape:typescript-eslint",
      "toolchain-pin-shape:vitest",
    ]);
  });

  it("toolchain-pin-shape: never judges how old a pinned major is -- that is typescript-guidance's live sweep", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      const deps = pkg["devDependencies"] as Record<string, string>;
      deps["eslint"] = "^8.57.0";
      deps["typescript"] = "^4.9.5";
    });
    expect(idsFor("toolchain-pin-shape")).toEqual([]);
  });

  it("toolchain-pin-shape: @types/node must match the pinned Node major", () => {
    writeCleanProject();
    editJson("package.json", (pkg) => {
      (pkg["devDependencies"] as Record<string, string>)["@types/node"] =
        "^22.0.0";
    });
    expect(ids(grade(), "rubric")).toEqual(["toolchain-pin-shape:@types/node"]);
  });

  it("toolchain-pin-shape: vitest is only graded when the project uses it", () => {
    writeCleanProject();
    rmSync(join(root, "vitest.config.ts"));
    editJson("package.json", (pkg) => {
      delete (pkg["devDependencies"] as Record<string, string>)["vitest"];
    });
    expect(ids(grade(), "rubric")).toEqual([]);
  });

  it("toolchain-pin-shape: an unparseable package.json is not judged", () => {
    writeCleanProject();
    write("package.json", "{oops");
    expect(
      grade().findings.filter((f) => f.ruleId === "toolchain-pin-shape"),
    ).toEqual([]);
  });
});

describe("tallies", () => {
  it("counts rubric checks per category and scores 1 - failed/checked", () => {
    writeCleanProject();
    write("vitest.config.ts", "export default { test: {} };\n");
    const result = grade();
    expect(result.rubric.testing).toEqual({ checked: 2, failed: 2 });
    const checked = Object.values(result.rubric).reduce(
      (sum, tally) => sum + tally.checked,
      0,
    );
    expect(result.rubricScore).toBeCloseTo(1 - 2 / checked);
  });
});

describe("the real templates/core tree", () => {
  it("grades with zero findings of either kind", () => {
    const result = gradeToolchain(templatesCoreDir);
    expect(result.findings, JSON.stringify(result.findings, null, 2)).toEqual(
      [],
    );
    expect(result.structural.checked).toBeGreaterThan(20);
    expect(result.rubricScore).toBe(1);
  });

  it("carries every rule once, structural rules first", () => {
    const rules = RULES.map((rule) => rule.id);
    expect(new Set(rules).size).toBe(rules.length);
    const firstRubric = RULES.findIndex((rule) => rule.level === "rubric");
    expect(
      RULES.slice(firstRubric).every((rule) => rule.level === "rubric"),
    ).toBe(true);
  });
});
