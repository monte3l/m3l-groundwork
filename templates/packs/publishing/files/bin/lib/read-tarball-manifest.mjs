// SPDX-FileCopyrightText: Copyright the __PROJECT_NAME__ contributors
// SPDX-License-Identifier: NOASSERTION

/**
 * Reads `package/package.json` out of an npm tarball using Node built-ins only,
 * for `npm-stage-publish.mjs`. A tarball reader library (pacote, tar) would drag
 * node-gyp and an HTTP client into the pinned release-tools tree, which is the
 * exact surface this repo moved away from the npm CLI to shrink.
 *
 * Handles what `pnpm pack`/`npm pack` emit: a gzipped ustar archive whose
 * entries live under a top-level directory. It never throws on malformed
 * input other than through the documented `Error`s below.
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/** NUL-terminated ASCII field of a ustar header. */
function field(buf, start, length) {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return buf.toString("utf8", start, stop);
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
 * Walks the archive and returns the body of the first regular file whose
 * path (under its top-level directory) satisfies `wanted`.
 *
 * @param {Buffer} tar
 * @param {(relativeName: string) => boolean} wanted
 * @returns {{ name: string, body: Buffer } | undefined}
 */
function findEntry(tar, wanted) {
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const name = field(tar, offset, 100);
    if (name === "") break; // end-of-archive padding
    const size = parseInt(field(tar, offset + 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`corrupt tar header for ${name}: bad size`);
    }
    const prefix = field(tar, offset + 345, 155);
    const type = String.fromCharCode(tar[offset + 156] ?? 0);
    const body = offset + BLOCK;
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const match = /^[^/]+\/([^/]+)$/.exec(fullName);
    if (
      (type === "0" || type === "\0") &&
      match?.[1] !== undefined &&
      wanted(match[1])
    ) {
      if (body + size > tar.length) {
        throw new Error(`corrupt tarball: ${match[1]} is truncated`);
      }
      return { name: match[1], body: tar.subarray(body, body + size) };
    }
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return undefined;
}

/**
 * @param {Buffer} tgz the gzipped tarball
 * @returns {object} the parsed manifest
 * @throws {Error} when the input is not a gzip, has no package.json, or the
 *   manifest is not valid JSON
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
