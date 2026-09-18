import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyToolchain } from "../../src/survey/survey-toolchain.js";

describe("surveyToolchain", () => {
  let dir: string;
  let undetermined: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-"));
    undetermined = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports empty/unknown results for a bare directory", () => {
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.tsconfig).toEqual({
      files: [],
      effectiveFlags: {},
      parsed: false,
    });
    expect(survey.eslint).toEqual({
      configFile: undefined,
      flat: false,
      referencedPlugins: [],
    });
    expect(survey.testRunner).toEqual({
      tool: "unknown",
      configFile: undefined,
    });
    expect(survey.formatter).toEqual({
      tool: "unknown",
      configFile: undefined,
    });
    expect(survey.gitHooks).toEqual({
      manager: "none",
      configFile: undefined,
      needsReading: false,
    });
    expect(survey.workflows).toEqual({ files: [], needsReading: false });
    expect(survey.scripts).toEqual({});
  });

  it("resolves a single tsconfig's strict flags with no extends", () => {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noImplicitReturns: true },
      }),
    );
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.tsconfig.parsed).toBe(true);
    expect(survey.tsconfig.files).toEqual([join(dir, "tsconfig.json")]);
    expect(survey.tsconfig.effectiveFlags).toEqual({
      strict: true,
      noImplicitReturns: true,
    });
  });

  it("follows an extends chain and lets the child override the parent", () => {
    writeFileSync(
      join(dir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { strict: true, verbatimModuleSyntax: true },
      }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { strict: false },
      }),
    );
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.tsconfig.files).toHaveLength(2);
    expect(survey.tsconfig.effectiveFlags["strict"]).toBe(false);
    expect(survey.tsconfig.effectiveFlags["verbatimModuleSyntax"]).toBe(true);
  });

  it("tolerates JSONC comments and trailing commas in tsconfig", () => {
    writeFileSync(
      join(dir, "tsconfig.json"),
      '{\n  // a comment\n  "compilerOptions": { "strict": true, },\n}',
    );
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.tsconfig.effectiveFlags["strict"]).toBe(true);
  });

  it("records an unparseable tsconfig chain member as undetermined", () => {
    writeFileSync(join(dir, "tsconfig.json"), "{not json");
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.tsconfig.parsed).toBe(false);
    expect(undetermined.some((entry) => entry.includes("tsconfig.json"))).toBe(
      true,
    );
  });

  it("detects a flat eslint config and its referenced plugins", () => {
    writeFileSync(
      join(dir, "eslint.config.js"),
      'import tseslint from "typescript-eslint";\nimport importX from "eslint-plugin-import-x";\n',
    );
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.eslint.flat).toBe(true);
    expect(survey.eslint.configFile).toBe("eslint.config.js");
    expect(survey.eslint.referencedPlugins).toContain("eslint-plugin-import-x");
  });

  it("detects a legacy .eslintrc config", () => {
    writeFileSync(
      join(dir, ".eslintrc.cjs"),
      "module.exports = { extends: [] };",
    );
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.eslint.flat).toBe(false);
    expect(survey.eslint.configFile).toBe(".eslintrc.cjs");
  });

  it("detects vitest, jest, mocha, and node's own test runner", () => {
    writeFileSync(join(dir, "vitest.config.ts"), "");
    expect(surveyToolchain(dir, undetermined).testRunner).toEqual({
      tool: "vitest",
      configFile: "vitest.config.ts",
    });
  });

  it("detects jest via its config file", () => {
    const jestDir = mkdtempSync(join(tmpdir(), "toolchain-jest-"));
    writeFileSync(join(jestDir, "jest.config.js"), "");
    expect(surveyToolchain(jestDir, []).testRunner).toEqual({
      tool: "jest",
      configFile: "jest.config.js",
    });
    rmSync(jestDir, { recursive: true, force: true });
  });

  it("falls back to node --test in the test script", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    expect(surveyToolchain(dir, undetermined).testRunner.tool).toBe(
      "node-test",
    );
  });

  it("detects prettier and biome formatters", () => {
    writeFileSync(join(dir, ".prettierrc.json"), "{}");
    expect(surveyToolchain(dir, undetermined).formatter).toEqual({
      tool: "prettier",
      configFile: ".prettierrc.json",
    });
  });

  it("detects biome when prettier is absent", () => {
    const biomeDir = mkdtempSync(join(tmpdir(), "toolchain-biome-"));
    writeFileSync(join(biomeDir, "biome.json"), "{}");
    expect(surveyToolchain(biomeDir, []).formatter).toEqual({
      tool: "biome",
      configFile: "biome.json",
    });
    rmSync(biomeDir, { recursive: true, force: true });
  });

  it("detects lefthook and flags it as needing a real read", () => {
    writeFileSync(join(dir, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.gitHooks).toEqual({
      manager: "lefthook",
      configFile: "lefthook.yml",
      needsReading: true,
    });
    expect(undetermined.some((entry) => entry.includes("lefthook.yml"))).toBe(
      true,
    );
  });

  it("detects husky and simple-git-hooks", () => {
    mkdirSync(join(dir, ".husky"));
    expect(surveyToolchain(dir, undetermined).gitHooks.manager).toBe("husky");
  });

  it("detects simple-git-hooks by its config file", () => {
    const sghDir = mkdtempSync(join(tmpdir(), "toolchain-sgh-"));
    writeFileSync(join(sghDir, "simple-git-hooks.json"), "{}");
    expect(surveyToolchain(sghDir, []).gitHooks.manager).toBe(
      "simple-git-hooks",
    );
    rmSync(sghDir, { recursive: true, force: true });
  });

  it("indexes workflow files and flags them as needing a real read", () => {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
    const survey = surveyToolchain(dir, undetermined);
    expect(survey.workflows).toEqual({ files: ["ci.yml"], needsReading: true });
    expect(undetermined.some((entry) => entry.includes("workflow"))).toBe(true);
  });

  it("extracts the scripts block, skipping non-string entries", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", weird: 5 } }),
    );
    expect(surveyToolchain(dir, undetermined).scripts).toEqual({
      build: "tsc",
    });
  });

  it("tolerates a package.json that fails to parse", () => {
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(surveyToolchain(dir, undetermined).scripts).toEqual({});
  });
});
