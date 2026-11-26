// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property tests for the pure parts of pack installation detection:
 * `matchesTokenizedTemplate` and `classifyPackInstallation`.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { applyTokens } from "../src/tokens.js";
import {
  classifyPackInstallation,
  isPackOutdated,
  matchesTokenizedTemplate,
} from "../src/pack-installation.js";
import type { PackInstallFacts } from "../src/pack-installation.js";

// Literal text and token values use DISJOINT alphabets, so a value can never
// forge a literal piece and the expected match is unambiguous.
const literal = fc.stringMatching(/^[abc -]{1,8}$/);
const value = fc.stringMatching(/^[xyz09]{1,8}$/);
const KEYS = ["A", "B"] as const;

const templateParts = fc.record({
  s0: literal,
  s1: literal,
  s2: literal,
  a: value,
  b: value,
});

function build(p: { s0: string; s1: string; s2: string }): string {
  return `${p.s0}__A__${p.s1}__B__${p.s2}`;
}

describe("matchesTokenizedTemplate (property)", () => {
  it("matches the template with every token replaced by a non-empty newline-free value", () => {
    fc.assert(
      fc.property(templateParts, (p) => {
        const template = build(p);
        const actual = applyTokens(template, { A: p.a, B: p.b });
        expect(matchesTokenizedTemplate(template, actual, KEYS)).toBe(true);
      }),
    );
  });

  it("does not match when literal text outside the tokens is mutated", () => {
    // `q` is in neither alphabet. A change adjacent to a slot would read as
    // part of the slot's value, so the middle mutation rewrites a character
    // INSIDE the literal piece s1 instead of inserting next to a slot.
    fc.assert(
      fc.property(templateParts, fc.nat(), (p, at) => {
        const template = build(p);
        const index = at % p.s1.length;
        const s1Mutated = `${p.s1.slice(0, index)}q${p.s1.slice(index + 1)}`;
        const mutated = [
          // leading literal changed
          `q${p.s0.slice(1)}${p.a}${p.s1}${p.b}${p.s2}`,
          // middle literal changed
          `${p.s0}${p.a}${s1Mutated}${p.b}${p.s2}`,
          // trailing literal changed
          `${p.s0}${p.a}${p.s1}${p.b}${p.s2.slice(0, -1)}q`,
        ];
        for (const actual of mutated) {
          expect(matchesTokenizedTemplate(template, actual, KEYS)).toBe(false);
        }
      }),
      { numRuns: 20000 },
    );
  });

  it("does not match when a token slot is empty", () => {
    fc.assert(
      fc.property(templateParts, (p) => {
        const template = build(p);
        expect(
          matchesTokenizedTemplate(
            template,
            `${p.s0}${p.s1}${p.b}${p.s2}`,
            KEYS,
          ),
        ).toBe(false);
      }),
    );
  });
});

const wiring = fc.constantFrom(
  "complete",
  "partial",
  "absent",
  "not-applicable",
  "unknown",
);
const paths = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}$/), {
  maxLength: 6,
});
const factsArb = fc
  .record({ present: paths, absent: paths, modified: paths, wiring })
  .map((r): PackInstallFacts => ({
    files: { present: r.present, absent: r.absent, modified: r.modified },
    wiring: r.wiring,
  }));

