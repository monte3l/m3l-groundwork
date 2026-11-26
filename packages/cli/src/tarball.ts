// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * An in-memory reader for the gzipped ustar tarball `npm pack` produces:
 * no extraction to disk, no `tar` binary, no dependency. It keeps only the
 * regular files under `package/templates/` and refuses anything that could
 * name a path outside it.
 */
import { gunzipSync } from "node:zlib";

/**
 * Thrown by {@link readTemplateTarball} for an archive it will not read: not
 * gzip, truncated, a bad header checksum, larger than the cap, or an entry
 * that could escape the template tree. The underlying failure, when there
 * is one, is the `cause`.
 *
 * @example
 * ```ts
 * import { readTemplateTarball, TarballError } from "./tarball.js";
 *
 * try {
 *   readTemplateTarball(bytes);
 * } catch (error) {
 *   if (error instanceof TarballError) console.error(error.message);
 *   else throw error;
 * }
 * ```
 */
export class TarballError extends Error {
  override readonly name = "TarballError";
}

const BLOCK = 512;
/** ustar header field offsets and lengths (POSIX.1-1988). */
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
/** The byte value each checksum byte counts as while summing (a space). */
const CHECKSUM_PLACEHOLDER = 0x20;
/** The most decompressed bytes an archive may hold. */
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const TEMPLATES_PREFIX = "package/templates/";
/** Header typeflags that rewrite the next entry's name or attributes. */
const EXTENDED_TYPES: ReadonlySet<string> = new Set(["x", "g", "L", "K"]);
const REGULAR_TYPES: ReadonlySet<string> = new Set(["0", "\0"]);
const DIRECTORY_TYPE = "5";

const decoder = new TextDecoder();

/** A NUL-terminated header field as text. */
function text(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
}

/** An octal numeric header field; `undefined` when it is not plain octal. */
function octal(
  block: Uint8Array,
  offset: number,
  length: number,
): number | undefined {
  const value = text(block, offset, length).trim();
  if (value === "") return 0;
  return /^[0-7]+$/.test(value) ? Number.parseInt(value, 8) : undefined;
}

function checksumOk(block: Uint8Array): boolean {
  const recorded = octal(block, CHECKSUM_OFFSET, CHECKSUM_LENGTH);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // The checksum field itself counts as eight spaces.
    sum +=
      i >= CHECKSUM_OFFSET && i < CHECKSUM_OFFSET + CHECKSUM_LENGTH
        ? CHECKSUM_PLACEHOLDER
        : (block[i] ?? 0);
  }
  return recorded === sum;
}

/** Refuses a name that is absolute, holds a backslash or a `..` segment. */
function assertSafeName(name: string): void {
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").includes("..")
  ) {
    throw new TarballError(
      `the tarball holds an entry that could escape its package: ${JSON.stringify(name)}`,
    );
  }
}

/** The key of a regular file under `package/templates/`, refusing an empty or `.` segment. */
function templateKey(name: string): string {
  const key = name.slice(TEMPLATES_PREFIX.length);
  if (key.split("/").some((segment) => segment === "" || segment === ".")) {
    throw new TarballError(
      `the tarball holds a malformed template path: ${JSON.stringify(name)}`,
    );
  }
  return key;
}

function gunzip(gz: Uint8Array): Uint8Array {
  try {
    return gunzipSync(gz, { maxOutputLength: MAX_TAR_BYTES });
  } catch (cause) {
    throw new TarballError(
      `the tarball could not be decompressed (it is not gzip, is truncated, or exceeds ${String(MAX_TAR_BYTES / 1024 / 1024)} MiB)`,
      { cause },
    );
  }
}

/**
 * The regular files under `package/templates/` of the gzipped ustar tarball
 * `gz`, keyed by the path after that prefix (`core/package.json`,
 * `packs/quality/files/bin/x.mjs`), with their bytes untouched. Directory
 * entries are skipped, and so are links and other special entries outside
 * `package/templates/`. Reads nothing from disk and writes nothing.
 *
 * @throws {@link TarballError} when `gz` is not gzip or decompresses past
 * 64 MiB, the tar is truncated or a header's checksum is wrong, any entry's
 * name is absolute, holds a backslash or a `..` segment, any entry is a pax
 * or GNU long-name header, a template path appears twice, or an entry under `package/templates/` is
 * anything but a regular file or a directory.
 *
 * @example
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { readTemplateTarball } from "./tarball.js";
 *
 * const files = readTemplateTarball(readFileSync("monte3l-groundwork-1.0.0.tgz"));
 * console.log(files.has("core/package.json"));
 * ```
 */
export function readTemplateTarball(
  gz: Uint8Array,
): ReadonlyMap<string, Uint8Array> {
  const tar = gunzip(gz);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > tar.length) {
      throw new TarballError("the tarball ends inside an entry header");
    }
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    if (!checksumOk(block)) {
      throw new TarballError(
        `the tarball has a header with a wrong checksum at byte ${String(offset)}`,
      );
    }
    const size = octal(block, SIZE_OFFSET, SIZE_LENGTH);
    if (size === undefined) {
      throw new TarballError(
        `the tarball has a header with an unreadable size at byte ${String(offset)}`,
      );
    }
    const prefix = text(block, PREFIX_OFFSET, PREFIX_LENGTH);
    const base = text(block, NAME_OFFSET, NAME_LENGTH);
    const name = prefix === "" ? base : `${prefix}/${base}`;
    const flag = text(block, TYPEFLAG_OFFSET, 1);
    const type = flag === "" ? "\0" : flag;
    const start = offset + BLOCK;
    if (start + size > tar.length) {
      throw new TarballError(`the tarball ends inside ${JSON.stringify(name)}`);
    }
    assertSafeName(name);
    if (EXTENDED_TYPES.has(type)) {
      throw new TarballError(
        `the tarball holds a pax or long-name header (${JSON.stringify(name)}), which this reader refuses`,
      );
    }
    if (name.startsWith(TEMPLATES_PREFIX) && type !== DIRECTORY_TYPE) {
      if (!REGULAR_TYPES.has(type)) {
        throw new TarballError(
          `the tarball holds a link or special entry under package/templates/: ${JSON.stringify(name)}`,
        );
      }
      const key = templateKey(name);
      if (files.has(key)) {
        throw new TarballError(
          `the tarball holds the template path ${JSON.stringify(name)} twice`,
        );
      }
      files.set(key, tar.slice(start, start + size));
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
