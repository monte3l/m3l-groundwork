// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * End-to-end `--adopt --apply <answers.json> --dry-run` through the real bin
 * script: survey with `--json`, fill the pending document in, then plan. The
 * exit codes (0 / 1 / 2 / 3 / 4), the report v1 document, stdout purity under
 * `--json`, and the invariant that the target tree is byte-identical after
 * every run (no lock, no .groundwork/headless/txn, no new pending.json).
 * Needs `pnpm build` first; run via `pnpm test:e2e`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  INVENTORY_REL,
  PENDING_REL,
  completeAnswers,
  sha256Of,
  snapshotTree,
  writeProject,
} from "./headless-apply-plan-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

function run(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface Report {
  schema: string;
  schemaVersion: number;
  mode: string | null;
  phase: string | null;
  dryRun: boolean;
  status: string;
  exitCode: number;
  target: string | null;
  artifacts: Record<string, string | null>;
  changes: {
    path: string;
    action: string;
    class: string;
    sha256Before: string | null;
    sha256After: string | null;
  }[];
  pending: { pointer: string }[];
  handoff: { kind: string; path?: string; notes?: string }[];
  drift: { path: string; expected: string | null; actual: string | null }[];
  error: { message: string; chain: string[] } | null;
}

/** stdout must be exactly one JSON document. */
function parseReport(stdout: string): Report {
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Report;
}

describe("--adopt --apply --dry-run (bin)", () => {
  let root: string;
  let project: string;
  let answersPath: string;
  const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const writeAnswers = (doc: unknown): void => {
    writeFileSync(answersPath, JSON.stringify(doc));
  };
  const plan = (extra: string[] = ["--json"]) =>
    run([project, "--adopt", "--apply", answersPath, "--dry-run", ...extra]);
  /** Runs `fn` and asserts the target tree is byte-identical afterwards and nothing apply-related exists. */
  const unchanged = <T>(fn: () => T): T => {
    const before = snapshotTree(project);
    const result = fn();
    expect(snapshotTree(project)).toEqual(before);
    expect(existsSync(join(project, ".groundwork", "headless", "lock"))).toBe(
      false,
    );
    expect(existsSync(join(project, ".groundwork", "headless", "txn"))).toBe(
      false,
    );
    expect(
      existsSync(join(project, ".groundwork", "headless", "applied.json")),
    ).toBe(false);
    return result;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hl-apply-plan-e2e-"));
    project = join(root, "project");
    mkdirSync(project);
    writeProject(project);
    expect(run([project, "--adopt", "--json"]).status).toBe(0);
    answersPath = join(root, "answers.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("plans the changes for complete answers: exit 0, one report on stdout, tree unchanged", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    const { status, stdout } = unchanged(() => plan());

    expect(status).toBe(0);
    const report = parseReport(stdout);
    expect(report).toMatchObject({
      schema: "groundwork.report",
      schemaVersion: 1,
      mode: "adopt",
      phase: "apply",
      dryRun: true,
      status: "ok",
      exitCode: 0,
      target: project,
      error: null,
      pending: [],
      drift: [],
    });
    const paths = report.changes.map((c) => c.path);
    expect(paths).toEqual([...paths].sort());
    expect(report.changes).toContainEqual({
      path: "tsconfig.json",
      action: "take-divergent",
      class: "conflict",
      sha256Before: sha256Of(readFileSync(join(project, "tsconfig.json"))),
      sha256After: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(report.changes).toContainEqual({
      path: "eslint.config.js",
      action: "install-staged",
      class: "addition",
      sha256Before: null,
      sha256After: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(existsSync(join(project, "eslint.config.js"))).toBe(false);
  });

  it("is noop with exit 0 when the answers write nothing", () => {
    writeAnswers(
      completeAnswers(readJson(join(project, PENDING_REL)), {
        resolution: "keep",
        addition: "skip",
      }),
    );
    const { status, stdout } = unchanged(() => plan());
    expect(status).toBe(0);
    expect(parseReport(stdout)).toMatchObject({
      status: "noop",
      exitCode: 0,
      dryRun: true,
      changes: [],
    });
  });

  it("lists delegated conflicts in handoff", () => {
    writeAnswers(
      completeAnswers(readJson(join(project, PENDING_REL)), {
        resolution: "delegate",
        addition: "skip",
      }),
    );
    const { status, stdout } = unchanged(() => plan());
    expect(status).toBe(0);
    expect(parseReport(stdout).handoff).toContainEqual({
      kind: "delegate",
      path: "tsconfig.json",
    });
  });

  it("prints a readable plan summary to stdout in human mode", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    const { status, stdout } = unchanged(() => plan([]));
    expect(status).toBe(0);
    expect(stdout).toContain("tsconfig.json");
    expect(stdout).toContain("eslint.config.js");
    expect(stdout).not.toContain("groundwork.report");
  });

  it("under --json keeps human text on stderr, never on stdout", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    const { stdout, stderr } = unchanged(() => plan());
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
    expect(stderr).toContain("tsconfig.json");
  });

  it("exits 3 with the pending entries when decisions are still null, writing nothing", () => {
    // The survey's own pending document is incomplete by construction.
    writeAnswers(readJson(join(project, PENDING_REL)));
    const { status, stdout } = unchanged(() => plan());
    expect(status).toBe(3);
    const report = parseReport(stdout);
    expect(report).toMatchObject({
      status: "pending",
      exitCode: 3,
      dryRun: true,
      phase: "apply",
      changes: [],
    });
    const pointers = report.pending.map((p) => p.pointer);
    expect(pointers).toContain("/interview/kind");
    expect(pointers).toContain("/interview/runtime");
  });

  it("exits 3 and leaves no pending.json behind when the survey's was deleted", () => {
    const partial = readJson(join(project, PENDING_REL));
    rmSync(join(project, PENDING_REL));
    writeAnswers(partial);
    const { status } = unchanged(() => plan());
    expect(status).toBe(3);
    expect(existsSync(join(project, PENDING_REL))).toBe(false);
  });

  it("exits 4 (stale basis) when inventory.json was edited after the answers were written", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    const inventoryPath = join(project, INVENTORY_REL);
    const original = readFileSync(inventoryPath, "utf8");
    writeFileSync(inventoryPath, `${original}\n`);
    const { status, stdout } = unchanged(() => plan());
    expect(status).toBe(4);
    const report = parseReport(stdout);
    expect(report).toMatchObject({ status: "drift", exitCode: 4 });
    expect(report.drift).toEqual([
      {
        path: INVENTORY_REL,
        expected: sha256Of(original),
        actual: sha256Of(`${original}\n`),
      },
    ]);
  });

  it("exits 4 with a drift entry when a project file changed after the survey", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    const original = sha256Of(readFileSync(join(project, "tsconfig.json")));
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const { status, stdout } = unchanged(() => plan());
    expect(status).toBe(4);
    const report = parseReport(stdout);
    expect(report).toMatchObject({ status: "drift", exitCode: 4, changes: [] });
    expect(report.drift).toEqual([
      {
        path: "tsconfig.json",
        expected: original,
        actual: sha256Of(readFileSync(join(project, "tsconfig.json"))),
      },
    ]);
  });

  it("exits 2 for an answers path the inventory does not list", () => {
    const answers = completeAnswers(readJson(join(project, PENDING_REL)));
    (
      answers["adopt"] as { conflicts: Record<string, unknown>[] }
    ).conflicts.push({ path: "ghost.txt", resolution: "keep" });
    writeAnswers(answers);
    const { status, stdout, stderr } = unchanged(() => plan());
    expect(status).toBe(2);
    expect(parseReport(stdout)).toMatchObject({
      status: "usage",
      exitCode: 2,
    });
    expect(stderr).not.toContain("unrecognized option");
    expect(stderr).toContain("ghost.txt");
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it.each([
    ["not JSON", "{ garbage"],
    ["a JSON array", "[]"],
    ["empty", ""],
  ])(
    "exits 2 without a stack trace for an answers file that is %s",
    (_n, text) => {
      writeFileSync(answersPath, text);
      const { status, stderr } = unchanged(() => plan([]));
      expect(status).toBe(2);
      expect(stderr).not.toContain("unrecognized option");
      expect(stderr).toContain(answersPath);
      expect(stderr).not.toMatch(/\n\s+at /);
    },
  );

  it("exits 2 for a missing answers file", () => {
    const { status, stderr } = unchanged(() => plan([]));
    expect(status).toBe(2);
    expect(stderr).not.toContain("unrecognized option");
    expect(stderr).toContain(answersPath);
  });

  it("exits 2 telling the caller to run --adopt first when there is no inventory", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    rmSync(join(project, INVENTORY_REL));
    const { status, stderr } = unchanged(() => plan([]));
    expect(status).toBe(2);
    expect(stderr).not.toContain("unrecognized option");
    expect(stderr).toContain("inventory");
    expect(stderr).toContain("--adopt");
  });

  it("exits 1 with the error chain when the executor refuses a tampered staged copy", () => {
    writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
    const { stagedBaseline } = readJson(join(project, INVENTORY_REL)) as {
      stagedBaseline: { dir: string; files: { staged: string }[] };
    };
    const staged = stagedBaseline.files[0];
    expect(staged).toBeDefined();
    writeFileSync(
      join(project, stagedBaseline.dir, staged?.staged ?? ""),
      "tampered\n",
    );
    const { status, stdout } = unchanged(() => plan());
    expect(status).toBe(1);
    const report = parseReport(stdout);
    expect(report).toMatchObject({ status: "error", exitCode: 1 });
    expect(report.error?.chain.length).toBeGreaterThan(0);
    expect(Object.values(report.artifacts).every((a) => a === null)).toBe(true);
  });

  describe("usage errors in the flags (exit 2, nothing written)", () => {
    it.each([
      ["--apply alone", ["--adopt", "--apply"]],
      ["--apply without --dry-run", ["--adopt", "--apply", "ANSWERS"]],
      ["--apply without --adopt", ["--apply", "ANSWERS", "--dry-run"]],
      ["--dry-run without --apply", ["--adopt", "--dry-run"]],
      ["--apply with --fresh", ["--fresh", "--apply", "ANSWERS", "--dry-run"]],
    ])("%s", (_name, flags) => {
      writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
      const args = flags.map((f) => (f === "ANSWERS" ? answersPath : f));
      const { status, stderr } = unchanged(() => run([project, ...args]));
      expect(status).toBe(2);
      expect(stderr).not.toContain("unrecognized option");
      expect(stderr).toMatch(/--apply|--dry-run/);
    });

    it("says writing is not available yet when --apply has no --dry-run", () => {
      writeAnswers(completeAnswers(readJson(join(project, PENDING_REL))));
      const { status, stderr } = unchanged(() =>
        run([project, "--adopt", "--apply", answersPath]),
      );
      expect(status).toBe(2);
      expect(stderr).toMatch(/writing is not available yet/);
      expect(stderr).toContain("--dry-run");
    });
  });
});
