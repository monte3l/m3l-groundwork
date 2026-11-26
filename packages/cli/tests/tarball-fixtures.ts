// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures of the tarball and fetch-base suites: an in-memory ustar
 * writer (so no test touches `tar` or the network) and a fake `npm pack`.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK = 512;

/** One archive entry; `type` is the raw typeflag character (default `"0"`). */
export interface TarEntry {
  readonly name: string;
  readonly data?: Uint8Array | string;
  readonly type?: string;
  readonly prefix?: string;
  readonly linkname?: string;
}

export interface TarOptions {
  /** Leave out the two zero end-of-archive blocks. */
  readonly noEnd?: boolean;
  /** Break the first entry's header checksum. */
  readonly badChecksum?: boolean;
}

function bytesOf(data: Uint8Array | string | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array(0);
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function field(
  block: Uint8Array,
  offset: number,
  length: number,
  text: string,
): void {
  block.set(new TextEncoder().encode(text).subarray(0, length), offset);
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(
  entry: TarEntry,
  size: number,
  badChecksum: boolean,
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  field(block, 0, 100, entry.name);
  field(block, 100, 8, octal(0o644, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156);
  field(block, 156, 1, entry.type ?? "0");
  field(block, 157, 100, entry.linkname ?? "");
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  field(block, 345, 155, entry.prefix ?? "");
  let sum = 0;
  for (const byte of block) sum += byte;
  if (badChecksum) sum += 7;
  field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** The raw (uncompressed) ustar bytes of `entries`. */
export function buildTar(
  entries: readonly TarEntry[],
  options: TarOptions = {},
): Uint8Array {
  const parts: Uint8Array[] = [];
  entries.forEach((entry, index) => {
    const data = bytesOf(entry.data);
    parts.push(
      header(entry, data.length, options.badChecksum === true && index === 0),
    );
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    parts.push(new Uint8Array(pad));
  });
  if (options.noEnd !== true) parts.push(new Uint8Array(BLOCK * 2));
  return Buffer.concat(parts);
}

/** `buildTar`, gzipped: what `npm pack` produces. */
export function buildTgz(
  entries: readonly TarEntry[],
  options: TarOptions = {},
): Uint8Array {
  return gzipSync(buildTar(entries, options));
}

/** Regular-file entries `package/<path>` for each of `files`. */
export function packageFiles(
  files: Readonly<Record<string, string>>,
): TarEntry[] {
  return Object.entries(files).map(([path, data]) => ({
    name: `package/${path}`,
    data,
  }));
}

/** What an injected `runNpm` returns. */
export interface FakeNpmResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * A fake `npm`: on `pack`, writes `tgz` as `filename` into the
 * `--pack-destination` directory and reports it as `npm pack --json` does.
 * Strict like real npm: the destination must already exist, else it fails
 * with status 254 and an ENOENT message (verified against real npm).
 */
export function fakeNpmPack(
  tgz: Uint8Array,
  filename = "monte3l-groundwork-1.0.0.tgz",
): (args: readonly string[], cwd: string) => FakeNpmResult {
  return (args) => {
    const at = args.indexOf("--pack-destination");
    const dest = args[at + 1];
    if (at < 0 || dest === undefined)
      throw new Error("fixture: no destination");
    if (!existsSync(dest)) {
      return {
        status: 254,
        stdout: "",
        stderr: `npm error code ENOENT\nnpm error enoent ENOENT: no such file or directory, open '${join(dest, filename)}'`,
      };
    }
    writeFileSync(join(dest, filename), tgz);
    return {
      status: 0,
      stdout: JSON.stringify([{ filename, name: "@monte3l/groundwork" }]),
      stderr: "",
    };
  };
}
