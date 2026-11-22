// SPDX-FileCopyrightText: Copyright the __PROJECT_NAME__ contributors
// SPDX-License-Identifier: NOASSERTION

/**
 * Reads `package/package.json` out of an npm tarball using Node built-ins only,
 * for `npm-stage-publish.mjs`. A tarball reader library (pacote, tar) would drag
 * node-gyp and an HTTP client into the pinned release-tools tree, which is the
 * exact surface this repo moved away from the npm CLI to shrink.
 *
 * Handles what `pnpm pack`/`npm pack` emit: a gzipped ustar archive whose
 * entries live under a top-level directory. Every header's checksum is
 * verified and the whole archive is scanned, so a duplicate entry or a PAX/GNU
 * long-name header (which would rename a later entry) is refused rather than
 * silently resolved. It never throws on malformed input other than through the
 * documented `Error`s below.
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/**
 * Typeflags that change how a later entry is named (PAX extended/global
 * headers, GNU long name/link). This reader does not implement them, so an
 * archive carrying one is refused: honouring the ustar name alone could read a
 * different file than the one tar itself would extract under that path.
 */
const RENAMING_TYPES = new Set(["x", "g", "L", "K"]);

/** NUL-terminated ASCII field of a ustar header. */
function field(buf, start, length) {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return buf.toString("utf8", start, stop);
}

/**
 * Parses a NUL/space-terminated octal numeric header field, refusing anything
 * that is not purely octal (including GNU's base-256 encoding).
 *
 * @param {Buffer} tar
 * @param {number} start
 * @param {number} length
 * @returns {number | undefined} undefined when the field is not octal
 */
function octal(tar, start, length) {
  const text = field(tar, start, length).trim();
  if (!/^[0-7]+$/.test(text)) return undefined;
  const value = parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Throws unless the header at `offset` carries a valid checksum: the unsigned
 * sum of its 512 bytes with the 8-byte checksum field counted as spaces.
 *
 * @param {Buffer} tar
 * @param {number} offset
 * @param {string} name the entry name, for the message
 */
function verifyChecksum(tar, offset, name) {
  const stored = octal(tar, offset + 148, 8);
  if (stored === undefined) {
    throw new Error(`corrupt tar header for ${name}: checksum is not octal`);
  }
  let sum = 0;
  for (let i = offset; i < offset + BLOCK; i += 1) {
    sum += i >= offset + 148 && i < offset + 156 ? 0x20 : (tar[i] ?? 0);
  }
  if (sum !== stored) {
    throw new Error(`corrupt tar header for ${name}: checksum mismatch`);
  }
}

/**
 * @param {Buffer} tgz
 * @returns {Buffer} the decompressed archive
 */
function gunzip(tgz) {
  try {
    return gunzipSync(tgz);
  } catch (error) {
    throw new Error(
      `tarball is not valid gzip: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Walks the whole archive and returns the body of the regular file whose path
 * (under its top-level directory) satisfies `wanted`. When several distinct
 * names match, the first wins; the same name appearing twice is refused,
 * because `tar` would extract the later copy over the earlier one, and the
 * reader must not pick a different copy than an install would see.
 *
 * @param {Buffer} tar
 * @param {(relativeName: string) => boolean} wanted
 * @returns {{ name: string, body: Buffer } | undefined}
 * @throws {Error} on a corrupt header (checksum or size), a PAX/GNU
 *   long-name entry, a truncated wanted entry or a duplicate wanted name
 */
function findEntry(tar, wanted) {
  let found;
  const seen = new Set();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const name = field(tar, offset, 100);
    if (name === "") {
      // Only an all-zero block ends the archive; a nameless header with any
      // other byte set is corrupt, and stopping there would hide later entries.
      if (tar.subarray(offset, offset + BLOCK).every((b) => b === 0)) break;
      throw new Error(`corrupt tar header at offset ${offset}: empty name`);
    }
    verifyChecksum(tar, offset, name);
    const size = octal(tar, offset + 124, 12);
    if (size === undefined) {
      throw new Error(`corrupt tar header for ${name}: bad size`);
    }
    const prefix = field(tar, offset + 345, 155);
    const type = String.fromCharCode(tar[offset + 156] ?? 0);
    if (RENAMING_TYPES.has(type)) {
      throw new Error(
        `unsupported tar entry type ${JSON.stringify(type)} for ${name} (PAX and GNU long-name headers are not read)`,
      );
    }
    const body = offset + BLOCK;
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const match = /^[^/]+\/([^/]+)$/.exec(fullName);
    // Only regular files are matched and duplicate-checked: npm's extractor
    // (pacote) filters out link and symlink entries, so a link sharing a
    // wanted name never lands on disk. That is the current assumption about
    // npm's behaviour, not something this reader can verify.
    if (
      (type === "0" || type === "\0") &&
      match?.[1] !== undefined &&
      wanted(match[1])
    ) {
      if (seen.has(match[1])) {
        throw new Error(
          `corrupt tarball: ${match[1]} appears more than once (duplicate entry)`,
        );
      }
      seen.add(match[1]);
      if (body + size > tar.length) {
        throw new Error(`corrupt tarball: ${match[1]} is truncated`);
      }
      found ??= { name: match[1], body: tar.subarray(body, body + size) };
    }
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return found;
}

/**
 * @param {Buffer} tgz the gzipped tarball
 * @returns {object} the parsed manifest
 * @throws {Error} when the input is not a gzip, has a corrupt header (bad
 *   checksum or size), a PAX/GNU long-name entry or a duplicate package.json,
 *   has no package.json, or the manifest is not valid JSON
 */
export function readTarballManifest(tgz) {
  const entry = findEntry(gunzip(tgz), (n) => n === "package.json");
  if (entry === undefined)
    throw new Error("tarball has no package/package.json");
  try {
    return JSON.parse(entry.body.toString("utf8"));
  } catch (error) {
    throw new Error(
      `package.json in the tarball is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * The README the registry shows for a version. npm's own publish reads it
 * from the tarball and adds it to the version metadata; libnpmpublish does
 * not, so without this the published page has no README.
 *
 * @param {Buffer} tgz the gzipped tarball
 * @returns {{ filename: string, content: string } | undefined} undefined when
 *   the tarball ships no README
 * @throws {Error} on the same corrupt-archive conditions as
 *   `readTarballManifest`, or a README name that appears twice
 */
export function readTarballReadme(tgz) {
  const tar = gunzip(tgz);
  const entry =
    findEntry(tar, (n) => /^readme\.md$/i.test(n)) ??
    findEntry(tar, (n) => /^readme(\.[^/]+)?$/i.test(n));
  return entry === undefined
    ? undefined
    : { filename: entry.name, content: entry.body.toString("utf8") };
}
