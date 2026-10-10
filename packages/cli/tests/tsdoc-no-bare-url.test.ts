// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The src rules file bans bare URLs inside TSDoc blocks in package sources.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [
  join(here, "..", "src"),
  join(here, "..", "..", "plugin", "src"),
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function bareUrlLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const hits: string[] = [];
  for (const block of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const start = block.index;
    const lines = block[0].split("\n");
    const firstLine = text.slice(0, start).split("\n").length;
    lines.forEach((line, i) => {
      if (/https?:\/\//.test(line)) {
        hits.push(`${path}:${String(firstLine + i)}`);
      }
    });
  }
  return hits;
}

describe("TSDoc blocks carry no bare URLs", () => {
  it("finds no http(s):// inside a /** */ block under the packages source trees", () => {
    const hits = roots.flatMap((root) => tsFiles(root).flatMap(bareUrlLines));
    expect(hits).toEqual([]);
  });
});
