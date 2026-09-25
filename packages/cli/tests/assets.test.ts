// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  escapeDotfileName,
  resolveAsset,
  restoreDotfileName,
  restoreDotfilePath,
} from "../src/assets.js";

const PATHS = { repo: "templates/core", local: "templates/core" };

describe("resolveAsset", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "assets-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A source checkout: markers at the root, a module dir at `packages/cli/src`. */
  function makeCheckout(name = "m3l-groundwork"): string {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
    const fromDir = join(root, "packages", "cli", "src");
    mkdirSync(fromDir, { recursive: true });
    return fromDir;
  }

  /** An installed tarball: a module dir at `node_modules/@scope/pkg/dist`. */
  function makeInstalled(): { fromDir: string; pkgRoot: string } {
    const pkgRoot = join(root, "node_modules", "@scope", "pkg");
    const fromDir = join(pkgRoot, "dist");
    mkdirSync(fromDir, { recursive: true });
    return { fromDir, pkgRoot };
  }

  it("returns the repo-relative path in a source checkout", () => {
    const fromDir = makeCheckout();

    expect(resolveAsset(PATHS, fromDir)).toBe(join(root, "templates", "core"));
  });

  it("uses the repo path even when the asset is named differently in the tarball", () => {
    const fromDir = makeCheckout();

    expect(
      resolveAsset({ repo: "packages/plugin", local: "plugin" }, fromDir),
    ).toBe(join(root, "packages", "plugin"));
  });

  it("returns the vendored copy beside dist/ in a published layout", () => {
    const { fromDir, pkgRoot } = makeInstalled();
    mkdirSync(join(pkgRoot, "templates", "core"), { recursive: true });

    expect(resolveAsset(PATHS, fromDir)).toBe(
      join(pkgRoot, "templates", "core"),
    );
  });

  it("prefers the checkout over a stale vendored copy left by a crashed pack", () => {
    const fromDir = makeCheckout();
    mkdirSync(join(root, "packages", "cli", "templates", "core"), {
      recursive: true,
    });

    expect(resolveAsset(PATHS, fromDir)).toBe(join(root, "templates", "core"));
  });

  it("does not mistake a consumer project for the checkout", () => {
    // An unscoped install lands three hops up on the consumer's own root:
    // it has a pnpm workspace and a package.json, but not our name.
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), '{"name":"someones-app"}');
    mkdirSync(join(root, "templates", "core"), { recursive: true });
    const pkgRoot = join(root, "node_modules", "m3l-groundwork");
    const fromDir = join(pkgRoot, "dist");
    mkdirSync(fromDir, { recursive: true });
    mkdirSync(join(pkgRoot, "templates", "core"), { recursive: true });

    expect(resolveAsset(PATHS, fromDir)).toBe(
      join(pkgRoot, "templates", "core"),
    );
  });

  it("requires both markers: a workspace file alone is not the checkout", () => {
    const { fromDir } = makeInstalled();
    writeFileSync(
      join(root, "node_modules", "pnpm-workspace.yaml"),
      "packages: []\n",
    );

    expect(() => resolveAsset(PATHS, fromDir)).toThrow(/cannot locate/);
  });

  it("treats an unparseable package.json as not the checkout", () => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), "{ not json");
    const fromDir = join(root, "packages", "cli", "src");
    mkdirSync(fromDir, { recursive: true });

    expect(() => resolveAsset(PATHS, fromDir)).toThrow(/cannot locate/);
  });

  it("treats a non-object package.json as not the checkout", () => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), "null");
    const fromDir = join(root, "packages", "cli", "src");
    mkdirSync(fromDir, { recursive: true });

    expect(() => resolveAsset(PATHS, fromDir)).toThrow(/cannot locate/);
  });

  it("names the missing asset and the vendoring script when neither layout has it", () => {
    const { fromDir } = makeInstalled();

    expect(() => resolveAsset(PATHS, fromDir)).toThrow(
      /cannot locate "templates\/core".*vendor-assets\.mjs/,
    );
  });

  it("defaults to this module's own directory, resolving the real checkout", () => {
    // Runs from packages/cli/src, so this exercises the real default.
    expect(resolveAsset(PATHS)).toMatch(/templates[\\/]core$/);
  });
});

describe("dotfile escaping", () => {
  it("escapes exactly the names npm-family tooling strips", () => {
    expect(escapeDotfileName(".gitignore")).toBe("_gitignore");
    expect(escapeDotfileName(".npmrc")).toBe("_npmrc");
    expect(escapeDotfileName(".npmignore")).toBe("_npmignore");
  });

  it("leaves every other name alone", () => {
    expect(escapeDotfileName(".prettierrc.json")).toBe(".prettierrc.json");
    expect(escapeDotfileName("package.json")).toBe("package.json");
    expect(escapeDotfileName("gitignore")).toBe("gitignore");
  });

  it("round-trips each escaped name", () => {
    for (const name of [".gitignore", ".npmrc", ".npmignore"]) {
      expect(restoreDotfileName(escapeDotfileName(name))).toBe(name);
    }
  });

  it("does not restore an underscore name that is not an escape", () => {
    expect(restoreDotfileName("_something")).toBe("_something");
    expect(restoreDotfileName("_prettierrc")).toBe("_prettierrc");
    expect(restoreDotfileName("plain")).toBe("plain");
  });

  it("restores only the final segment of a path", () => {
    expect(restoreDotfilePath("_gitignore")).toBe(".gitignore");
    expect(restoreDotfilePath("sub/dir/_npmrc")).toBe("sub/dir/.npmrc");
    expect(restoreDotfilePath("sub\\dir\\_npmrc")).toBe("sub\\dir\\.npmrc");
    expect(restoreDotfilePath("_gitignore/keep.txt")).toBe(
      "_gitignore/keep.txt",
    );
  });
});
