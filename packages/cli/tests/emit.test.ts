// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTemplate, isPathContained } from "../src/emit.js";

describe("emitTemplate", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "emit-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "emit-target-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("copies a flat file, substituting a content token", () => {
    writeFileSync(
      join(sourceDir, "package.json"),
      '{"name":"__PROJECT_NAME__"}',
    );

    const result = emitTemplate(sourceDir, targetDir, { PROJECT_NAME: "acme" });

    expect(result.filesWritten).toEqual(["package.json"]);
    expect(readFileSync(join(targetDir, "package.json"), "utf8")).toBe(
      '{"name":"acme"}',
    );
  });

  it("recreates nested directory structure", () => {
    mkdirSync(join(sourceDir, "src", "nested"), { recursive: true });
    writeFileSync(join(sourceDir, "src", "nested", "file.ts"), "export {};");

    emitTemplate(sourceDir, targetDir, {});

    expect(existsSync(join(targetDir, "src", "nested", "file.ts"))).toBe(true);
  });

  it("writes a vendored _gitignore/_npmrc under their real dotfile names", () => {
    writeFileSync(join(sourceDir, "_gitignore"), "node_modules/\n");
    writeFileSync(join(sourceDir, "_npmrc"), "engine-strict=true\n");

    const result = emitTemplate(sourceDir, targetDir, {});

    expect(result.filesWritten.sort()).toEqual([".gitignore", ".npmrc"]);
    expect(readFileSync(join(targetDir, ".gitignore"), "utf8")).toBe(
      "node_modules/\n",
    );
    expect(existsSync(join(targetDir, "_gitignore"))).toBe(false);
  });

  it("substitutes a token appearing in a path segment", () => {
    mkdirSync(join(sourceDir, "__PROJECT_NAME__"), { recursive: true });
    writeFileSync(join(sourceDir, "__PROJECT_NAME__", "readme.md"), "hi");

    emitTemplate(sourceDir, targetDir, { PROJECT_NAME: "acme" });

    expect(existsSync(join(targetDir, "acme", "readme.md"))).toBe(true);
  });

  it("copies a binary-extension file byte-for-byte, without token substitution", () => {
    writeFileSync(
      join(sourceDir, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    emitTemplate(sourceDir, targetDir, { PROJECT_NAME: "acme" });

    const written = readFileSync(join(targetDir, "logo.png"));
    expect(written).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe("isPathContained", () => {
  it("rejects a sibling path that merely shares root's name as a string prefix", () => {
    expect(isPathContained("/foo/bar-evil/x", "/foo/bar")).toBe(false);
  });

  it("accepts a genuine child of root", () => {
    expect(isPathContained("/foo/bar/x", "/foo/bar")).toBe(true);
  });

  it("accepts target equal to root", () => {
    expect(isPathContained("/foo/bar", "/foo/bar")).toBe(true);
  });
});
