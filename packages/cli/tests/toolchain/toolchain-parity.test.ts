import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gradeToolchain } from "../../src/toolchain/grade.js";
import {
  LEGACY_OPTIONS,
  RULES,
  STRICT_FLAGS,
} from "../../src/toolchain/rules.js";
import { TOOLCHAIN_CATEGORIES } from "../../src/toolchain/types.js";

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

// The emitted twin is plain ESM under templates/, outside every tsconfig, so
// it is loaded by file URL at test time rather than imported statically.
interface EmittedRules {
  gradeToolchain: (rootDir: string) => unknown;
  RULES: { id: string; level: string; category: string }[];
  STRICT_FLAGS: string[];
  CATEGORIES: string[];
  LEGACY_OPTIONS: {
    option: string;
    label: string;
    deprecatedIn: number;
    removedIn: number;
    matches: (value: unknown) => boolean;
  }[];
}

const emitted = (await import(
  pathToFileURL(join(templatesCoreDir, "bin", "lib", "toolchain-rules.mjs"))
    .href
)) as EmittedRules;

/** Reduces to plain JSON so both grades compare structurally. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolchain-parity-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A project deliberately wrong in most of the ways the toolchain grader
 * catches. Extracted so both the parity test below and the RULES-coverage
 * assertion can grade the same fixture without duplicating it.
 *
 * `tsconfig.json`'s OWN chain (just `tsconfig.base.json`) is deliberately
 * kept complete -- unlike an earlier version of this fixture, which folded
 * an unresolved `./missing.json` and a bare `@acme/base` specifier directly
 * into `tsconfig.json`'s own extends. An incomplete primary chain makes
 * `strict-flags` and `module-target-modern` stand down entirely (see
 * `rules.ts`'s `primaryChain`), even though `tsconfig.base.json` already
 * sets values that violate both. The unresolved-extends case those two rules
 * would otherwise hide is preserved on its own, separate root config
 * (`tsconfig.other.json`) instead, so `tsconfig-extends-resolves` still
 * fires.
 *
 * `eslint.config.js` uses a single-quoted `ignores` array -- a shape the
 * JS-aware stripper (`stripJsComments`) reads safely by tracking `'`/`` ` ``
 * in addition to `"`, so a `//`/`/*` inside the `'`-quoted string never opens
 * a fake comment here; it exists so a regression in either twin's stripper
 * would show up as a parity mismatch. This file also has no
 * `typescript-eslint` import and no `bin/**` coverage block, so
 * `eslint-typed-linting` and `eslint-covers-emitted-code` both fire.
 */
function writeBrokenProject(): void {
  write(
    "package.json",
    JSON.stringify({
      scripts: { build: "tsc -b tsconfig.build.json", lint: "eslint ." },
      engines: { node: ">=24" },
      devDependencies: {
        typescript: "^5.4.0",
        eslint: "^8.57.0",
        "@types/node": "^20.0.0",
        vitest: "*",
      },
    }),
  );
  write(".node-version", "20\n");
  write(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        baseUrl: ".",
        outFile: "out.js",
        module: "commonjs",
        moduleResolution: "node",
        target: "es2015",
        ignoreDeprecations: "6.0",
      },
    }),
  );
  write("tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json" }));
  write(
    "tsconfig.other.json",
    JSON.stringify({ extends: ["./missing.json", "@acme/base"] }),
  );
  write(
    "tsconfig.build.json",
    JSON.stringify({ extends: "./tsconfig.base.json" }),
  );
  write("tsconfig.broken.json", "{oops");
  write(".eslintrc.json", "{}");
  write(
    "eslint.config.js",
    "export default [\n  { ignores: ['dist/**', 'coverage/**'] },\n];\n",
  );
  write("vitest.config.ts", "export default { test: {} };\n");
  write(
    "bin/lib/verify-steps.mjs",
    'export const GROUPS = ["lint", "test"];\nexport const CORE_STEPS = [\n  { id: "lint", group: "ship", name: "Lint", cmd: ["pnpm", "lint"] },\n  { id: "x", group: "lint", name: "X", cmd: ["node", "bin/gone.mjs"] },\n  { id: "y", group: "lint", name: "Y", cmd: ["pnpm", "run", "nope"] },\n];\n',
  );
  write("bin/lib/verify-steps.packs.json", "{oops");
  write("bin/script.mjs", "// a script\n");
  write(
    "lefthook.yml",
    "pre-push:\n  commands:\n    a:\n      run: node bin/verify.mjs --group lint\n    b:\n      run: node bin/verify.mjs --group ship # comment\n",
  );
  write(
    ".github/workflows/ci.yml",
    "# node bin/verify.mjs --group test\njobs:\n  a:\n    steps:\n      - run: node bin/verify.mjs --step lint\n",
  );
}

