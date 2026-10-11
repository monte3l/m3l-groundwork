// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTar, makeTgz } from "./tarball-fixture.js";

const binDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
);

const { readTarballManifest, readTarballReadme } = (await import(
  pathToFileURL(join(binDir, "lib", "read-tarball-manifest.mjs")).href
)) as {
  readTarballManifest: (buf: Buffer) => unknown;
  readTarballReadme: (
    buf: Buffer,
  ) => { filename: string; content: string } | undefined;
};

const manifest = { name: "@scope/name", version: "1.2.3" };

describe("readTarballManifest", () => {
  it("returns the parsed package/package.json", () => {
    const tgz = makeTgz([
      ["package/README.md", "hello"],
      ["package/package.json", JSON.stringify(manifest)],
    ]);
    expect(readTarballManifest(tgz)).toEqual(manifest);
  });

  it("finds package.json after a body spanning several blocks", () => {
    const tgz = makeTgz([
      ["package/big.txt", "x".repeat(1500)],
      ["package/package.json", JSON.stringify(manifest)],
    ]);
    expect(readTarballManifest(tgz)).toEqual(manifest);
  });

  it("ignores a nested package.json and one outside a top-level directory", () => {
    const tgz = makeTgz([
      ["package/node_modules/x/package.json", '{"name":"nested"}'],
      ["package.json", '{"name":"flat"}'],
    ]);
    expect(() => readTarballManifest(tgz)).toThrow(/no package\/package\.json/);
  });

  it("throws when the tarball has no package.json", () => {
    const tgz = makeTgz([["package/index.js", "1"]]);
    expect(() => readTarballManifest(tgz)).toThrow(/no package\/package\.json/);
  });

  it("throws on an empty archive", () => {
    expect(() => readTarballManifest(gzipSync(Buffer.alloc(1024)))).toThrow(
      /no package\/package\.json/,
    );
  });

  it("throws when the input is not gzip", () => {
    expect(() => readTarballManifest(Buffer.from("not a tarball"))).toThrow(
      /not valid gzip/,
    );
  });

  it("throws when package.json is not valid JSON", () => {
    const tgz = makeTgz([["package/package.json", "{nope"]]);
    expect(() => readTarballManifest(tgz)).toThrow(/not valid JSON/);
  });

  it("throws when the archive is truncated inside package.json", () => {
    const tar = makeTar([["package/package.json", JSON.stringify(manifest)]]);
    const truncated = gzipSync(tar.subarray(0, 512 + 5));
    expect(() => readTarballManifest(truncated)).toThrow(/truncated/);
  });

  it("throws on a corrupt size field", () => {
    const tar = makeTar([["package/package.json", "{}"]]);
    tar.write("zzzzzzzzzzz\0", 124, "ascii");
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/bad size/);
  });

  it("throws on a truncated gzip stream", () => {
    const tgz = makeTgz([["package/package.json", JSON.stringify(manifest)]]);
    expect(() => readTarballManifest(tgz.subarray(0, tgz.length - 10))).toThrow(
      Error,
    );
  });
});

describe("readTarballReadme", () => {
  const pkg: [string, string] = ["package/package.json", "{}"];

  it("returns the README.md name and content", () => {
    const tgz = makeTgz([pkg, ["package/README.md", "# hi"]]);
    expect(readTarballReadme(tgz)).toEqual({
      filename: "README.md",
      content: "# hi",
    });
  });

  it("matches README.md case-insensitively", () => {
    const tgz = makeTgz([pkg, ["package/readme.MD", "lower"]]);
    expect(readTarballReadme(tgz)).toEqual({
      filename: "readme.MD",
      content: "lower",
    });
  });

  it("prefers README.md over an earlier README.txt", () => {
    const tgz = makeTgz([
      pkg,
      ["package/README.txt", "txt"],
      ["package/README", "bare"],
      ["package/README.md", "md"],
    ]);
    expect(readTarballReadme(tgz)).toEqual({
      filename: "README.md",
      content: "md",
    });
  });

  it("falls back to another README variant", () => {
    expect(
      readTarballReadme(makeTgz([pkg, ["package/README.txt", "txt"]])),
    ).toEqual({ filename: "README.txt", content: "txt" });
    expect(
      readTarballReadme(makeTgz([pkg, ["package/README", "bare"]])),
    ).toEqual({ filename: "README", content: "bare" });
  });

  it("returns undefined when there is no README", () => {
    expect(readTarballReadme(makeTgz([pkg]))).toBeUndefined();
  });

  it("ignores a nested README and unrelated names", () => {
    const tgz = makeTgz([
      pkg,
      ["package/docs/README.md", "nested"],
      ["package/READMEFIRST.md", "other"],
    ]);
    expect(readTarballReadme(tgz)).toBeUndefined();
  });

  it("throws when the input is not gzip", () => {
    expect(() => readTarballReadme(Buffer.from("nope"))).toThrow(
      /not valid gzip/,
    );
  });

  it("throws on a corrupt size field", () => {
    const tar = makeTar([["package/README.md", "x"]]);
    tar.write("zzzzzzzzzzz\0", 124, "ascii");
    expect(() => readTarballReadme(gzipSync(tar))).toThrow(/bad size/);
  });

  it("throws when the archive is truncated inside the README", () => {
    const tar = makeTar([["package/README.md", "hello"]]);
    expect(() => readTarballReadme(gzipSync(tar.subarray(0, 512 + 2)))).toThrow(
      /truncated/,
    );
  });
});
