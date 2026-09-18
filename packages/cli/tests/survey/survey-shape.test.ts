import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyShape } from "../../src/survey/survey-shape.js";

describe("surveyShape", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shape-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports unknown/none/unspecified/unknown for a directory with no package.json", () => {
    const survey = surveyShape(dir);
    expect(survey.packageManager).toBe("unknown");
    expect(survey.monorepoTool).toBe("none");
    expect(survey.moduleType).toBe("unspecified");
    expect(survey.typescriptVersion).toBeUndefined();
    expect(survey.nodeVersionPin).toBeUndefined();
    expect(survey.sourceLayout).toBe("unknown");
    expect(survey.testPlacement).toBe("unknown");
    expect(survey.kindEvidence).toEqual({
      hasExportsMap: false,
      hasBinField: false,
      hasMainField: false,
      frameworkDeps: [],
    });
  });

  it("detects each package manager from its lockfile", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(surveyShape(dir).packageManager).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    writeFileSync(join(dir, "yarn.lock"), "");
    expect(surveyShape(dir).packageManager).toBe("yarn");
  });

  it("detects bun from bun.lockb", () => {
    writeFileSync(join(dir, "bun.lockb"), "");
    expect(surveyShape(dir).packageManager).toBe("bun");
  });

  it("detects npm from package-lock.json", () => {
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(surveyShape(dir).packageManager).toBe("npm");
  });

  it("detects pnpm workspaces and extracts member globs", () => {
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n  - "apps/*"\n',
    );
    const survey = surveyShape(dir);
    expect(survey.monorepoTool).toBe("pnpm-workspaces");
    expect(survey.workspaceGlobs).toEqual(["packages/*", "apps/*"]);
  });

  it("detects turbo, nx, and lerna by config file presence", () => {
    writeFileSync(join(dir, "turbo.json"), "{}");
    expect(surveyShape(dir).monorepoTool).toBe("turbo");
  });

  it("detects npm workspaces from package.json's workspaces array", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const survey = surveyShape(dir);
    expect(survey.monorepoTool).toBe("npm-workspaces");
    expect(survey.workspaceGlobs).toEqual(["packages/*"]);
  });

  it("reads module type, typescript version, and kind evidence from package.json", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        type: "module",
        devDependencies: { typescript: "^5.4.0" },
        exports: { ".": "./dist/index.js" },
        bin: { foo: "./bin/foo.js" },
        dependencies: { express: "^4.0.0" },
      }),
    );
    const survey = surveyShape(dir);
    expect(survey.moduleType).toBe("module");
    expect(survey.typescriptVersion).toBe("^5.4.0");
    expect(survey.kindEvidence.hasExportsMap).toBe(true);
    expect(survey.kindEvidence.hasBinField).toBe(true);
    expect(survey.kindEvidence.hasMainField).toBe(false);
    expect(survey.kindEvidence.frameworkDeps).toEqual(["express"]);
  });

  it("reports commonjs module type explicitly", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    expect(surveyShape(dir).moduleType).toBe("commonjs");
  });

  it("falls back to dependencies for the typescript version when absent from devDependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { typescript: "5.0.0" } }),
    );
    expect(surveyShape(dir).typescriptVersion).toBe("5.0.0");
  });

  it("tolerates a package.json that fails to parse", () => {
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(surveyShape(dir).moduleType).toBe("unspecified");
  });

  it("prefers .node-version, then .nvmrc, then engines.node", () => {
    writeFileSync(join(dir, ".node-version"), "24\n");
    expect(surveyShape(dir).nodeVersionPin).toEqual({
      source: ".node-version",
      value: "24",
    });
  });

  it("falls back to .nvmrc when .node-version is absent", () => {
    writeFileSync(join(dir, ".nvmrc"), "20\n");
    expect(surveyShape(dir).nodeVersionPin).toEqual({
      source: ".nvmrc",
      value: "20",
    });
  });

  it("falls back to package.json engines.node", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ engines: { node: ">=18" } }),
    );
    expect(surveyShape(dir).nodeVersionPin).toEqual({
      source: "package.json#engines.node",
      value: ">=18",
    });
  });

  it("detects a src/ source layout over lib/ and root", () => {
    mkdirSync(join(dir, "src"));
    expect(surveyShape(dir).sourceLayout).toBe("src");
  });

  it("detects a lib/ source layout when src/ is absent", () => {
    mkdirSync(join(dir, "lib"));
    expect(surveyShape(dir).sourceLayout).toBe("lib");
  });

  it("detects a root source layout from a loose .ts file", () => {
    writeFileSync(join(dir, "index.ts"), "export {};");
    expect(surveyShape(dir).sourceLayout).toBe("root");
  });

  it("detects a tests/ directory over colocated tests", () => {
    mkdirSync(join(dir, "tests"));
    expect(surveyShape(dir).testPlacement).toBe("tests-dir");
  });

  it("detects colocated tests when no tests/ or test/ directory exists", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "foo.test.ts"), "");
    expect(surveyShape(dir).testPlacement).toBe("colocated");
  });
});