/**
 * A minimal project with a legacy `.eslintrc.json` and no flat config at
 * all -- the one shape `eslint-flat-config`'s failure branch needs. Every
 * other fixture in this file has a flat `eslint.config.js`, under which that
 * rule never fails (see `rules.ts`'s `eslintFlatConfig`), so without this
 * fixture the RULES-coverage assertion below finds `eslint-flat-config`
 * never exercised by anything in this file.
 */
function writeLegacyEslintOnlyProject(): void {
  write(".eslintrc.json", "{}");
}

/** A project whose ESLint config is composed through a shared package on an array `extends`. */
function writeSharedConfigProject(): void {
  write(
    "package.json",
    JSON.stringify({
      scripts: { build: "tsc" },
      devDependencies: { typescript: "workspace:*" },
    }),
  );
  write(
    "node_modules/@acme/tsconfig/tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  write(
    "tsconfig.json",
    JSON.stringify({
      extends: ["@acme/tsconfig", "./a.json"],
      compilerOptions: { noUncheckedIndexedAccess: true },
    }),
  );
  write("a.json", JSON.stringify({ compilerOptions: { target: "esnext" } }));
  write(
    "eslint.config.js",
    'import base from "@acme/eslint-config";\nexport default [...base];\n',
  );
}

describe("the TypeScript grader and its emitted .mjs twin", () => {
  it("declare the same rules, in the same order", () => {
    expect(
      emitted.RULES.map(({ id, level, category }) => ({ id, level, category })),
    ).toEqual(
      RULES.map(({ id, level, category }) => ({ id, level, category })),
    );
  });

  it("agree on every table a rule reads", () => {
    expect(emitted.STRICT_FLAGS).toEqual([...STRICT_FLAGS]);
    expect(emitted.CATEGORIES).toEqual([...TOOLCHAIN_CATEGORIES]);
    const describeRow = (row: {
      option: string;
      label: string;
      deprecatedIn: number;
      removedIn: number;
    }): unknown => ({
      option: row.option,
      label: row.label,
      deprecatedIn: row.deprecatedIn,
      removedIn: row.removedIn,
    });
    expect(emitted.LEGACY_OPTIONS.map(describeRow)).toEqual(
      LEGACY_OPTIONS.map(describeRow),
    );
  });

  it("match each legacy option on the same values", () => {
    const probes: unknown[] = [
      undefined,
      true,
      false,
      ".",
      "node",
      "Node10",
      "classic",
      "es5",
      "ES5",
      "amd",
      "systemjs",
      "none",
      "nodenext",
    ];
    for (const [index, row] of LEGACY_OPTIONS.entries()) {
      const twin = emitted.LEGACY_OPTIONS[index];
      for (const probe of probes) {
        expect(twin?.matches(probe), `${row.label} on ${String(probe)}`).toBe(
          row.matches(probe),
        );
      }
    }
  });

  it("produce identical grades for the real templates/core tree", () => {
    expect(plain(emitted.gradeToolchain(templatesCoreDir))).toEqual(
      plain(gradeToolchain(templatesCoreDir)),
    );
  });

  it("produce identical grades for an empty directory", () => {
    expect(plain(emitted.gradeToolchain(root))).toEqual(
      plain(gradeToolchain(root)),
    );
  });

  it("produce identical grades for a deliberately broken project", () => {
    writeBrokenProject();

    const twin = plain(emitted.gradeToolchain(root)) as {
      findings: unknown[];
    };
    expect(twin.findings.length).toBeGreaterThan(10);
    expect(twin).toEqual(plain(gradeToolchain(root)));
  });

  it("produce identical grades for a shared-config ESLint project on an array extends", () => {
    writeSharedConfigProject();
    expect(plain(emitted.gradeToolchain(root))).toEqual(
      plain(gradeToolchain(root)),
    );
  });

  it("every rule id RULES declares produces at least one finding across these fixtures, in both twins", () => {
    // H1: `findings.length > 10` above proves volume, not coverage -- a rule
    // whose failure branch no fixture in this file ever reaches could regress
    // silently in one twin without either parity test noticing. This walks
    // every fixture this file already uses (plus the broken project's
    // restructuring above) and asserts every declared rule id shows up on
    // BOTH twins somewhere.
    interface GradeLike {
      findings: { ruleId: string }[];
    }
    const seenTs = new Set<string>();
    const seenEmitted = new Set<string>();
    const record = (rootDir: string): void => {
      for (const f of gradeToolchain(rootDir).findings) seenTs.add(f.ruleId);
      for (const f of (emitted.gradeToolchain(rootDir) as GradeLike).findings)
        seenEmitted.add(f.ruleId);
    };

    record(templatesCoreDir); // clean baseline -- expected to add nothing

    writeBrokenProject();
    record(root);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeSharedConfigProject();
    record(root);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeLegacyEslintOnlyProject();
    record(root);

    const declared = RULES.map((rule) => rule.id);
    const missingFromTs = declared.filter((id) => !seenTs.has(id));
    const missingFromEmitted = declared.filter((id) => !seenEmitted.has(id));
    expect(
      missingFromTs,
      "TypeScript grader: rule ids never exercised",
    ).toEqual([]);
    expect(
      missingFromEmitted,
      "emitted .mjs twin: rule ids never exercised",
    ).toEqual([]);
  });

  // scrapeLaneInvocations' name:/echo exclusion and its continuation-before-
  // comment-strip ordering are copy-pasted identically into both twins, so
  // both currently misjudge these three surfaces the same way (see
  // grade.test.ts's own "[bug] gate-lane-parity" tests for what "correctly"
  // means for each). These parity tests do not assert which answer is
  // right -- grade.test.ts already does that -- only that both twins still
  // agree once a fix lands here. They pass today because both sides already
  // agree, just on the same wrong answer; that is expected, not a gap this
  // file is meant to catch.
  describe("scrapeLaneInvocations parsing agrees on both twins", () => {
    it("an `echo` log-grouping idiom before a real invocation on the same line", () => {
      write(
        "lefthook.yml",
        'pre-push:\n  commands:\n    all:\n      run: echo "::group::x" && node bin/verify.mjs --group ship\n',
      );
      expect(plain(emitted.gradeToolchain(root))).toEqual(
        plain(gradeToolchain(root)),
      );
    });

    it("`name:` and `run:` on the same YAML flow-mapping line", () => {
      write(
        ".github/workflows/ci.yml",
        "jobs:\n  a:\n    steps:\n      - { name: Lint, run: node bin/verify.mjs --group ship }\n",
      );
      expect(plain(emitted.gradeToolchain(root))).toEqual(
        plain(gradeToolchain(root)),
      );
    });

    it("a comment ending in a line continuation followed by a real invocation", () => {
      write(
        "lefthook.yml",
        "pre-push:\n  commands:\n    a:\n      run: |\n        # see C:\\\n        node bin/verify.mjs --group ship\n",
      );
      expect(plain(emitted.gradeToolchain(root))).toEqual(
        plain(gradeToolchain(root)),
      );
    });
  });
});
