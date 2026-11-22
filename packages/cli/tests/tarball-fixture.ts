// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { gzipSync } from "node:zlib";

/**
 * Rewrites the header checksum of the ustar header at `offset` of a raw tar:
 * the sum of its 512 bytes with the checksum field read as eight spaces,
 * stored as six octal digits, a NUL and a space (what `tar` writes).
 */
export function fixChecksum(tar: Buffer, offset = 0): void {
  tar.fill(0x20, offset + 148, offset + 156);
  let sum = 0;
  for (let i = offset; i < offset + 512; i += 1) sum += tar[i] ?? 0;
  tar.write(sum.toString(8).padStart(6, "0") + "\0 ", offset + 148, "ascii");
}

/** One 512-byte ustar header followed by the zero-padded body. */
function entry(
  name: string,
  body: Buffer,
  type = "0",
  prefix?: string,
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  if (prefix !== undefined) header.write(prefix, 345, 155, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write(type, 156, "ascii");
  header.write("ustar\0" + "00", 257, "ascii");
  fixChecksum(header);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

/** A raw (un-gzipped) tar of the given `[name, content]` file entries. */
export function makeTar(files: [string, string][]): Buffer {
  return Buffer.concat([
    ...files.map(([name, content]) => entry(name, Buffer.from(content))),
    Buffer.alloc(1024),
  ]);
}

/** A gzipped tar, the shape `pnpm pack` emits. */
export function makeTgz(files: [string, string][]): Buffer {
  return gzipSync(makeTar(files));
}

/** One entry of a tar built by `makeTarEntries` / `makeTgzEntries`. */
export interface TarEntry {
  name: string;
  body?: string;
  /** The typeflag: "0" file, "1" hardlink, "2" symlink, "x"/"g" PAX, "L"/"K" GNU. */
  type?: string;
  /** The ustar `prefix` field. */
  prefix?: string;
}

/** A raw tar of entries with an explicit typeflag and/or ustar prefix. */
export function makeTarEntries(entries: TarEntry[]): Buffer {
  return Buffer.concat([
    ...entries.map((e) =>
      entry(e.name, Buffer.from(e.body ?? ""), e.type ?? "0", e.prefix),
    ),
    Buffer.alloc(1024),
  ]);
}

/** A gzipped tar of entries with an explicit typeflag and/or ustar prefix. */
export function makeTgzEntries(entries: TarEntry[]): Buffer {
  return gzipSync(makeTarEntries(entries));
}
