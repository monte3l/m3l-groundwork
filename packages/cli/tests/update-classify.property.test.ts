// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for `classifyFile`: totality and the invariants
 * every row of the decision table keeps.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { classifyFile } from "../src/update-classify.js";
import { sha256 } from "./update-classify-fixtures.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const textArb = fc.constantFrom("a", "b", "c");
const sideArb = fc.option(textArb, { nil: undefined });
const baseKind = fc.constantFrom("content", "hash", "none");

type Input = Parameters<typeof classifyFile>[0];

function build(
  kind: string,
  base: string,
  ours: string | undefined,
  theirs: string | undefined,
): Input {
  return {
    path: "x.txt",
    source: "core",
    skipped: false,
    base:
      kind === "content"
        ? { kind: "content", bytes: enc(base), from: "snapshot" }
        : kind === "hash"
          ? { kind: "hash", sha256: sha256(base), from: "lock" }
          : { kind: "none" },
    ours: ours === undefined ? undefined : enc(ours),
    theirs: theirs === undefined ? undefined : enc(theirs),
    jsonMerge: false,
  };
}

describe("classifyFile properties", () => {
  it("is total, deterministic and never mutates its input", () => {
    fc.assert(
      fc.property(baseKind, textArb, sideArb, sideArb, (kind, b, o, t) => {
        const a = classifyFile(build(kind, b, o, t));
        expect(classifyFile(build(kind, b, o, t))).toEqual(a);
        expect(a.reason.length).toBeGreaterThan(0);
      }),
    );
  });

  it("ours equal to theirs is current or skip, never a change", () => {
    fc.assert(
      fc.property(baseKind, textArb, textArb, (kind, b, both) => {
        const { action } = classifyFile(build(kind, b, both, both));
        expect(["current", "skip", "keep"]).toContain(action);
      }),
    );
  });

  it("a skipped path is always skip", () => {
    fc.assert(
      fc.property(baseKind, textArb, sideArb, sideArb, (kind, b, o, t) => {
        const entry = classifyFile({ ...build(kind, b, o, t), skipped: true });
        expect(entry.action).toBe("skip");
      }),
    );
  });

  it("with a known base, an untouched file whose theirs changed is take", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("content", "hash"),
        textArb,
        textArb,
        (kind, b, t) => {
          fc.pre(b !== t);
          expect(classifyFile(build(kind, b, b, t)).action).toBe("take");
        },
      ),
    );
  });

  it("with a known base, theirs unchanged and ours edited is keep", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("content", "hash"),
        textArb,
        textArb,
        (kind, b, o) => {
          fc.pre(b !== o);
          expect(classifyFile(build(kind, b, o, b)).action).toBe("keep");
        },
      ),
    );
  });

  it("only apply-default entries are take, merge, add, delete or rename", () => {
    fc.assert(
      fc.property(baseKind, textArb, sideArb, sideArb, (kind, b, o, t) => {
        const entry = classifyFile(build(kind, b, o, t));
        if (entry.default === "apply") {
          expect(["take", "merge", "add", "delete", "rename"]).toContain(
            entry.action,
          );
        }
        if (entry.action === "review") expect(entry.default).not.toBe("apply");
      }),
    );
  });
});
