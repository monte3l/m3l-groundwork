// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runUpdate(options, deps?)`: `--update` stages an update under
 * `<dir>/.groundwork/update/` and nothing else. `options` is
 * `{ targetDir, baseVersion? }`; `deps` is `{ history?, runningVersion?,
 * coreDir?, migrationsPath? }` as for `runCheckUpdate`. Returns the exit
 * code (0). Real temp projects built with the update fixtures; real git for
 * the text merges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate } from "../src/update.js";
import { CliUsageError } from "../src/usage.js";
import { LOCK_FILE, parseLock } from "../src/lock.js";
import { loadPack, serializePackManifest } from "../src/packs.js";
import { LEDGER_PATH, templateFileHashes } from "../src/pack-installation.js";
import type { TemplateHistory } from "../src/template-history.js";
import { snapshotTree, subtreeOf } from "./add-pack-fixtures.js";
import { writeTree } from "./update-base-fixtures.js";
import {
  bootstrapFresh,
  readLockOrThrow,
  readText,
  sha256,
  simulateOlder,
} from "./update-classify-fixtures.js";
import {
  ADDED,
  BINARY,
  changeLockFiles,
  moveBaseToHistory,
  seedLegacyFile,
  JSON_CONFLICT,
  JSON_MERGE,
  RUNNING,
  TAKE,
  TEXT_CONFLICT,
  TEXT_MERGE,
  UPDATE_DIR,
  currentCoreHashes,
  historyWith,
  olderProject,
  planEntry,
  readPlan,
  readStaged,
  stagedFiles,
  updateDeps,
} from "./update-fixtures.js";
import type { UpdatePlan } from "./update-fixtures.js";

let root: string;
let project: string;
let pristine: string;
let log: MockInstance<typeof console.log>;
let savedPath: string | undefined;
let savedGlobal: string | undefined;
let savedNoSystem: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "update-stage-"));
  project = join(root, "project");
  pristine = join(root, "pristine");
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  savedPath = process.env["PATH"];
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedNoSystem = process.env["GIT_CONFIG_NOSYSTEM"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});

