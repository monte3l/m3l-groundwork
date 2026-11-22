// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fixChecksum,
  makeTar,
  makeTarEntries,
  makeTgz,
  makeTgzEntries,
} from "./tarball-fixture.js";

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
    fixChecksum(tar);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/bad size/);
  });

  it("throws on a truncated gzip stream", () => {
    const tgz = makeTgz([["package/package.json", JSON.stringify(manifest)]]);
    expect(() => readTarballManifest(tgz.subarray(0, tgz.length - 10))).toThrow(
      Error,
    );
  });
});

describe("readTarballManifest hardening", () => {
  const pkgJson = JSON.stringify(manifest);

  it("throws when package/package.json appears twice", () => {
    const tgz = makeTgz([
      ["package/package.json", pkgJson],
      ["package/package.json", '{"name":"evil","version":"9.9.9"}'],
    ]);
    expect(() => readTarballManifest(tgz)).toThrow(/duplicate|more than once/i);
  });

  it.each([
    ["x", "PAX extended header"],
    ["g", "PAX global header"],
    ["L", "GNU long name"],
    ["K", "GNU long link"],
  ])("throws on a %s typeflag entry (%s) ahead of package.json", (type) => {
    const tgz = makeTgzEntries([
      { name: "package/pax", body: "path=package/other.json\n", type },
      { name: "package/package.json", body: pkgJson },
    ]);
    expect(() => readTarballManifest(tgz)).toThrow(
      /unsupported tar entry type/,
    );
  });

  /** A header block with an empty name but a non-zero mode field, valid checksum. */
  function nonZeroNamelessBlock(): Buffer {
    const block = Buffer.alloc(512);
    block.write("0000644\0", 100, "ascii");
    fixChecksum(block);
    return block;
  }

  /** The entries' tar without its end-of-archive padding. */
  function unpadded(entries: { name: string; body: string }[]): Buffer {
    const tar = makeTarEntries(entries);
    return tar.subarray(0, tar.length - 1024);
  }

  it("throws on a nameless header block with data elsewhere, instead of ending the scan", () => {
    const tar = Buffer.concat([
      unpadded([{ name: "package/package.json", body: pkgJson }]),
      nonZeroNamelessBlock(),
      unpadded([{ name: "package/package.json", body: '{"name":"evil"}' }]),
      Buffer.alloc(1024),
    ]);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(Error);
  });

  it("still ends the scan normally at an all-zero block", () => {
    const tar = Buffer.concat([
      unpadded([{ name: "package/package.json", body: pkgJson }]),
      Buffer.alloc(1024),
    ]);
    expect(readTarballManifest(gzipSync(tar))).toEqual(manifest);
  });

  it("still ignores a symlink entry", () => {
    const tgz = makeTgzEntries([
      { name: "package/link", type: "2" },
      { name: "package/package.json", body: pkgJson },
    ]);
    expect(readTarballManifest(tgz)).toEqual(manifest);
  });

  it("throws on a size field that is only partly octal", () => {
    const tar = makeTar([["package/package.json", "{}"]]);
    tar.write("0000001238\0", 124, "ascii");
    fixChecksum(tar);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/bad size/);
  });

  it("throws on a size field with trailing garbage after the digits", () => {
    const tar = makeTar([["package/package.json", "{}"]]);
    tar.write("00000000002x\0", 124, "ascii");
    fixChecksum(tar);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/bad size/);
  });

  it("refuses a base-256 (high-bit) size rather than misreading it", () => {
    // GNU tar encodes sizes past 8 GiB as a base-256 number behind 0x80. The
    // reader does not implement that, so it must throw, never parse it as 0.
    const tar = makeTar([["package/package.json", "{}"]]);
    tar[124] = 0x80;
    tar.fill(0, 125, 135);
    tar[135] = 2;
    fixChecksum(tar);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/size/i);
  });

  it("throws when the header checksum does not match", () => {
    const tar = makeTar([["package/package.json", pkgJson]]);
    // Same-length rename of an unrelated byte, checksum field left stale. The
    // entry is still named package/package.json, so only the checksum can
    // reject it.
    tar.write("0000755", 100, "ascii"); // the mode field, outside every parsed field
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/checksum/i);
  });

  it("throws on a checksum field that is not octal", () => {
    const tar = makeTar([["package/package.json", pkgJson]]);
    tar.write("zzzzzz\0 ", 148, "ascii");
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/checksum/i);
  });

  it("resolves a path split across the ustar prefix and name fields", () => {
    const tgz = makeTgzEntries([
      { name: "package.json", prefix: "package", body: pkgJson },
    ]);
    expect(readTarballManifest(tgz)).toEqual(manifest);
  });

  it("accepts a tar whose entries all carry a valid checksum", () => {
    const tar = makeTarEntries([
      { name: "package/a.txt", body: "a" },
      { name: "package/package.json", body: pkgJson },
    ]);
    expect(readTarballManifest(gzipSync(tar))).toEqual(manifest);
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

  it("throws when the README name appears twice", () => {
    const tgz = makeTgz([
      pkg,
      ["package/README.md", "one"],
      ["package/README.md", "two"],
    ]);
    expect(() => readTarballReadme(tgz)).toThrow(/duplicate|more than once/i);
  });

  it("throws when the input is not gzip", () => {
    expect(() => readTarballReadme(Buffer.from("nope"))).toThrow(
      /not valid gzip/,
    );
  });

  it("throws on a corrupt size field", () => {
    const tar = makeTar([["package/README.md", "x"]]);
    tar.write("zzzzzzzzzzz\0", 124, "ascii");
    fixChecksum(tar);
    expect(() => readTarballReadme(gzipSync(tar))).toThrow(/bad size/);
  });

  it("throws when the archive is truncated inside the README", () => {
    const tar = makeTar([["package/README.md", "hello"]]);
    expect(() => readTarballReadme(gzipSync(tar.subarray(0, 512 + 2)))).toThrow(
      /truncated/,
    );
  });
});
