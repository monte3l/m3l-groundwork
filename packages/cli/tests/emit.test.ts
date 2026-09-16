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
import { emitTemplate } from "../src/emit.js";

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
