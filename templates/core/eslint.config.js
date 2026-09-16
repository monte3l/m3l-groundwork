// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import tsdoc from "eslint-plugin-tsdoc";
import globals from "globals";

const CJS_DIRNAME = "__dir" + "name";
const CJS_FILENAME = "__file" + "name";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // .claude/agents|skills|rules contain only docs (prompts, reference
      // data a skill reads, not code this project executes); hooks are the
      // only code under .claude/ and stay linted below.
      ".claude/agents/**",
      ".claude/skills/**",
      ".claude/rules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
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
          allowDefaultProject: ["vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver()],
    },
    rules: {
      // --- ESM correctness: the #1 documented gotcha ---------------------
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
    files: ["src/**/*.ts"],
    plugins: { tsdoc },
    rules: {
      "tsdoc/syntax": "warn",
      "import-x/no-default-export": "error",
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["bin/**/*.mjs", ".claude/hooks/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "import-x/no-unresolved": "off",
    },
  },
);
