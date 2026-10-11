// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// A package.json script literally named `__proto__` (an OWN property after
// JSON.parse) must be kept by the scripts copy in both the TypeScript grader and
// the emitted JS twin (templates/core/bin/lib/toolchain-rules.mjs), and the copy
// must never touch Object.prototype.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gradeToolchain } from "../../src/toolchain/grade.js";

const here = dirname(fileURLToPath(import.meta.url));
const twinUrl = pathToFileURL(
  join(
    here,
    "..",
    "..",
    "..",
    "..",
    "templates",
    "core",
    "bin",
    "lib",
    "toolchain-rules.mjs",
  ),
).href;
const emitted = (await import(twinUrl)) as {
  gradeToolchain: (rootDir: string) => unknown;
};

const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolchain-parity-proto-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const STEPS = `export const GROUPS = ["lint"];
export const CORE_STEPS = [
  { id: "proto", group: "lint", name: "Proto", cmd: ["pnpm", "__proto__"] },
  { id: "ctor", group: "lint", name: "Ctor", cmd: ["pnpm", "constructor"] },
  { id: "build", group: "lint", name: "Build", cmd: ["pnpm", "build"] },
  { id: "ts", group: "lint", name: "ToString", cmd: ["pnpm", "toString"] },
];
`;

// Raw text on purpose: JSON.stringify of an object literal would not create an
// own `__proto__` key; JSON.parse of this text does.
const PACKAGE_JSON = `{"scripts":{"__proto__":"echo hi","constructor":"echo c","build":"tsc"}}`;

const wiringFailures = (grade: unknown): string[] =>
  JSON.stringify(grade).match(
    /runs `pnpm [A-Za-z_]+`, but package\.json has no \\"[A-Za-z_]+\\" script/g,
  ) ?? [];

describe("a script named __proto__ is kept by the scripts copy (TS and emitted twin)", () => {
  beforeEach(() => {
    write("package.json", PACKAGE_JSON);
    write("bin/lib/verify-steps.mjs", STEPS);
  });

  it.each([
    ["ts", () => gradeToolchain(root)],
    ["emitted", () => emitted.gradeToolchain(root)],
  ] as const)(
    "%s reports only the non-script `pnpm toString` as missing",
    (_n, grade) => {
      const found = wiringFailures(grade());
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("pnpm toString");
      for (const name of ["__proto__", "constructor", "build"]) {
        expect(found.join("\n")).not.toContain(`pnpm ${name}`);
      }
    },
  );

  it("both implementations report the same grade", () => {
    expect(plain(emitted.gradeToolchain(root))).toEqual(
      plain(gradeToolchain(root)),
    );
  });

  it.each([
    ["ts", () => gradeToolchain(root)],
    ["emitted", () => emitted.gradeToolchain(root)],
  ] as const)("%s leaves Object.prototype untouched", (_n, grade) => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    grade();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBe(
      undefined,
    );
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
  });
});
