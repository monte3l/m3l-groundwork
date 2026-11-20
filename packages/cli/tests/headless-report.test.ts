// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pure `groundwork.report` v1 builders (src/headless/report.ts). This PR
 * only populates the success report of a fresh/adopt run and the error
 * envelope; changes/pending/handoff/drift are always empty arrays here.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildErrorReport,
  buildReport,
  type ReportV1,
} from "../src/headless/report.js";
import type { ExitCode } from "../src/exit-codes.js";
import type { RunResult } from "../src/run-result.js";
import { MANIFEST_RELATIVE_PATH } from "../src/manifest.js";

const ctx = { cliVersion: "9.9.9" };

const KEY_ORDER = [
  "schema",
  "schemaVersion",
  "cliVersion",
  "mode",
  "phase",
  "dryRun",
  "status",
  "exitCode",
  "target",
  "artifacts",
  "changes",
  "pending",
  "handoff",
  "drift",
  "setupSteps",
  "warnings",
  "nextStep",
  "error",
];

function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasUndefined);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasUndefined);
  }
  return false;
}

describe("ReportV1 type", () => {
  it("pins the discriminating fields", () => {
    expectTypeOf<ReportV1["schema"]>().toEqualTypeOf<"groundwork.report">();
    expectTypeOf<ReportV1["schemaVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<ReportV1["dryRun"]>().toEqualTypeOf<false>();
    expectTypeOf<ReportV1["status"]>().toEqualTypeOf<
      "ok" | "error" | "usage"
    >();
    expectTypeOf<ReportV1["mode"]>().toEqualTypeOf<"fresh" | "adopt" | null>();
    expectTypeOf<ReportV1["phase"]>().toEqualTypeOf<
      "apply" | "survey" | null
    >();
    expectTypeOf<ReportV1["exitCode"]>().toEqualTypeOf<ExitCode>();
    expectTypeOf<ReportV1["setupSteps"]>().toEqualTypeOf<
      RunResult["setupSteps"]
    >();
    expectTypeOf<ReportV1["warnings"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ReportV1["artifacts"]["manifest"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<RunResult["manifest"]>().toEqualTypeOf<string | null>();
  });

  it("places manifest right after inventory in artifacts key order", () => {
    const report = buildErrorReport(new Error("x"), 1, ctx);
    expect(Object.keys(report.artifacts)).toEqual([
      "inventory",
      "manifest",
      "plan",
      "pending",
      "commitMsg",
      "prBody",
    ]);
  });
});

describe("buildReport", () => {
  const fresh: RunResult = {
    mode: "fresh",
    target: "/work/acme",
    warnings: ["pack budget is over cap"],
    setupSteps: [{ pack: "publishing", steps: ["pnpm add -D x"] }],
    nextStep: null,
    manifest: MANIFEST_RELATIVE_PATH,
  };
  const adopt: RunResult = {
    mode: "adopt",
    target: "/work/legacy",
    warnings: [],
    setupSteps: [],
    nextStep: "Next: run /customize",
    manifest: null,
  };

  it("reports a fresh run as an ok apply with the manifest and no inventory", () => {
    expect(buildReport(fresh, ctx)).toEqual({
      schema: "groundwork.report",
      schemaVersion: 1,
      cliVersion: "9.9.9",
      mode: "fresh",
      phase: "apply",
      dryRun: false,
      status: "ok",
      exitCode: 0,
      target: "/work/acme",
      artifacts: {
        inventory: null,
        manifest: MANIFEST_RELATIVE_PATH,
        plan: null,
        pending: null,
        commitMsg: null,
        prBody: null,
      },
      changes: [],
      pending: [],
      handoff: [],
      drift: [],
      setupSteps: [{ pack: "publishing", steps: ["pnpm add -D x"] }],
      warnings: ["pack budget is over cap"],
      nextStep: null,
      error: null,
    });
  });

  it("reports an adopt run as an ok survey with a relative inventory path", () => {
    const report = buildReport(adopt, ctx);
    expect(report).toMatchObject({
      mode: "adopt",
      phase: "survey",
      status: "ok",
      exitCode: 0,
      target: "/work/legacy",
      nextStep: "Next: run /customize",
      error: null,
      changes: [],
      pending: [],
      handoff: [],
      drift: [],
    });
    expect(report.artifacts).toEqual({
      inventory: ".groundwork/inventory.json",
      manifest: null,
      plan: null,
      pending: null,
      commitMsg: null,
      prBody: null,
    });
  });

  it.each([[fresh], [adopt]])(
    "is stable: key order, JSON round-trip, no undefined (%#)",
    (result) => {
      const report = buildReport(result, ctx);
      expect(Object.keys(report)).toEqual(KEY_ORDER);
      expect(hasUndefined(report)).toBe(false);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
      expect(JSON.stringify(buildReport(result, ctx))).toBe(
        JSON.stringify(report),
      );
    },
  );
});

describe("buildErrorReport", () => {
  it("reports exit 1 as status error with the message and a one-entry chain", () => {
    const report = buildErrorReport(new Error("disk full"), 1, ctx);
    expect(report).toEqual({
      schema: "groundwork.report",
      schemaVersion: 1,
      cliVersion: "9.9.9",
      mode: null,
      phase: null,
      dryRun: false,
      status: "error",
      exitCode: 1,
      target: null,
      artifacts: {
        inventory: null,
        manifest: null,
        plan: null,
        pending: null,
        commitMsg: null,
        prBody: null,
      },
      changes: [],
      pending: [],
      handoff: [],
      drift: [],
      setupSteps: [],
      warnings: [],
      nextStep: null,
      error: { message: "disk full", chain: ["disk full"] },
    });
  });

  it("reports exit 2 as status usage", () => {
    const report = buildErrorReport(new Error("bad flag"), 2, ctx);
    expect(report).toMatchObject({ status: "usage", exitCode: 2 });
  });

  it("always reports target null: an error envelope never knows one", () => {
    expect(buildErrorReport(new Error("x"), 1, ctx).target).toBeNull();
  });

  it("lists the message first, then each cause's message, outermost to root", () => {
    const root = new Error("ENOENT: spawn git");
    const middle = new Error("git init failed", { cause: root });
    const top = new Error("project written but setup stopped", {
      cause: middle,
    });
    const { error } = buildErrorReport(top, 1, ctx);
    expect(error?.message).toBe("project written but setup stopped");
    expect(error?.chain).toEqual([
      "project written but setup stopped",
      "git init failed",
      "ENOENT: spawn git",
    ]);
  });

  it("stringifies a non-Error value for message and chain", () => {
    const { error } = buildErrorReport("plain string", 1, ctx);
    expect(error).toEqual({ message: "plain string", chain: ["plain string"] });
  });

  it("stringifies a non-Error cause", () => {
    const { error } = buildErrorReport(
      new Error("top", { cause: "raw cause" }),
      1,
      ctx,
    );
    expect(error?.chain).toEqual(["top", "raw cause"]);
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    const { error } = buildErrorReport(a, 1, ctx);
    expect(error?.chain).toEqual(["a", "b"]);
  });

  it.each([
    [new Error("e1"), 1 as const],
    [new Error("e2"), 2 as const],
  ])(
    "is stable: key order, JSON round-trip, no undefined (%#)",
    (error, code) => {
      const report = buildErrorReport(error, code, ctx);
      expect(Object.keys(report)).toEqual(KEY_ORDER);
      expect(hasUndefined(report)).toBe(false);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    },
  );
});

describe("buildErrorReport never throws and survives hostile errors", () => {
  const PLACEHOLDER = "[unprintable value]";

  function build(error: unknown): ReportV1 {
    const report = buildErrorReport(error, 1, ctx);
    expect(() => JSON.stringify(report)).not.toThrow();
    return report;
  }

  it("keeps chain[0] equal to message in the normal case", () => {
    const { error } = build(new Error("top", { cause: new Error("root") }));
    expect(error?.chain[0]).toBe(error?.message);
  });

  it("handles a cause made with Object.create(null)", () => {
    const cause = Object.create(null) as object;
    const { error } = build(new Error("top", { cause }));
    expect(error?.message).toBe("top");
    expect(error?.chain[0]).toBe("top");
    expect(error?.chain).toContain(PLACEHOLDER);
  });

  it("handles an Error whose message getter throws", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter boom");
      },
    });
    const { error } = build(hostile);
    expect(error?.message).toBe(PLACEHOLDER);
    expect(error?.chain).toEqual([PLACEHOLDER]);
  });

  it("handles an Error whose cause getter throws, keeping the readable links", () => {
    const hostile = new Error("top");
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("getter boom");
      },
    });
    const { error } = build(hostile);
    expect(error?.message).toBe("top");
    expect(error?.chain[0]).toBe("top");
    expect(error?.chain.every((link) => typeof link === "string")).toBe(true);
  });

  it("stringifies a non-string message", () => {
    const odd = new Error("x");
    Object.defineProperty(odd, "message", { value: 42 });
    const { error } = build(odd);
    expect(error?.message).toBe("42");
    expect(error?.chain[0]).toBe("42");
  });

  it("truncates a chain far longer than the depth cap", () => {
    let error: Error = new Error("link 0");
    for (let i = 1; i < 500; i++)
      error = new Error(`link ${String(i)}`, { cause: error });
    const report = build(error);
    expect(report.error?.chain[0]).toBe("link 499");
    expect(report.error?.chain.length).toBeGreaterThan(1);
    expect(report.error?.chain.length).toBeLessThan(100);
  });

  it("includes an AggregateError's own message and its members' messages", () => {
    const aggregate = new AggregateError(
      [new Error("member one"), new Error("member two")],
      "several failed",
    );
    const { error } = build(aggregate);
    expect(error?.message).toBe("several failed");
    expect(error?.chain[0]).toBe("several failed");
    expect(error?.chain).toContain("member one");
    expect(error?.chain).toContain("member two");
  });
});
