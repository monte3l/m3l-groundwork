// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runCli` and `main` for `--adopt --apply <file> --dry-run`: `runCli` returns
 * a promise of the outcome and prints the summary through `out` (stdout in
 * human mode, stderr under `--json`); `main` refuses `--apply` with a plain
 * Error, after the flags were checked. A real tmp project, no spawning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError, main, runCli } from "../src/main.js";
import type { ApplyDryRunOutcome } from "../src/headless/apply-plan.js";
import type { Out } from "../src/output.js";
import {
  INVENTORY_REL,
  PENDING_REL,
  completeAnswers,
  snapshotTree,
  writeProject,
} from "./headless-apply-plan-fixture.js";

type Json = Record<string, unknown>;

function makeOut() {
  return {
    info: vi.fn(),
    notice: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  } satisfies Out;
}

describe("runCli --apply", () => {
  let root: string;
  let project: string;
  let answersPath: string;
  let log: MockInstance<typeof console.log>;
  let error: MockInstance<typeof console.error>;
  const pendingDoc = (): Json =>
    JSON.parse(readFileSync(join(project, PENDING_REL), "utf8")) as Json;
  const writeAnswers = (doc: unknown): void => {
    writeFileSync(answersPath, JSON.stringify(doc));
  };
  const argv = (...extra: string[]): string[] => [
    project,
    "--adopt",
    "--apply",
    answersPath,
    "--dry-run",
    ...extra,
  ];
  const lines = (fn: { mock: { calls: unknown[][] } }): string[] =>
    fn.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "main-run-cli-apply-"));
    project = join(root, "project");
    mkdirSync(project);
    writeProject(project);
    main([project, "--adopt", "--json"], "linux", makeOut());
    answersPath = join(root, "answers.json");
    log.mockClear();
    error.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves to an ok outcome and lists every planned file on stdout in human mode", async () => {
    writeAnswers(completeAnswers(pendingDoc()));
    const before = snapshotTree(project);
    const ran = runCli(argv(), "linux");
    expect(ran).toBeInstanceOf(Promise);
    const outcome = await (ran as Promise<ApplyDryRunOutcome>);
    expect(outcome).toMatchObject({ status: "ok", exitCode: 0 });
    const printed = lines(log);
    expect(printed[0]).toMatch(
      /apply plan \(dry run, nothing written\): \d+ files? to write/,
    );
    expect(printed).toContain("  take-divergent tsconfig.json");
    expect(printed).toContain("  install-staged eslint.config.js");
    expect(error).not.toHaveBeenCalled();
    expect(snapshotTree(project)).toEqual(before);
  });

  it("routes the whole summary to stderr under --json", async () => {
    writeAnswers(completeAnswers(pendingDoc()));
    await (runCli(argv("--json"), "linux") as Promise<unknown>);
    expect(log).not.toHaveBeenCalled();
    expect(lines(error).join("\n")).toContain("take-divergent tsconfig.json");
  });

  it("says the answers write no file for a noop outcome", async () => {
    writeAnswers(
      completeAnswers(pendingDoc(), { resolution: "keep", addition: "skip" }),
    );
    const out = makeOut();
    const outcome = await (runCli(
      argv(),
      "linux",
      out,
    ) as Promise<ApplyDryRunOutcome>);
    expect(outcome.status).toBe("noop");
    expect(lines(out.info)).toEqual([
      "apply plan (dry run, nothing written): the answers write no file",
    ]);
  });

  it("prints the handoff lines for a delegated conflict and missed notes", async () => {
    const answers = completeAnswers(pendingDoc(), {
      resolution: "delegate",
      addition: "skip",
    });
    (answers["adopt"] as { missedNotes: string }).missedNotes = "mind CI";
    writeAnswers(answers);
    const out = makeOut();
    await (runCli(argv(), "linux", out) as Promise<unknown>);
    expect(lines(out.info)).toContain("  handed to /customize: tsconfig.json");
    expect(lines(out.info)).toContain("  missed notes for /customize: mind CI");
  });

  it("notices a stopped plan and lists each open decision when pending", async () => {
    writeAnswers(pendingDoc());
    const out = makeOut();
    const outcome = await (runCli(
      argv(),
      "linux",
      out,
    ) as Promise<ApplyDryRunOutcome>);
    expect(outcome).toMatchObject({ status: "pending", exitCode: 3 });
    expect(out.notice).toHaveBeenCalledTimes(1);
    expect(lines(out.notice)[0]).toContain(
      `${String(outcome.pending.length)} decision(s) still undecided`,
    );
    expect(lines(out.info).length).toBe(outcome.pending.length);
    expect(lines(out.info)[0]).toMatch(/^ {2}\/\S+: /);
  });

  it("notices a stopped plan and lists the drifted file when the survey changed", async () => {
    writeAnswers(completeAnswers(pendingDoc()));
    const inventory = join(project, INVENTORY_REL);
    writeFileSync(inventory, `${readFileSync(inventory, "utf8")}\n`);
    const out = makeOut();
    const outcome = await (runCli(
      argv(),
      "linux",
      out,
    ) as Promise<ApplyDryRunOutcome>);
    expect(outcome).toMatchObject({ status: "drift", exitCode: 4 });
    expect(lines(out.notice)[0]).toContain(
      "the project changed after the survey",
    );
    expect(lines(out.info)[0]).toMatch(
      /^ {2}\.groundwork\/inventory\.json: expected [0-9a-f]{64}, found [0-9a-f]{64}$/,
    );
  });

  it("rejects with a CliUsageError for an unusable answers file", async () => {
    await expect(
      runCli(argv(), "linux", makeOut()) as Promise<unknown>,
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("still returns synchronously for a mode without --apply", () => {
    const result = runCli(["--version"], "linux");
    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("main --apply", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws a plain Error pointing at runCli, not a usage error", () => {
    let thrown: unknown;
    try {
      main(["app", "--adopt", "--apply", "a.json", "--dry-run"], "linux");
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toContain("runCli()");
  });

  it("checks the flags first: --apply without --dry-run is a usage error", () => {
    expect(() =>
      main(["app", "--adopt", "--apply", "a.json"], "linux"),
    ).toThrow(CliUsageError);
  });
});
