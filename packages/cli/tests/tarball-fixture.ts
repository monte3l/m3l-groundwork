// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { gzipSync } from "node:zlib";

/** One 512-byte ustar header followed by the zero-padded body. */
function entry(name: string, body: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write(type, 156, "ascii");
  header.write("ustar\0" + "00", 257, "ascii");
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
