// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// gate-wiring must treat only OWN package.json scripts as scripts, in both the
// TypeScript grader and the emitted JS twin (templates/core/bin/lib/toolchain-rules.mjs).
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
  root = mkdtempSync(join(tmpdir(), "toolchain-parity-own-"));
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
  { id: "own", group: "lint", name: "Own", cmd: ["pnpm", "lint"] },
  { id: "ts", group: "lint", name: "ToString", cmd: ["pnpm", "toString"] },
  { id: "ctor", group: "lint", name: "Ctor", cmd: ["pnpm", "constructor"] },
  { id: "hop", group: "lint", name: "Hop", cmd: ["pnpm", "run", "hasOwnProperty"] },
];
`;

describe("gate-wiring ignores inherited Object.prototype members (TS and emitted twin)", () => {
  beforeEach(() => {
    write("package.json", JSON.stringify({ scripts: { lint: "eslint ." } }));
    write("bin/lib/verify-steps.mjs", STEPS);
  });

  const wiringFailures = (grade: unknown): string[] =>
    JSON.stringify(grade).match(
      /runs `pnpm [A-Za-z]+`, but package\.json has no \\"[A-Za-z]+\\" script/g,
    ) ?? [];

  it("both implementations report the same grade", () => {
    expect(plain(emitted.gradeToolchain(root))).toEqual(
      plain(gradeToolchain(root)),
    );
  });

  it.each([
    ["ts", () => gradeToolchain(root)],
    ["emitted", () => emitted.gradeToolchain(root)],
  ] as const)(
    "%s reports each inherited name missing and not the own script",
    (_n, grade) => {
      const found = wiringFailures(grade());
      expect(found).toHaveLength(3);
      for (const name of ["toString", "constructor", "hasOwnProperty"]) {
        expect(found.join("\n")).toContain(`pnpm ${name}`);
      }
      expect(found.join("\n")).not.toContain("pnpm lint");
    },
  );
});
