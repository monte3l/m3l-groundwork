import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMode, resolveMode } from "../src/mode.js";

describe("detectMode", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mode-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects fresh for a missing directory", () => {
    const missing = join(dir, "does-not-exist");
    expect(detectMode(missing)).toEqual({
      mode: "fresh",
      signal: `${missing} does not exist yet`,
    });
  });

  it("detects fresh for an empty directory", () => {
    expect(detectMode(dir)).toEqual({
      mode: "fresh",
      signal: `${dir} is empty`,
    });
  });

  it("detects adopt when package.json is present", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(detectMode(dir)).toEqual({
      mode: "adopt",
      signal: "found package.json",
    });
  });

  it("detects adopt when a .git directory is present", () => {
    mkdirSync(join(dir, ".git"));
    expect(detectMode(dir)).toEqual({
      mode: "adopt",
      signal: "found a .git directory",
    });
  });

  it("detects adopt when a loose .ts file is present", () => {
    writeFileSync(join(dir, "index.ts"), "export {};");
    expect(detectMode(dir)).toEqual({
      mode: "adopt",
      signal: "found index.ts",
    });
  });

  it("detects adopt when a loose .js file is present", () => {
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    expect(detectMode(dir)).toEqual({
      mode: "adopt",
      signal: "found index.js",
    });
  });

  it("falls back to fresh when a non-empty directory has no recognizable markers", () => {
    writeFileSync(join(dir, "notes.txt"), "hi");
    expect(detectMode(dir)).toEqual({
      mode: "fresh",
      signal: `${dir} exists but has no recognizable project markers`,
    });
  });
});

describe("resolveMode", () => {
  const detected = { mode: "fresh", signal: "irrelevant" } as const;

  it("passes through the detected mode when no flags are set", () => {
    expect(resolveMode(detected, { adopt: false, fresh: false })).toEqual(
      detected,
    );
  });

  it("forces adopt when --adopt is passed", () => {
    expect(resolveMode(detected, { adopt: true, fresh: false })).toEqual({
      mode: "adopt",
      signal: "--adopt forced",
    });
  });

  it("forces fresh when --fresh is passed", () => {
    expect(resolveMode(detected, { adopt: false, fresh: true })).toEqual({
      mode: "fresh",
      signal: "--fresh forced",
    });
  });

  it("throws when both --adopt and --fresh are passed", () => {
    expect(() => resolveMode(detected, { adopt: true, fresh: true })).toThrow(
      /mutually exclusive/,
    );
  });
});