afterEach(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PATH", savedPath);
  restore("GIT_CONFIG_GLOBAL", savedGlobal);
  restore("GIT_CONFIG_NOSYSTEM", savedNoSystem);
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const output = (): string =>
  log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

const outsideUpdate = (dir: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(snapshotTree(dir)).filter(
      ([key]) => key !== UPDATE_DIR && !key.startsWith(`${UPDATE_DIR}/`),
    ),
  );

function run(extra: { baseVersion?: string } = {}): number {
  return runUpdate({ targetDir: project, ...extra }, updateDeps());
}

describe("runUpdate: refusals create nothing", () => {
  function expectRefusal(
    attempt: () => unknown,
    kind: typeof CliUsageError | typeof Error = CliUsageError,
  ): void {
    const before = snapshotTree(root);
    let thrown: unknown;
    try {
      attempt();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(kind);
    if (kind === Error) expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect(snapshotTree(root)).toEqual(before);
  }

  it("a target that does not exist", () => {
    expectRefusal(() => runUpdate({ targetDir: project }, updateDeps()));
  });

  it("a target that is a file", () => {
    writeTree(root, { "file.txt": "x" });
    expectRefusal(() =>
      runUpdate({ targetDir: join(root, "file.txt") }, updateDeps()),
    );
  });

  it("an adopt run that did not finish", () => {
    writeTree(project, { ".groundwork/adoption-report.md": "partial" });
    expectRefusal(() => run({ baseVersion: "1.0.0" }));
  });

  it("an unknown origin with no lock, even with --base-version", () => {
    writeTree(project, { "readme.txt": "hello" });
    expectRefusal(() => run({ baseVersion: "1.0.0" }));
  });

  it("a base that cannot be resolved, advising --base-version", () => {
    bootstrapFresh(project);
    rmSync(join(project, LOCK_FILE));
    const before = snapshotTree(root);
    let thrown: unknown;
    try {
      runUpdate(
        { targetDir: project },
        {
          history: historyWith({ "nothing.txt": sha256("x") }),
          runningVersion: RUNNING,
          coreDir: join(root, "no-core"),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toMatch(/--base-version <x\.y\.z>/);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("an invalid lock", () => {
    bootstrapFresh(project);
    writeFileSync(join(project, LOCK_FILE), "{ not json");
    expectRefusal(() => run());
  });

  it("a lock newer than the CLI", () => {
    bootstrapFresh(project);
    simulateOlder(project, TAKE, "older: true\n", undefined, "100.0.0");
    expectRefusal(() => run());
  });

  it("a .groundwork/update that is a symlink", () => {
    olderProject(project, pristine);
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(project, UPDATE_DIR));
    expectRefusal(() => run());
  });

  it("a .groundwork/update that is a regular file", () => {
    olderProject(project, pristine);
    writeFileSync(join(project, UPDATE_DIR), "not a directory");
    expectRefusal(() => run());
  });

  it("a .groundwork that is a symlink", () => {
    olderProject(project, pristine);
    renameSync(join(project, ".groundwork"), join(root, "real-groundwork"));
    symlinkSync(join(root, "real-groundwork"), join(project, ".groundwork"));
    expectRefusal(() => run());
  });

  it("a damaged template history is a plain Error (exit 1)", () => {
    olderProject(project, pristine);
    expectRefusal(
      () =>
        runUpdate(
          { targetDir: project },
          { history: { note: "history is damaged" }, runningVersion: RUNNING },
        ),
      Error,
    );
  });
});

describe("runUpdate: up to date", () => {
  it("prints 'already up to date' and writes nothing when the base is the running version", () => {
    bootstrapFresh(project);
    const base = readLockOrThrow(project).baseVersion;
    const before = snapshotTree(project);
    const code = runUpdate(
      { targetDir: project },
      { ...updateDeps(), runningVersion: base },
    );
    expect(code).toBe(0);
    expect(output()).toContain(
      `already up to date (base ${base} (lock), CLI ${base})`,
    );
    expect(snapshotTree(project)).toEqual(before);
  });

  it("writes nothing and leaves an existing .groundwork/update/ untouched when no entry is actionable", () => {
    bootstrapFresh(project);
    const text = readText(project, TAKE);
    simulateOlder(project, TAKE, text);
    writeTree(project, { [`${UPDATE_DIR}/earlier.txt`]: "previous staging" });
    const before = snapshotTree(project);
    expect(run()).toBe(0);
    expect(output()).toContain(
      `already up to date (base 1.0.0 (lock), CLI ${RUNNING})`,
    );
    expect(snapshotTree(project)).toEqual(before);
    expect(existsSync(join(project, UPDATE_DIR, "plan.json"))).toBe(false);
  });
});

describe("runUpdate: staging one change per category", () => {
  let plan: UpdatePlan;
  let theirs: (path: string) => string;
  let before: Record<string, string>;
  let code: number;

  beforeEach(() => {
    theirs = olderProject(project, pristine).theirs;
    before = outsideUpdate(project);
    code = run();
    plan = readPlan(project);
  });

  it("returns 0 and leaves everything outside .groundwork/update/ byte-identical", () => {
    expect(code).toBe(0);
    expect(outsideUpdate(project)).toEqual(before);
  });

  it("classifies each scenario file as its category", () => {
    expect(planEntry(plan, TAKE).action).toBe("take");
    expect(planEntry(plan, TEXT_MERGE).action).toBe("merge");
    expect(planEntry(plan, TEXT_CONFLICT)).toMatchObject({
      action: "conflict",
      conflicts: 1,
    });
    expect(planEntry(plan, JSON_MERGE).action).toBe("merge");
    expect(planEntry(plan, JSON_CONFLICT).action).toBe("conflict");
    expect(planEntry(plan, BINARY).action).toBe("review");
    expect(planEntry(plan, ADDED).action).toBe("add");
  });

  it("stages a take as its pristine theirs bytes under files/", () => {
    expect(readStaged(project, `files/${TAKE}.staged`)).toBe(theirs(TAKE));
    expect(planEntry(plan, TAKE).staged).toEqual({
      theirs: `files/${TAKE}.staged`,
    });
  });

  it("stages an add under files/", () => {
    expect(readStaged(project, `files/${ADDED}.staged`)).toBe(theirs(ADDED));
    expect(planEntry(plan, ADDED).staged.theirs).toBe(`files/${ADDED}.staged`);
  });

  it("stages a clean text merge under merged/ via git merge-file", () => {
    const merged = readStaged(project, `merged/${TEXT_MERGE}.staged`);
    expect(merged).toContain("// mine");
    expect(merged).not.toContain("<<<<<<<");
    expect(merged.split("\n")[0]).toBe(theirs(TEXT_MERGE).split("\n")[0]);
    expect(planEntry(plan, TEXT_MERGE).staged.merged).toBe(
      `merged/${TEXT_MERGE}.staged`,
    );
    // The base came from .groundwork/base, not the template history.
    expect(
      existsSync(join(project, UPDATE_DIR, "base", `${TEXT_MERGE}.staged`)),
    ).toBe(false);
  });

  it("stages a clean JSON merge under merged/, keeping the local key", () => {
    const merged = JSON.parse(
      readStaged(project, `merged/${JSON_MERGE}.staged`),
    ) as Record<string, unknown>;
    expect(merged["localKey"]).toBe(2);
    expect(merged).not.toHaveProperty("oldUpstream");
  });

  it("stages a text conflict with diff3 markers, never in the project", () => {
    const staged = readStaged(project, `merged/${TEXT_CONFLICT}.staged`);
    expect(staged).toContain("<<<<<<< yours");
    expect(staged).toContain("||||||| groundwork 1.0.0");
    expect(staged).toContain(`>>>>>>> groundwork ${RUNNING}`);
    expect(readText(project, TEXT_CONFLICT)).not.toContain("<<<<<<<");
    // Theirs is staged too, so the owner can choose "take groundwork's".
    expect(readStaged(project, `files/${TEXT_CONFLICT}.staged`)).toBe(
      theirs(TEXT_CONFLICT),
    );
    expect(planEntry(plan, TEXT_CONFLICT).staged).toEqual({
      theirs: `files/${TEXT_CONFLICT}.staged`,
      merged: `merged/${TEXT_CONFLICT}.staged`,
    });
  });

  it("stages a JSON conflict as theirs under files/ with the conflicting keys", () => {
    const entry = planEntry(plan, JSON_CONFLICT);
    expect(entry.staged.theirs).toBe(`files/${JSON_CONFLICT}.staged`);
    expect(readStaged(project, `files/${JSON_CONFLICT}.staged`)).toBe(
      theirs(JSON_CONFLICT),
    );
    expect(entry.keyDiffs).toContainEqual({
      pointer: "/$schema",
      resolution: "conflict",
    });
  });

  it("stages a non-UTF-8 local file as a review with theirs under files/", () => {
    const entry = planEntry(plan, BINARY);
    expect(entry.staged.theirs).toBe(`files/${BINARY}.staged`);
    expect(readStaged(project, `files/${BINARY}.staged`)).toBe(theirs(BINARY));
    // The base came from the .groundwork/base snapshot, so it is not staged.
    expect(entry.staged.base).toBeUndefined();
    expect(stagedFiles(project)).not.toContain(`base/${BINARY}.staged`);
  });

  it("stages nothing for current/keep/skip/delete entries", () => {
    for (const entry of plan.files) {
      if (["current", "keep", "skip", "delete"].includes(entry.action)) {
        expect(entry.staged).toEqual({});
      }
    }
  });

  it("stages, per entry, exactly the locations its action calls for", () => {
    for (const entry of plan.files) {
      switch (entry.action) {
        case "take":
        case "add":
        case "rename":
          expect(entry.staged.theirs).toBeDefined();
          expect(entry.staged.merged).toBeUndefined();
          break;
        case "merge":
          expect(entry.staged.merged).toBeDefined();
          break;
        default:
          break;
      }
    }
  });

  it("records the plan header, base, merge tool and summary", () => {
    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: "m3l-groundwork/update-plan",
      origin: expect.any(String) as unknown,
      requiredMode: "fresh",
      base: { version: "1.0.0", source: "lock" },
      merge: { tool: "git-merge-file" },
    });
    expect(plan.targetDir).toBe(project);
    expect(plan.base.lockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.merge.gitVersion).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(plan.generatedAt))).toBe(false);
    expect(plan.skill.status).toBe("current");
    expect(plan.migrations).toEqual(expect.any(Array));
    const counted: Record<string, number> = {};
    for (const { action } of plan.files) {
      counted[action] = (counted[action] ?? 0) + 1;
    }
    for (const [action, count] of Object.entries(counted)) {
      expect(plan.summary[action]).toBe(count);
    }
  });

  it("records the lock's sha256 as base.lockSha256", () => {
    expect(plan.base.lockSha256).toBe(
      sha256(readFileSync(join(project, LOCK_FILE))),
    );
  });

  it("lists every staged file once, with its sha256, and no other file exists", () => {
    const listed = plan.staged.files.map((file) => file.staged).sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toContain("lock-next.json");
    for (const file of plan.staged.files) {
      expect(sha256(readFileSync(join(project, UPDATE_DIR, file.staged)))).toBe(
        file.sha256,
      );
    }
    expect(stagedFiles(project)).toEqual([...listed, "plan.json"].sort());
    for (const rel of stagedFiles(project)) {
      expect(
        rel === "plan.json" ||
          rel === "lock-next.json" ||
          rel.endsWith(".staged"),
      ).toBe(true);
    }
  });

  it("stages the CLI's /customize payload under customize/", () => {
    expect(readStaged(project, "customize/SKILL.md.staged")).toBe(
      readText(pristine, ".claude/skills/customize/SKILL.md"),
    );
  });

  it("prints the staged line with the non-zero counts, then the next step", () => {
    const lines = output().split("\n");
    const staged = lines.find((l) => l.startsWith("staged update"));
    expect(staged).toMatch(
      new RegExp(
        `^staged update 1\\.0\\.0 -> ${RUNNING.replaceAll(".", "\\.")}: `,
      ),
    );
    expect(staged).toContain("update cleanly");
    expect(staged).toContain("need a merge");
    expect(staged).toContain("conflict");
    expect(staged).toContain("need review");
    expect(lines.at(-1)).toBe("next: run /customize update");
  });
});

describe("runUpdate: lock-next.json", () => {
  it("is the lock after every default is accepted", () => {
    const theirs = olderProject(project, pristine).theirs;
    const oldLock = readLockOrThrow(project);
    run();
    const next = parseLock(readStaged(project, "lock-next.json"));
    const byPath = new Map(next.files.map((file) => [file.path, file]));
    const oldBy = new Map(oldLock.files.map((file) => [file.path, file]));

    expect(next).toMatchObject({
      baseVersion: RUNNING,
      via: "update",
      origin: oldLock.origin,
      tokens: oldLock.tokens,
    });
    // A proposal: /customize update stamps the real time when it writes the lock.
    expect(next.updatedAt).toBe(oldLock.updatedAt);

    for (const path of [TAKE, TEXT_MERGE, JSON_MERGE, ADDED]) {
      expect(byPath.get(path)).toMatchObject({
        baseSha256: sha256(theirs(path)),
        status: "installed",
      });
    }
    // conflict and review keep their old base and status.
    for (const path of [TEXT_CONFLICT, JSON_CONFLICT, BINARY]) {
      expect(byPath.get(path)).toEqual(oldBy.get(path));
    }
    expect(byPath.get(ADDED)?.source).toBe(oldBy.get(TAKE)?.source);
  });
});

describe("runUpdate: merge tool unavailable", () => {
  it("makes every both-changed text file a review with its versions staged and records tool none", () => {
    olderProject(project, pristine);
    mkdirSync(join(root, "no-bin"));
    process.env["PATH"] = join(root, "no-bin");
    run();
    const plan = readPlan(project);
    expect(plan.merge).toEqual({ tool: "none", gitVersion: null });
    for (const path of [TEXT_MERGE, TEXT_CONFLICT]) {
      const entry = planEntry(plan, path);
      expect(entry.action).toBe("review");
      expect(entry.staged.theirs).toBe(`files/${path}.staged`);
      expect(entry.staged.merged).toBeUndefined();
    }
    // JSON merging needs no git.
    expect(planEntry(plan, JSON_MERGE).staged.merged).toBeDefined();
    expect(output().split("\n")).toContain(
      "note: git is not available -- text files changed on both sides need a manual merge",
    );
  });
});

describe("runUpdate: determinism and replacement", () => {
  it("yields a byte-identical plan (bar generatedAt) and staged files on a second run, replacing the first staging", () => {
    olderProject(project, pristine);
    run();
    const normalized = (): string =>
      JSON.stringify({ ...readPlan(project), generatedAt: "" });
    const firstPlan = normalized();
    const firstTree = subtreeOf(snapshotTree(project), UPDATE_DIR);
    delete firstTree[`${UPDATE_DIR}/plan.json`];
    writeFileSync(join(project, UPDATE_DIR, "leftover.staged"), "stale");
    run();
    expect(normalized()).toBe(firstPlan);
    const secondTree = subtreeOf(snapshotTree(project), UPDATE_DIR);
    delete secondTree[`${UPDATE_DIR}/plan.json`];
    expect(secondTree).toEqual(firstTree);
    expect(stagedFiles(project)).not.toContain("leftover.staged");
  });

  it("proposes a lock-next with the epoch updatedAt when the project has no lock", () => {
    bootstrapFresh(project);
    simulateOlder(project, TAKE, "older: true\n");
    rmSync(join(project, LOCK_FILE));
    const core = currentCoreHashes();
    core[TAKE] = sha256("older: true\n");
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: { "1.0.0": { core, packs: {} } },
      blobs: { [sha256("older: true\n")]: "older: true\n" },
    };
    expect(
      runUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        { history: { history }, runningVersion: RUNNING },
      ),
    ).toBe(0);
    const plan = readPlan(project);
    expect(plan.base.lockSha256).toBeNull();
    const next = parseLock(readStaged(project, "lock-next.json"));
    expect(next.updatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("runUpdate: next step", () => {
  it("advises refreshing /customize first when the project's copy is stale", () => {
    olderProject(project, pristine);
    writeFileSync(
      join(project, ".claude/skills/customize/SKILL.md"),
      "an older skill\n",
    );
    run();
    expect(readPlan(project).skill.status).toBe("stale");
    const next = output()
      .split("\n")
      .find((line) => line.startsWith("next:"));
    expect(next).toContain(".claude/skills/customize/");
    expect(next).toContain(".groundwork/update/customize/");
    expect(next).toContain("/customize update");
    expect(next).not.toMatch(/--(apply|customize|install)/);
  });

  it("gives the same advice when the skill is absent", () => {
    olderProject(project, pristine);
    rmSync(join(project, ".claude/skills/customize"), { recursive: true });
    run();
    expect(readPlan(project).skill.status).toBe("absent");
    expect(output()).toContain(".groundwork/update/customize/");
  });
});

describe("runUpdate: --base-version", () => {
  it("overrides the lock's base and records its source as flag", () => {
    olderProject(project, pristine);
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.0.0": { core: {}, packs: {} },
        "1.0.5": {
          core: { ...currentCoreHashes(), [TAKE]: sha256("older: true\n") },
          packs: {},
        },
      },
      blobs: {},
    };
    expect(
      runUpdate(
        { targetDir: project, baseVersion: "1.0.5" },
        { history: { history }, runningVersion: RUNNING },
      ),
    ).toBe(0);
    expect(readPlan(project).base).toMatchObject({
      version: "1.0.5",
      source: "flag",
    });
    expect(output()).toContain(`staged update 1.0.5 -> ${RUNNING}`);
  });
});

describe("runUpdate: ledger packs", () => {
  it("stages the current manifest and plans the wiring diff of an outdated pack", () => {
    bootstrapFresh(project, ["quality"]);
    const pack = loadPack("quality");
    const current = serializePackManifest(pack.manifest) as string;
    const oldManifest = {
      ...pack.manifest,
      wiring: {
        ...pack.manifest.wiring,
        verifySteps: [
          ...pack.manifest.wiring.verifySteps,
          {
            id: "old-step",
            group: "build",
            name: "Old",
            cmd: ["node", "o.mjs"],
          },
        ],
      },
    };
    const oldText = serializePackManifest(oldManifest) as string;
    const version = "1.0.0";
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        [version]: {
          core: currentCoreHashes(),
          packs: {
            quality: {
              manifest: sha256(oldText),
              files: templateFileHashes(pack.filesDir),
            },
          },
        },
      },
      blobs: { [sha256(oldText)]: oldText },
    };
    writeTree(project, {
      [LEDGER_PATH]: JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            name: "quality",
            cliVersion: version,
            manifestSha256: sha256(oldText),
          },
        ],
      }),
      "bin/lib/verify-steps.packs.json": JSON.stringify(
        oldManifest.wiring.verifySteps,
      ),
    });
    simulateOlder(project, TAKE, "older: true\n");

    expect(
      runUpdate(
        { targetDir: project },
        { history: { history }, runningVersion: RUNNING },
      ),
    ).toBe(0);
    expect(readStaged(project, "packs/quality/pack.json.staged")).toBe(current);
    const [entry] = readPlan(project).packs;
    expect(entry).toMatchObject({
      name: "quality",
      ledgerVersion: version,
      outdated: true,
    });
    expect(entry?.wiring.removed).toEqual([
      expect.objectContaining({
        key: "verifySteps:old-step",
        removable: true,
      }),
    ]);
  });
});

