// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
);

const { parsePublishArgs } = (await import(
  pathToFileURL(join(binDir, "lib", "npm-publish-args.mjs")).href
)) as { parsePublishArgs: (args: string[]) => Record<string, string> };

/** Names the flag and says it was repeated, however the wording goes. */
const repeated = (flag: string): RegExp =>
  new RegExp(
    `${flag}.*(once|twice|repeat|duplicate|more than)|(once|twice|repeat|duplicate|more than).*${flag}`,
    "i",
  );

const EXPECT = "@scope/name@1.0.0";

describe("parsePublishArgs", () => {
  it("returns the tarball, access, tag and expect", () => {
    expect(
      parsePublishArgs([
        "a.tgz",
        "--access",
        "public",
        "--tag",
        "latest",
        "--expect",
        EXPECT,
      ]),
    ).toEqual({
      tarball: "a.tgz",
      access: "public",
      tag: "latest",
      expect: EXPECT,
    });
  });

  it("accepts the flags before the tarball and an otp", () => {
    expect(
      parsePublishArgs(["--tag", "next", "a.tgz", "--otp", "123456"]),
    ).toMatchObject({ tarball: "a.tgz", tag: "next", otp: "123456" });
  });

  it("returns only the tarball when no flag is given", () => {
    expect(parsePublishArgs(["a.tgz"])).toEqual({ tarball: "a.tgz" });
  });

  it.each(["--json", "--no-git-checks"])(
    "accepts %s and drops it from the result",
    (flag) => {
      expect(parsePublishArgs(["a.tgz", flag, "--tag", "x"])).toEqual({
        tarball: "a.tgz",
        tag: "x",
      });
    },
  );

  it.each([
    [["a.tgz", "--tag"], /--tag needs a value/],
    [["a.tgz", "--tag", "--access", "public"], /--tag needs a value/],
    [["a.tgz", "--access"], /--access needs a value/],
    [["a.tgz", "--expect"], /--expect needs a value/],
    [["a.tgz", "--expect", "--tag", "x"], /--expect needs a value/],
  ])("refuses a flag without a value (%j)", (args, message) => {
    expect(() => parsePublishArgs(args)).toThrow(message);
  });

  it.each([
    [["a.tgz", "--tag", "a", "--tag", "b"], repeated("--tag")],
    [
      ["a.tgz", "--access", "public", "--access", "restricted"],
      repeated("--access"),
    ],
    [["a.tgz", "--expect", EXPECT, "--expect", EXPECT], repeated("--expect")],
    [["a.tgz", "--otp", "111111", "--otp", "222222"], repeated("--otp")],
  ])("refuses a repeated flag instead of taking the last (%j)", (args, msg) => {
    expect(() => parsePublishArgs(args)).toThrow(msg);
  });

  it("refuses a second tarball", () => {
    expect(() => parsePublishArgs(["a.tgz", "b.tgz"])).toThrow(
      /expected one tarball/,
    );
  });

  it("refuses no tarball", () => {
    expect(() => parsePublishArgs(["--tag", "x"])).toThrow(/no tarball/);
    expect(() => parsePublishArgs([])).toThrow(/no tarball/);
  });

  it.each(["--dry-run", "-x", "--provenance=false"])(
    "refuses the unknown flag %s",
    (flag) => {
      expect(() => parsePublishArgs(["a.tgz", flag])).toThrow(
        `unsupported flag ${flag}`,
      );
    },
  );
});
