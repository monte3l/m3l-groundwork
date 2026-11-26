// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `readTemplateTarball(gz)`: parses a gzipped ustar npm tarball in memory,
 * keeps the regular files under `package/templates/` keyed by the path after
 * that prefix, and refuses anything that could escape it, plus corrupt,
 * truncated and oversize archives, with a `TarballError`.
 */
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readTemplateTarball, TarballError } from "../src/tarball.js";
import { buildTar, buildTgz, packageFiles } from "./tarball-fixtures.js";
import type { TarEntry } from "./tarball-fixtures.js";

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

function refusal(gz: Uint8Array): unknown {
  try {
    readTemplateTarball(gz);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("readTemplateTarball: happy path", () => {
  it("keys regular files by the path after package/templates/", () => {
    const files = readTemplateTarball(
      buildTgz(
        packageFiles({
          "templates/core/package.json": '{"a":1}',
          "templates/core/_gitignore": "node_modules\n",
          "templates/packs/quality/files/bin/x.mjs": "export {};\n",
        }),
      ),
    );
    expect([...files.keys()].sort()).toEqual([
      "core/_gitignore",
      "core/package.json",
      "packs/quality/files/bin/x.mjs",
    ]);
    expect(text(files.get("core/package.json"))).toBe('{"a":1}');
    expect(files.get("core/_gitignore")).toBeInstanceOf(Uint8Array);
  });

  it("returns binary content byte for byte, across block boundaries", () => {
    const data = Uint8Array.from({ length: 1300 }, (_, i) => (i * 7) % 256);
    const files = readTemplateTarball(
      buildTgz([{ name: "package/templates/core/blob.bin", data }]),
    );
    expect([...(files.get("core/blob.bin") ?? [])]).toEqual([...data]);
  });

  it("keeps an empty file", () => {
    const files = readTemplateTarball(
      buildTgz(packageFiles({ "templates/core/empty": "" })),
    );
    expect(files.get("core/empty")?.length).toBe(0);
  });

  it("accepts the NUL typeflag as a regular file", () => {
    const files = readTemplateTarball(
      buildTgz([{ name: "package/templates/core/a", data: "x", type: "\0" }]),
    );
    expect(text(files.get("core/a"))).toBe("x");
  });

  it("ignores files outside package/templates/", () => {
    const files = readTemplateTarball(
      buildTgz(
        packageFiles({
          "package.json": "{}",
          "dist/main.js": "x",
          "templates-extra/a": "x",
          "templates/core/a": "kept",
        }),
      ),
    );
    expect([...files.keys()]).toEqual(["core/a"]);
  });

  it("ignores directory entries and non-link specials outside templates/", () => {
    const files = readTemplateTarball(
      buildTgz([
        { name: "package/templates/", type: "5" },
        { name: "package/templates/core/", type: "5" },
        { name: "package/bin/link", type: "2", linkname: "../elsewhere" },
        { name: "package/templates/core/a", data: "a" },
      ]),
    );
    expect([...files.keys()]).toEqual(["core/a"]);
  });

  it("returns an empty map for an archive with no templates", () => {
    expect(
      readTemplateTarball(buildTgz(packageFiles({ "package.json": "{}" })))
        .size,
    ).toBe(0);
  });

  it("joins the ustar prefix field to the name", () => {
    const files = readTemplateTarball(
      buildTgz([
        { prefix: "package/templates/core/deep", name: "file.txt", data: "p" },
      ]),
    );
    expect(text(files.get("core/deep/file.txt"))).toBe("p");
  });
});

describe("readTemplateTarball: refusals", () => {
  const cases: [string, TarEntry][] = [
    ["a .. segment", { name: "package/templates/../../evil", data: "x" }],
    [
      "a .. segment in the middle",
      { name: "package/templates/a/../b", data: "x" },
    ],
    [
      "a .. segment before templates",
      { name: "package/x/../templates/a", data: "x" },
    ],
    ["an absolute path", { name: "/package/templates/core/a", data: "x" }],
    ["a backslash", { name: "package/templates/core\\a", data: "x" }],
    [
      "a .. in the prefix",
      { prefix: "package/templates/..", name: "a", data: "x" },
    ],
    [
      "a symlink",
      { name: "package/templates/core/l", type: "2", linkname: "/etc/passwd" },
    ],
    [
      "a hardlink",
      { name: "package/templates/core/h", type: "1", linkname: "package/a" },
    ],
    ["a character device", { name: "package/templates/core/c", type: "3" }],
    [
      "a GNU long-name header",
      { name: "package/templates/core/L", type: "L", data: "x" },
    ],
    [
      "a pax header",
      { name: "package/templates/core/p", type: "x", data: "x" },
    ],
  ];

  it.each(cases)("refuses %s under templates/", (_label, entry) => {
    const thrown = refusal(buildTgz([entry]));
    expect(thrown).toBeInstanceOf(TarballError);
    expect((thrown as TarballError).message.length).toBeGreaterThan(0);
  });

  it("refuses a hostile entry even when valid ones precede it", () => {
    expect(
      refusal(
        buildTgz([
          ...packageFiles({ "templates/core/a": "ok" }),
          { name: "package/templates/../x", data: "x" },
        ]),
      ),
    ).toBeInstanceOf(TarballError);
  });

  it("handles or refuses a pax path override, never honoring a traversal", () => {
    const record = "30 path=package/templates/../../evil\n";
    const thrown = refusal(
      buildTgz([
        { name: "PaxHeader/a", type: "x", data: record },
        { name: "package/templates/core/a", data: "x" },
      ]),
    );
    // Refusing is the documented choice; the only other safe outcome is
    // parsing without ever surfacing the traversal key.
    const outcome =
      thrown ??
      [
        ...readTemplateTarball(
          buildTgz([
            { name: "PaxHeader/a", type: "x", data: record },
            { name: "package/templates/core/a", data: "x" },
          ]),
        ).keys(),
      ].filter((key) => key.includes(".."));
    expect(outcome).toSatisfy(
      (value: unknown) =>
        value instanceof TarballError ||
        (Array.isArray(value) && value.length === 0),
    );
  });
});

describe("readTemplateTarball: duplicates", () => {
  it("refuses a template path that appears twice in one archive", () => {
    const gz = buildTgz([
      { name: "package/templates/core/a.txt", data: "first" },
      { name: "package/templates/core/a.txt", data: "second" },
    ]);
    expect(refusal(gz)).toBeInstanceOf(TarballError);
  });
});

describe("readTemplateTarball: corrupt and oversize archives", () => {
  const valid = packageFiles({ "templates/core/a": "x".repeat(2000) });

  it("rejects bytes that are not gzip", () => {
    expect(refusal(new TextEncoder().encode("not a tarball"))).toBeInstanceOf(
      TarballError,
    );
  });

  it("rejects an empty input", () => {
    expect(refusal(new Uint8Array(0))).toBeInstanceOf(TarballError);
  });

  it("rejects a truncated gzip stream", () => {
    const gz = buildTgz(valid);
    expect(refusal(gz.subarray(0, Math.floor(gz.length / 2)))).toBeInstanceOf(
      TarballError,
    );
  });

  it("rejects a tar cut inside a file's data", () => {
    const tar = buildTar(valid);
    const cut = gzipSync(tar.subarray(0, 512 + 700));
    expect(refusal(cut)).toBeInstanceOf(TarballError);
  });

  it("rejects a tar cut inside a header", () => {
    const tar = buildTar(valid);
    expect(refusal(gzipSync(tar.subarray(0, 200)))).toBeInstanceOf(
      TarballError,
    );
  });

  it("rejects a header whose checksum is wrong", () => {
    expect(refusal(buildTgz(valid, { badChecksum: true }))).toBeInstanceOf(
      TarballError,
    );
  });

  it("rejects a total larger than the 64 MiB cap", () => {
    const half = new Uint8Array(33 * 1024 * 1024);
    const thrown = refusal(
      buildTgz([
        { name: "package/templates/core/a", data: half },
        { name: "package/templates/core/b", data: half },
      ]),
    );
    expect(thrown).toBeInstanceOf(TarballError);
  });

  it("accepts a total well under the cap", () => {
    const data = new Uint8Array(4 * 1024 * 1024);
    expect(
      readTemplateTarball(
        buildTgz([{ name: "package/templates/core/a", data }]),
      ).get("core/a")?.length,
    ).toBe(data.length);
  });
});
