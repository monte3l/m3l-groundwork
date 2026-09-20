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
    write(
      "tsconfig.json",
      JSON.stringify({
        extends: ["./tsconfig.base.json", "./missing.json", "@acme/base"],
      }),
    );
    write(
      "tsconfig.build.json",
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );
    write("tsconfig.broken.json", "{oops");
    write(".eslintrc.json", "{}");
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

    const twin = plain(emitted.gradeToolchain(root)) as {
      findings: unknown[];
    };
    expect(twin.findings.length).toBeGreaterThan(10);
    expect(twin).toEqual(plain(gradeToolchain(root)));
  });

  it("produce identical grades for a shared-config ESLint project on an array extends", () => {
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
    expect(plain(emitted.gradeToolchain(root))).toEqual(
      plain(gradeToolchain(root)),
    );
  });
});
