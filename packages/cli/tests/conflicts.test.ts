import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";

describe("planConflicts", () => {
  let templateRoot: string;
  let targetDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-target-"));
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("reports absent for a file the target doesn't have", () => {
    writeFileSync(join(templateRoot, "CLAUDE.md"), "# __PROJECT_NAME__\n");
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result).toEqual([
      { relPath: "CLAUDE.md", status: "absent", keyDiffs: undefined },
    ]);
  });

  it("reports identical for a whole-file match after token substitution", () => {
    writeFileSync(join(templateRoot, "README.md"), "# __PROJECT_NAME__\n");
    writeFileSync(join(targetDir, "README.md"), "# acme\n");
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result).toEqual([
      { relPath: "README.md", status: "identical", keyDiffs: undefined },
    ]);
  });

  it("reports divergent for a whole-file mismatch", () => {
    writeFileSync(join(templateRoot, "README.md"), "# __PROJECT_NAME__\n");
    writeFileSync(join(targetDir, "README.md"), "# something else\n");
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result[0]?.status).toBe("divergent");
  });

  it("compares package.json at the key level", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({
        name: "__PROJECT_NAME__",
        type: "module",
        scripts: { build: "tsc" },
      }),
    );
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify({
        name: "acme",
        type: "commonjs",
        scripts: { build: "tsc" },
      }),
    );
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result[0]?.status).toBe("divergent");
    expect(result[0]?.keyDiffs).toEqual(["type"]);
  });

  it("reports package.json identical when every key matches after substitution", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "__PROJECT_NAME__" }),
    );
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify({ name: "acme" }),
    );
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result[0]).toEqual({
      relPath: "package.json",
      status: "identical",
      keyDiffs: [],
    });
  });

  it("compares a nested tsconfig*.json at the key level too", () => {
    writeFileSync(
      join(templateRoot, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(
      join(targetDir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result[0]?.keyDiffs).toEqual(["compilerOptions"]);
  });

  it("falls back to a whole-file compare when the target's JSON fails to parse", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    writeFileSync(join(targetDir, "package.json"), "{not json");
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result[0]?.status).toBe("divergent");
    expect(result[0]?.keyDiffs).toBeUndefined();
  });

  it("walks nested directories and substitutes tokens in path segments", () => {
    mkdirSync(join(templateRoot, "__PROJECT_NAME__", "nested"), {
      recursive: true,
    });
    writeFileSync(
      join(templateRoot, "__PROJECT_NAME__", "nested", "file.ts"),
      "export {};",
    );
    const result = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(result).toEqual([
      { relPath: "acme/nested/file.ts", status: "absent", keyDiffs: undefined },
    ]);
  });

  it("falls back to a whole-file compare rather than crashing when the target's JSON parses to a non-object (null)", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    // "null" is valid JSON (parseJsonc succeeds) but parses to the value
    // `null`, not an object -- compareJsonKeys must not blindly cast this to
    // Record<string, unknown> and call Object.keys() on it.
    writeFileSync(join(targetDir, "package.json"), "null");

    expect(() => planConflicts(templateRoot, targetDir, {})).not.toThrow();

    const result = planConflicts(templateRoot, targetDir, {});
    expect(result[0]?.keyDiffs).toBeUndefined();
    expect(result[0]?.status).toBe("divergent");
  });

  it("compares a vendored _gitignore against the project's real .gitignore", () => {
    writeFileSync(join(templateRoot, "_gitignore"), "node_modules/\n");
    writeFileSync(join(targetDir, ".gitignore"), "node_modules/\n");
    const result = planConflicts(templateRoot, targetDir, {});
    expect(result).toEqual([
      { relPath: ".gitignore", status: "identical", keyDiffs: undefined },
    ]);
  });
});
