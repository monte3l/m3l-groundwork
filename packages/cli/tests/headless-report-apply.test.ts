// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `buildApplyReport` (`headless/report.ts`) turns a `runApplyDryRun` outcome
 * into the report v1 document of an `--apply --dry-run` run: mode adopt,
 * phase apply, dryRun true, the outcome's status and exit code, `changes`,
 * `handoff`, `pending` and `drift` copied through, every other field as in
 * the other builders (fixed key order, none omitted). The schema is extended
 * additively; `schemaVersion` stays 1.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { buildReport, buildApplyReport } from "../src/headless/report.js";
import type { ReportV1 } from "../src/headless/report.js";

const ctx = { cliVersion: "1.2.3" };
const sha = "a".repeat(64);
const other = "b".repeat(64);

const base = {
  target: "/work/app",
  warnings: [],
  pending: [],
  drift: [],
  changes: [],
  handoff: [],
} as const;

describe("buildApplyReport", () => {
  it("builds an ok dry-run report with the changes and handoff", () => {
    const changes = [
      {
        path: "eslint.config.js",
        action: "install-staged",
        class: "addition",
        sha256Before: null,
        sha256After: sha,
      },
      {
        path: "tsconfig.json",
        action: "take-divergent",
        class: "conflict",
        sha256Before: other,
        sha256After: sha,
      },
    ] as const;
    const handoff = [
      { kind: "delegate", path: "package.json" },
      { kind: "missed-notes", notes: "n" },
    ] as const;
    const report = buildApplyReport(
      { ...base, status: "ok", exitCode: 0, changes, handoff },
      ctx,
    );
    expect(report).toMatchObject({
      schema: "groundwork.report",
      schemaVersion: 1,
      cliVersion: "1.2.3",
      mode: "adopt",
      phase: "apply",
      dryRun: true,
      status: "ok",
      exitCode: 0,
      target: "/work/app",
      changes,
      handoff,
      pending: [],
      drift: [],
      setupSteps: [],
      warnings: [],
      nextStep: null,
      error: null,
    });
    expect(report.artifacts).toMatchObject({
      pending: null,
      plan: null,
      commitMsg: null,
      prBody: null,
      manifest: null,
    });
  });

  it("keeps the exact key order of every other report", () => {
    const apply = buildApplyReport(
      { ...base, status: "noop", exitCode: 0 },
      ctx,
    );
    const survey = buildReport(
      {
        mode: "adopt",
        target: "/work/app",
        warnings: [],
        setupSteps: [],
        nextStep: null,
        manifest: null,
        pending: [],
        pendingPath: null,
      },
      ctx,
    );
    expect(Object.keys(apply)).toEqual(Object.keys(survey));
    expect(Object.keys(apply.artifacts)).toEqual(Object.keys(survey.artifacts));
  });

  it("reports a pending outcome with exit 3 and its entries", () => {
    const pending = [
      {
        pointer: "/interview/kind",
        reason: "required",
        choices: ["library"],
        evidence: null,
      },
    ];
    const report = buildApplyReport(
      { ...base, status: "pending", exitCode: 3, pending },
      ctx,
    );
    expect(report).toMatchObject({
      status: "pending",
      exitCode: 3,
      dryRun: true,
      phase: "apply",
      pending,
      changes: [],
    });
    expect(report.artifacts.pending).toBeNull();
  });

  it("reports a drift outcome with exit 4 and its entries", () => {
    const drift = [{ path: "tsconfig.json", expected: sha, actual: null }];
    const report = buildApplyReport(
      { ...base, status: "drift", exitCode: 4, drift },
      ctx,
    );
    expect(report).toMatchObject({ status: "drift", exitCode: 4, drift });
  });

  it("carries the executor's warnings", () => {
    const report = buildApplyReport(
      { ...base, status: "ok", exitCode: 0, warnings: ["careful"] },
      ctx,
    );
    expect(report.warnings).toEqual(["careful"]);
  });

  it("serializes byte-stably and with no undefined field", () => {
    const outcome = { ...base, status: "noop", exitCode: 0 } as const;
    const a = JSON.stringify(buildApplyReport(outcome, ctx));
    expect(JSON.stringify(buildApplyReport(outcome, ctx))).toBe(a);
    expect(Object.keys(JSON.parse(a) as object)).toHaveLength(
      Object.keys(buildApplyReport(outcome, ctx)).length,
    );
  });

  it("widens ReportV1: dryRun is boolean, status gains noop/pending/drift", () => {
    expectTypeOf<ReportV1["dryRun"]>().toEqualTypeOf<boolean>();
    expectTypeOf<"noop" | "pending" | "drift">().toExtend<ReportV1["status"]>();
    expectTypeOf<ReportV1["drift"][number]>().toEqualTypeOf<{
      readonly path: string;
      readonly expected: string | null;
      readonly actual: string | null;
    }>();
  });
});

describe("report.v1.schema.json after the additive extension", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(
    readFileSync(join(here, "..", "schemas", "report.v1.schema.json"), "utf8"),
  ) as {
    properties: Record<
      string,
      { items?: { required?: string[]; properties?: Record<string, unknown> } }
    >;
  };

  it("stays schemaVersion 1", () => {
    expect(
      (schema.properties as Record<string, { const?: unknown }>)[
        "schemaVersion"
      ]?.const,
    ).toBe(1);
  });

  it("defines the drift entry shape", () => {
    expect(schema.properties["drift"]?.items?.required).toEqual([
      "path",
      "expected",
      "actual",
    ]);
  });

  it("defines the handoff entry shape with a kind", () => {
    const items = schema.properties["handoff"]?.items;
    expect(items?.properties).toBeDefined();
    expect(Object.keys(items?.properties ?? {})).toContain("kind");
  });
});