describe("runUpdate: a base known only from the template history", () => {
  it("stages base/ for merge, conflict and review entries, alongside their other versions", () => {
    const theirs = olderProject(project, pristine).theirs;
    const history = moveBaseToHistory(project, [
      TEXT_MERGE,
      TEXT_CONFLICT,
      BINARY,
    ]);
    expect(
      runUpdate({ targetDir: project }, { history, runningVersion: RUNNING }),
    ).toBe(0);
    const plan = readPlan(project);
    expect(planEntry(plan, TEXT_MERGE).action).toBe("merge");
    expect(planEntry(plan, TEXT_CONFLICT).action).toBe("conflict");
    expect(planEntry(plan, BINARY).action).toBe("review");
    for (const path of [TEXT_MERGE, TEXT_CONFLICT, BINARY]) {
      expect(planEntry(plan, path).staged.base).toBe(`base/${path}.staged`);
      expect(stagedFiles(project)).toContain(`base/${path}.staged`);
    }
    expect(readStaged(project, `base/${TEXT_MERGE}.staged`)).toContain(
      "// old header",
    );
    expect(readStaged(project, `files/${BINARY}.staged`)).toBe(theirs(BINARY));
    expect(planEntry(plan, TEXT_CONFLICT).staged.theirs).toBe(
      `files/${TEXT_CONFLICT}.staged`,
    );
  });

  it("stages base/ for the files that need a manual merge when git is unavailable", () => {
    olderProject(project, pristine);
    const history = moveBaseToHistory(project, [TEXT_MERGE, TEXT_CONFLICT]);
    mkdirSync(join(root, "no-bin"));
    process.env["PATH"] = join(root, "no-bin");
    runUpdate({ targetDir: project }, { history, runningVersion: RUNNING });
    const plan = readPlan(project);
    for (const path of [TEXT_MERGE, TEXT_CONFLICT]) {
      expect(planEntry(plan, path)).toMatchObject({
        action: "review",
        staged: { theirs: `files/${path}.staged`, base: `base/${path}.staged` },
      });
    }
  });
});

