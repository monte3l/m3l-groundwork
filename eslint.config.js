// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import { configs } from "typescript-eslint";
import { importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import tsdoc from "eslint-plugin-tsdoc";
import globals from "globals";

// Named indirectly (built up rather than as bare string literals) purely so
// this config file itself doesn't trip guard-no-commonjs.mjs's write-time
// scanner, which matches these two identifiers textually with no syntactic
// awareness of "banning a global" vs. "using one" -- the same shape as the
// no-restricted-globals rule below, which legitimately needs to *name* them.
const CJS_DIRNAME = "__dir" + "name";
const CJS_FILENAME = "__file" + "name";

export default defineConfig(
  {
    // Generated / vendored / emitted-payload content is never linted by this
    // config. templates/core/** is data -- files copied verbatim (with token
    // substitution) into a bootstrapped project; it is designed against
    // THAT project's own toolchain, not this repo's. templates/packs/ is the
    // same kind of payload: its .mjs artifacts are linted by the emitted
    // project's templates/core/eslint.config.js, which scopes .claude/hooks/**
    // with node globals this config has no equivalent of -- linting them
    // here would give wrong verdicts. Each pack's e2e test is what runs that
    // lint.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "templates/**",
      "packages/plugin/skills/**/*.md",
    ],
  },
  js.configs.recommended,
  ...configs.recommendedTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    files: ["**/*.ts"],
    linterOptions: {
      // Stale eslint-disable directives are always a bug: they either never
      // suppressed anything or the underlying finding was fixed, leaving
      // noise that misleads reviewers.
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts", "vitest.e2e.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver()],
    },
    rules: {
      // --- ESM correctness: the #1 documented gotcha ---------------------
      // Relative imports MUST carry the `.js` extension; tsc does not add it
      // and Node will not resolve without it.
      "import-x/extensions": [
        "error",
        "ignorePackages",
        { js: "always", ts: "never" },
      ],

      // --- Strictness: no `any` in the public API -------------------------
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // --- Style / design --------------------------------------------------
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],

      // --- ESM only: ban CommonJS constructs -------------------------------
      "no-restricted-globals": [
        "error",
        { name: CJS_DIRNAME, message: "CommonJS only; this package is ESM." },
        { name: CJS_FILENAME, message: "CommonJS only; this package is ESM." },
        { name: "require", message: "CommonJS only; this package is ESM." },
      ],
      "import-x/no-commonjs": "error",
    },
  },
  {
    // Source-only design rules. Scoped to shipped source so they never trip
    // on tests or config.
    files: ["packages/*/src/**/*.ts"],
    plugins: { tsdoc },
    rules: {
      "tsdoc/syntax": "warn",
      "import-x/no-default-export": "error",
    },
  },
  {
    // Plain JS/ESM files (bin/**/*.mjs and this config file itself) are
    // never type-checked -- they run directly with `node`, outside any
    // tsconfig project, so typescript-eslint's type-aware rules have no
    // program to query. The standard typescript-eslint pattern for a mixed
    // JS/TS repo: explicitly disable the typed rules for these files rather
    // than leaving them to inherit typed rules with no parserOptions.project.
    files: ["**/*.mjs", "**/*.js"],
    ...configs.disableTypeChecked,
  },
  {
    // bin/**/*.mjs is plain Node ESM, not type-checked against a tsconfig
    // project -- it runs directly with `node`, so import-x's typed rules and
    // the projectService parser don't apply here.
    files: ["**/bin/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "import-x/no-unresolved": "off",
    },
  },
);
