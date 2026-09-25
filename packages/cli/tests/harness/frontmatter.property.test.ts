// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Differential fuzzing of harness/frontmatter.ts against its emitted plain-JS
 * twin, templates/core/bin/lib/frontmatter.mjs -- see SECURITY.md's "Dynamic
 * analysis" section. harness-parity.test.ts already asserts identical output
 * for a hand-picked corpus of scalar forms; this file EXTENDS that guarantee
 * with fuzzed input (both pure random strings and strings biased toward
 * looking like real frontmatter blocks) rather than duplicating or weakening
 * it. Change a rule in one implementation, change the other in the same
 * commit -- see rules.ts's and frontmatter.ts's own module docs.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "../../src/harness/frontmatter.js";

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "core",
  "bin",
  "lib",
);

interface EmittedFrontmatter {
  parseFrontmatter: (content: string) => unknown;
}

const emitted = (await import(
  pathToFileURL(join(libDir, "frontmatter.mjs")).href
)) as EmittedFrontmatter;

/** Reduces to plain JSON so a Map compares structurally across both twins. */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      v instanceof Map ? Object.fromEntries(v as Map<string, unknown>) : v,
    ),
  ) as unknown;
}

const scalarKey = fc.constantFrom(
  "name",
  "description",
  "model",
  "paths",
  "d",
  "a",
);
const plainScalarValue = fc
  .string({ maxLength: 20 })
  .filter((s) => !s.includes("\n"));
const quotedScalarValue = fc.oneof(
  fc.string({ maxLength: 15 }).map((s) => `"${s.replace(/"/g, "")}"`),
  fc.string({ maxLength: 15 }).map((s) => `'${s.replace(/'/g, "")}'`),
);
const flowListValue = fc
  .array(fc.constantFrom("a", "b", "c", '"x,y"'), {
    minLength: 0,
    maxLength: 4,
  })
  .map((items) => `[${items.join(", ")}]`);
const blockListValue = fc
  .array(
    fc.string({ maxLength: 10 }).filter((s) => !s.includes("\n")),
    {
      minLength: 0,
      maxLength: 4,
    },
  )
  .map((items) => items.map((item) => `  - ${item}`).join("\n"));
const blockScalarValue = fc
  .tuple(
    fc.constantFrom(">", ">-", "|", "|-"),
    fc.array(
      fc.string({ maxLength: 10 }).filter((s) => !s.includes("\n")),
      {
        minLength: 0,
        maxLength: 3,
      },
    ),
  )
  .map(
    ([marker, lines]) => `${marker}\n${lines.map((l) => `  ${l}`).join("\n")}`,
  );

/** One `key: value`-ish line, biased toward the scalar shapes real frontmatter uses. */
const frontmatterLine = fc.oneof(
  fc.tuple(scalarKey, plainScalarValue).map(([k, v]) => `${k}: ${v}`),
  fc.tuple(scalarKey, quotedScalarValue).map(([k, v]) => `${k}: ${v}`),
  fc.tuple(scalarKey, flowListValue).map(([k, v]) => `${k}: ${v}`),
  fc.tuple(scalarKey, blockListValue).map(([k, v]) => `${k}:\n${v}`),
  fc.tuple(scalarKey, blockScalarValue).map(([k, v]) => `${k}: ${v}`),
  fc.constant(""), // a blank line inside the block
  fc.string({ maxLength: 10 }).map((s) => `# ${s}`), // a comment line
);

/** A frontmatter-shaped `---`-delimited block: realistic-ish, not pure noise. */
const frontmatterBlockArb = fc
  .array(frontmatterLine, { minLength: 0, maxLength: 6 })
  .map((lines) => `---\n${lines.join("\n")}\n---\nbody text\n`);

const inputArb = fc.oneof(
  { arbitrary: fc.string(), weight: 1 },
  { arbitrary: frontmatterBlockArb, weight: 3 },
);

describe("parseFrontmatter and its emitted .mjs twin, fuzzed", () => {
  it("agree on every frontmatter-shaped or arbitrary string input", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(plain(emitted.parseFrontmatter(input)), input).toEqual(
          plain(parseFrontmatter(input)),
        );
      }),
      { numRuns: 150 },
    );
  });

  it("never throws on any fuzzed input, on either twin", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(() => parseFrontmatter(input)).not.toThrow();
        expect(() => emitted.parseFrontmatter(input)).not.toThrow();
      }),
      { numRuns: 150 },
    );
  });
});