describe("runUpdate: rename and delete", () => {
  const OLD = "legacy-workspace.yaml";
  const NEW = "pnpm-workspace.yaml";
  const GONE = "legacy-gone.txt";
  let migrationsPath: string;

  function legacyProject(): string {
    bootstrapFresh(project);
    bootstrapFresh(pristine);
    changeLockFiles(project, (files) =>
      files.filter((file) => file.path !== NEW),
    );
    rmSync(join(project, NEW));
    seedLegacyFile(project, OLD, "packages: []\n");
    seedLegacyFile(project, GONE, "removed upstream\n");
    migrationsPath = join(root, "migrations.json");
    writeFileSync(
      migrationsPath,
      JSON.stringify([
        {
          id: "rename-workspace",
          since: "1.0.1",
          renames: [{ from: OLD, to: NEW }],
        },
      ]),
    );
    return readText(pristine, NEW);
  }

  function runLegacy(): UpdatePlan {
    const deps = updateDeps();
    const core = { ...deps.history.history.versions["1.0.0"]?.core };
    delete core[NEW];
    runUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      {
        history: {
          history: {
            ...deps.history.history,
            versions: { "1.0.0": { core, packs: {} } },
          },
        },
        runningVersion: RUNNING,
        migrationsPath,
      },
    );
    return readPlan(project);
  }

  it("stages a renamed file's theirs at the target path and drops the old lock entry", () => {
    const newText = legacyProject();
    const before = outsideUpdate(project);
    const plan = runLegacy();
    const entry = planEntry(plan, OLD);
    expect(entry).toMatchObject({ action: "rename", renamedTo: NEW });
    expect(entry.staged).toEqual({ theirs: `files/${NEW}.staged` });
    expect(readStaged(project, `files/${NEW}.staged`)).toBe(newText);
    expect(plan.files.some((file) => file.path === NEW)).toBe(false);
    expect(plan.migrations).toContain("rename-workspace");
    expect(outsideUpdate(project)).toEqual(before);

    const next = parseLock(readStaged(project, "lock-next.json"));
    expect(next.files.some((file) => file.path === OLD)).toBe(false);
    expect(next.files.find((file) => file.path === NEW)).toMatchObject({
      baseSha256: sha256(newText),
      status: "installed",
    });
  });

  it("stages nothing for a file removed upstream and drops it from lock-next", () => {
    legacyProject();
    const plan = runLegacy();
    const entry = planEntry(plan, GONE);
    expect(entry.action).toBe("delete");
    expect(entry.staged).toEqual({});
    expect(stagedFiles(project).filter((name) => name.includes(GONE))).toEqual(
      [],
    );
    const next = parseLock(readStaged(project, "lock-next.json"));
    expect(next.files.some((file) => file.path === GONE)).toBe(false);
    expect(readText(project, GONE)).toBe("removed upstream\n");
  });
});
