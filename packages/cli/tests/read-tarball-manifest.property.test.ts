// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for bin/lib/read-tarball-manifest.mjs: on any bytes,
 * raw or gzipped, it returns a value or throws an Error, and nothing else.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  readTarballReadme: (buf: Buffer) => unknown;
};

function outcome(
  buf: Buffer,
  read: (b: Buffer) => unknown = readTarballManifest,
): "value" | "error" {
  try {
    read(buf);
    return "value";
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return "error";
  }
}

describe("readTarballManifest properties", () => {
  it("only returns or throws an Error on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
        expect(["value", "error"]).toContain(outcome(Buffer.from(bytes)));
      }),
    );
  });

  it("only returns or throws an Error on gzip of arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        expect(["value", "error"]).toContain(
          outcome(gzipSync(Buffer.from(bytes))),
        );
      }),
    );
  });

  it("only returns or throws an Error on gzip of header-shaped blocks", () => {
    const block = fc.uint8Array({ minLength: 512, maxLength: 1536 });
    fc.assert(
      fc.property(block, fc.nat(8), (bytes, size) => {
        const buf = Buffer.from(bytes);
        buf.write("package/package.json\0", 0, "utf8");
        buf.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
        buf[156] = 0x30;
        expect(["value", "error"]).toContain(outcome(gzipSync(buf)));
      }),
    );
  });

  it("readTarballReadme only returns or throws an Error on arbitrary and gzipped bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const buf = Buffer.from(bytes);
        for (const input of [buf, gzipSync(buf)]) {
          expect(["value", "error"]).toContain(
            outcome(input, readTarballReadme),
          );
        }
      }),
    );
  });

  it("readTarballReadme returns undefined or a filename/content object on header-shaped blocks", () => {
    const block = fc.uint8Array({ minLength: 512, maxLength: 1536 });
    fc.assert(
      fc.property(block, fc.nat(8), (bytes, size) => {
        const buf = Buffer.from(bytes);
        buf.write("package/README.md\0", 0, "utf8");
        buf.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
        buf[156] = 0x30;
        try {
          const result = readTarballReadme(gzipSync(buf)) as
            { filename: string; content: string } | undefined;
          if (result !== undefined) {
            expect(typeof result.filename).toBe("string");
            expect(typeof result.content).toBe("string");
          }
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
    );
  });
});