describe("classifyPackInstallation (property)", () => {
  it("never returns not-installed while an undetermined note exists", () => {
    fc.assert(
      fc.property(
        factsArb,
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
        (facts, notes) => {
          expect(
            classifyPackInstallation(facts, [], "p", notes).status,
          ).not.toBe("not-installed");
        },
      ),
    );
  });

  it("never returns not-installed when wiring is unknown", () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const unknown: PackInstallFacts = { ...facts, wiring: "unknown" };
        expect(classifyPackInstallation(unknown, [], "p", []).status).not.toBe(
          "not-installed",
        );
      }),
    );
  });

  it("does not depend on the order of the file arrays", () => {
    fc.assert(
      fc.property(
        factsArb,
        fc.array(fc.string(), { maxLength: 2 }),
        (facts, notes) => {
          const reordered: PackInstallFacts = {
            wiring: facts.wiring,
            files: {
              present: [...facts.files.present].reverse(),
              absent: [...facts.files.absent].reverse(),
              modified: [...facts.files.modified].reverse(),
            },
          };
          expect(
            classifyPackInstallation(reordered, [], "p", notes).status,
          ).toBe(classifyPackInstallation(facts, [], "p", notes).status);
        },
      ),
    );
  });

  it("always reports installed from the ledger when the ledger lists the pack", () => {
    fc.assert(
      fc.property(
        factsArb,
        fc.array(fc.string(), { maxLength: 3 }),
        fc.array(fc.string(), { maxLength: 3 }),
        (facts, notes, others) => {
          const result = classifyPackInstallation(
            facts,
            [...others, "p"],
            "p",
            notes,
          );
          expect(result.status).toBe("installed");
          expect(result.source).toBe("ledger");
        },
      ),
    );
  });
});

describe("isPackOutdated (property)", () => {
  const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
  const semver = fc
    .tuple(fc.nat({ max: 30 }), fc.nat({ max: 30 }), fc.nat({ max: 30 }))
    .map(([a, b, c]) => ({
      text: `${String(a)}.${String(b)}.${String(c)}`,
      n: [a, b, c],
    }));
  const cmp = (a: number[], b: number[]): number =>
    (a[0] ?? 0) - (b[0] ?? 0) ||
    (a[1] ?? 0) - (b[1] ?? 0) ||
    (a[2] ?? 0) - (b[2] ?? 0);
  const files = fc.dictionary(fc.stringMatching(/^[a-z]{1,5}$/), hex, {
    maxKeys: 4,
  });
  const current = fc.record({ manifestSha256: hex, files });
  const history = fc.option(
    fc.record({
      schemaVersion: fc.constant(1 as const),
      versions: fc.dictionary(
        semver.map((v) => v.text),
        fc.record({
          core: fc.constant({}),
          packs: fc.dictionary(
            fc.constantFrom("p", "q"),
            fc.record({ manifest: hex, files }),
          ),
        }),
        { maxKeys: 3 },
      ),
      blobs: fc.constant({}),
    }),
    { nil: undefined },
  );

  it("is never true for a ledger version at or above the running version", () => {
    fc.assert(
      fc.property(
        semver,
        semver,
        fc.option(hex, { nil: undefined }),
        current,
        history,
        (ledgerV, running, manifestSha256, cur, hist) => {
          fc.pre(cmp(ledgerV.n, running.n) >= 0);
          const entry = { name: "p", cliVersion: ledgerV.text, manifestSha256 };
          expect(isPackOutdated(entry, cur, hist, running.text)).toBe(false);
        },
      ),
    );
  });

  it("is never true without a ledger entry", () => {
    fc.assert(
      fc.property(current, history, semver, (cur, hist, running) => {
        expect(isPackOutdated(undefined, cur, hist, running.text)).toBe(false);
      }),
    );
  });

  it("is never true when a recorded hash equals the current one and there is no history", () => {
    fc.assert(
      fc.property(semver, semver, current, (ledgerV, running, cur) => {
        const entry = {
          name: "p",
          cliVersion: ledgerV.text,
          manifestSha256: cur.manifestSha256,
        };
        expect(isPackOutdated(entry, cur, undefined, running.text)).toBe(false);
      }),
    );
  });

  it("is true for an older ledger version whose recorded manifest hash differs", () => {
    fc.assert(
      fc.property(semver, semver, hex, current, (a, b, recorded, cur) => {
        fc.pre(cmp(a.n, b.n) < 0 && recorded !== cur.manifestSha256);
        const entry = {
          name: "p",
          cliVersion: a.text,
          manifestSha256: recorded,
        };
        expect(isPackOutdated(entry, cur, undefined, b.text)).toBe(true);
      }),
    );
  });
});
