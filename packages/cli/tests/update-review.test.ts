// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runUpdate`'s review-fix contract: `lock-next.json` keeps the OLD base of a
 * file the update leaves alone and follows each entry's `default`; a guarded
 * read of the project file at staging time; a cleanup failure is never lost;
 * the packaging-defect and note branches; and `--update` / `--check-update`
 * agreeing on whether an update is available. Real temp projects, real git
 * unless a fake `git` is put on PATH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckUpdate } from "../src/check-update.js";
import { buildLock, LOCK_FILE, parseLock, serializeLock } from "../src/lock.js";
import type { LockFile } from "../src/lock.js";
import { loadPack, serializePackManifest } from "../src/packs.js";
import { LEDGER_PATH, templateFileHashes } from "../src/pack-installation.js";
import { buildTheirsTree } from "../src/theirs-tree.js";
import type { TemplateHistory } from "../src/template-history.js";
import { classifyProject } from "../src/update-classify.js";
import type {
  ClassifyProjectInput,
  UpdateFileEntry,
} from "../src/update-classify.js";
import { CliUsageError } from "../src/usage.js";
import { runUpdate } from "../src/update.js";
import { snapshotTree } from "./add-pack-fixtures.js";
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
  JSON_MERGE,
  RUNNING,
  TAKE,
  TEXT_CONFLICT,
  TEXT_MERGE,
  UPDATE_DIR,
  changeLockFiles,
  currentCoreHashes,
  historyWith,
  moveBaseToHistory,
  olderProject,
  planEntry,
  readPlan,
  readStaged,
  seedLegacyFile,
  stagedFiles,
  updateDeps,
} from "./update-fixtures.js";

let root: string;
let project: string;
let pristine: string;
let log: MockInstance<typeof console.log>;
let savedPath: string | undefined;
let savedGlobal: string | undefined;
let savedNoSystem: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "update-review-"));
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
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const output = (): string =>
  log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

const lockNext = () => parseLock(readStaged(project, "lock-next.json"));
const lockEntry = (
  files: readonly LockFile[],
  path: string,
): LockFile | undefined => files.find((file) => file.path === path);

function rewriteLock(origin: "fresh" | "adopt"): void {
  const lock = readLockOrThrow(project);
  writeFileSync(
    join(project, LOCK_FILE),
    serializeLock(
      buildLock({
        baseVersion: lock.baseVersion,
        origin,
        tokens: lock.tokens,
        via: lock.via,
        updatedAt: lock.updatedAt,
        skip: lock.skip,
        files: lock.files,
      }),
    ),
  );
}

/** `history` plus the running version, as the lock-next base needs. */
function withRunning(history: { history: TemplateHistory }): {
  history: TemplateHistory;
} {
  return {
    history: {
      ...history.history,
      versions: {
        ...history.history.versions,
        [RUNNING]: { core: currentCoreHashes(), packs: {} },
      },
    },
  };
}

/** Adopts `lock-next.json` as the project's lock and classifies again. */
function classifyWithLockNext(history: {
  history: TemplateHistory;
}): Map<string, string> {
  writeFileSync(
    join(project, LOCK_FILE),
    readStaged(project, "lock-next.json"),
  );
  rmSync(join(project, UPDATE_DIR), { recursive: true, force: true });
  const actions = new Map<string, string>();
  runUpdate(
    { targetDir: project },
    {
      history: withRunning(history),
      runningVersion: RUNNING,
      classify: (input: ClassifyProjectInput) => {
        const result = classifyProject(input);
        for (const entry of result.entries) {
          actions.set(entry.path, entry.action);
        }
        return result;
      },
    },
  );
  return actions;
}

describe("lock-next.json keeps the old base of a file the update leaves alone", () => {
  type Setup = "no lock" | "a lock lacking the path";
  const PATHS = [TEXT_CONFLICT, BINARY] as const;

  function stage(setup: Setup): { history: { history: TemplateHistory } } {
    olderProject(project, pristine);
    const history = moveBaseToHistory(project, PATHS);
    if (setup === "no lock") {
      rmSync(join(project, LOCK_FILE));
      runUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        { history, runningVersion: RUNNING },
      );
    } else {
      changeLockFiles(project, (files) =>
        files.filter((file) => !PATHS.some((path) => path === file.path)),
      );
      runUpdate({ targetDir: project }, { history, runningVersion: RUNNING });
    }
    return { history };
  }

  describe.each(["no lock", "a lock lacking the path"] as const)(
    "with %s",
    (setup) => {
      it("stages a text conflict and a review as such", () => {
        stage(setup);
        const plan = readPlan(project);
        expect(planEntry(plan, TEXT_CONFLICT).action).toBe("conflict");
        expect(planEntry(plan, BINARY).action).toBe("review");
      });

      it.each(PATHS)(
        "records %s with the OLD base hash, its source and status installed",
        (path) => {
          const { history } = stage(setup);
          const oldHash = history.history.versions["1.0.0"]?.core[path];
          expect(oldHash).toBeDefined();
          expect(sha256(readText(pristine, path))).not.toBe(oldHash);
          expect(lockEntry(lockNext().files, path)).toEqual({
            path,
            source: "core",
            baseSha256: oldHash,
            status: "installed",
          });
        },
      );

      it("still needs attention when lock-next.json becomes the lock and the owner kept their file", () => {
        const { history } = stage(setup);
        const actions = classifyWithLockNext(history);
        for (const path of PATHS) {
          expect(actions.get(path)).not.toBe("keep");
          expect(actions.get(path)).not.toBe("current");
          expect(["review", "conflict", "merge"]).toContain(actions.get(path));
        }
      });
    },
  );
});

describe("lock-next.json follows each entry's default, not its action", () => {
  it("advances apply entries only, keeping the old base of an adopted merge and add", () => {
    const theirs = olderProject(project, pristine).theirs;
    rewriteLock("adopt");
    const oldBy = new Map(
      readLockOrThrow(project).files.map((file) => [file.path, file]),
    );
    runUpdate({ targetDir: project }, updateDeps());
    const plan = readPlan(project);
    // Both arms are reachable: the take applies, the adopted merge/add ask.
    expect(planEntry(plan, TAKE)).toMatchObject({
      action: "take",
      default: "apply",
    });
    expect(planEntry(plan, TEXT_MERGE)).toMatchObject({
      action: "merge",
      default: "ask",
    });
    expect(planEntry(plan, ADDED)).toMatchObject({
      action: "add",
      default: "ask",
    });
    const next = lockNext();
    expect(lockEntry(next.files, TAKE)?.baseSha256).toBe(sha256(theirs(TAKE)));
    expect(lockEntry(next.files, TEXT_MERGE)).toEqual(oldBy.get(TEXT_MERGE));
    expect(lockEntry(next.files, ADDED)?.baseSha256).not.toBe(
      sha256(theirs(ADDED)),
    );
  });

  describe("a rename whose local copy was edited (default ask)", () => {
    const OLD = "legacy-workspace.yaml";
    const NEW = "pnpm-workspace.yaml";

    it("keeps the old path's lock entry and does not install the new path", () => {
      bootstrapFresh(project);
      bootstrapFresh(pristine);
      changeLockFiles(project, (files) =>
        files.filter((file) => file.path !== NEW),
      );
      rmSync(join(project, NEW));
      seedLegacyFile(project, OLD, "packages: []\n");
      writeFileSync(
        join(project, OLD),
        "packages: []\n# edited by the owner\n",
      );
      const oldEntry = lockEntry(readLockOrThrow(project).files, OLD);
      const migrationsPath = join(root, "migrations.json");
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
      const core = { ...updateDeps().history.history.versions["1.0.0"]?.core };
      delete core[NEW];
      runUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        {
          history: {
            history: {
              schemaVersion: 1,
              versions: { "1.0.0": { core, packs: {} } },
              blobs: {},
            },
          },
          runningVersion: RUNNING,
          migrationsPath,
        },
      );
      expect(planEntry(readPlan(project), OLD)).toMatchObject({
        action: "rename",
        default: "ask",
      });
      const next = lockNext();
      expect(oldEntry).toBeDefined();
      expect(lockEntry(next.files, OLD)).toEqual(oldEntry);
      expect(lockEntry(next.files, NEW)?.baseSha256).not.toBe(
        sha256(readText(pristine, NEW)),
      );
    });
  });
});

describe("a guarded read of the project file at staging time", () => {
  const SECRET = "OUTSIDE-SECRET-MARKER";

  function runWithSwap(swap: () => void): number {
    olderProject(project, pristine);
    return runUpdate(
      { targetDir: project },
      {
        ...updateDeps(),
        classify: (input: ClassifyProjectInput) => {
          const result = classifyProject(input);
          swap();
          return result;
        },
      },
    );
  }

  function expectNoStagedSecret(): void {
    for (const rel of stagedFiles(project)) {
      expect(
        readFileSync(join(project, UPDATE_DIR, rel), "utf8"),
      ).not.toContain(SECRET);
    }
  }

  it("a file that became a symlink to an outside file is a review, and nothing outside is read or written", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
    const outsideBefore = snapshotTree(outside);
    const code = runWithSwap(() => {
      rmSync(join(project, TEXT_MERGE));
      symlinkSync(join(outside, "secret.txt"), join(project, TEXT_MERGE));
    });
    expect(code).toBe(0);
    expectNoStagedSecret();
    const plan = readPlan(project);
    expect(planEntry(plan, TEXT_MERGE).action).toBe("review");
    expect(planEntry(plan, TEXT_MERGE).staged.merged).toBeUndefined();
    expect(plan.undetermined.some((note) => note.includes(TEXT_MERGE))).toBe(
      true,
    );
    expect(
      output()
        .split("\n")
        .some((line) => line.startsWith("note:") && line.includes(TEXT_MERGE)),
    ).toBe(true);
    expect(snapshotTree(outside)).toEqual(outsideBefore);
  });

  it("a directory in place of the file is a review with a note, never a thrown defect", () => {
    const code = runWithSwap(() => {
      rmSync(join(project, TEXT_MERGE));
      mkdirSync(join(project, TEXT_MERGE));
    });
    expect(code).toBe(0);
    const plan = readPlan(project);
    expect(planEntry(plan, TEXT_MERGE).action).toBe("review");
    expect(plan.undetermined.some((note) => note.includes(TEXT_MERGE))).toBe(
      true,
    );
  });
});

describe("a leftover theirs directory is never lost", () => {
  /** Wraps `buildTheirsTree` so cleanup fails without removing the tree. */
  function failingCleanup(): {
    build: typeof buildTheirsTree;
    leftover: () => string;
  } {
    let dir = "";
    return {
      leftover: () => dir,
      build: (input) => {
        const real = buildTheirsTree(input);
        dir = real.dir;
        return {
          ...real,
          cleanup: () => {
            throw new Error("cleanup failed");
          },
        };
      },
    };
  }

  it("warns on stderr naming the directory when staging throws too, and the staging error still propagates", () => {
    olderProject(project, pristine);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { build, leftover } = failingCleanup();
    let thrown: unknown;
    try {
      runUpdate(
        { targetDir: project },
        {
          ...updateDeps(),
          buildTheirs: build,
          classify: () => {
            throw new Error("staging exploded");
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    const seen = [
      ...warn.mock.calls.map((call) => call.map(String).join(" ")),
      ...write.mock.calls.map((call) => String(call[0])),
    ].join("\n");
    const dir = leftover();
    rmSync(dir, { recursive: true, force: true });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("staging exploded");
    expect(dir).not.toBe("");
    expect(seen).toContain(dir);
  });

  it("prints a note naming the directory when staging succeeds and cleanup fails", () => {
    olderProject(project, pristine);
    const { build, leftover } = failingCleanup();
    expect(
      runUpdate(
        { targetDir: project },
        { ...updateDeps(), buildTheirs: build },
      ),
    ).toBe(0);
    const dir = leftover();
    rmSync(dir, { recursive: true, force: true });
    expect(
      output()
        .split("\n")
        .some(
          (line) =>
            line.startsWith("note: could not remove the temporary directory") &&
            line.includes(dir),
        ),
    ).toBe(true);
  });
});

describe("packaging defects and notes", () => {
  const entryFor = (
    path: string,
    action: UpdateFileEntry["action"],
    extra: Partial<UpdateFileEntry> = {},
  ): UpdateFileEntry => ({
    path,
    source: "core",
    action,
    default: "apply",
    reason: "injected",
    baseSha256: null,
    oursSha256: null,
    theirsSha256: null,
    baseFrom: null,
    ...extra,
  });

  it.each([
    ["take", "no-such-template.txt", {}, "no-such-template.txt"],
    ["add", "no-such-template.txt", {}, "no-such-template.txt"],
    [
      "rename",
      "old-name.txt",
      { renamedTo: "missing-target.txt" },
      "missing-target.txt",
    ],
  ] as const)(
    "a planned %s whose file the templates lack is a plain Error naming it, with nothing staged",
    (action, path, extra, missing) => {
      olderProject(project, pristine);
      let thrown: unknown;
      try {
        runUpdate(
          { targetDir: project },
          {
            ...updateDeps(),
            classify: (input: ClassifyProjectInput) => {
              const result = classifyProject(input);
              return {
                ...result,
                entries: [...result.entries, entryFor(path, action, extra)],
              };
            },
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toMatch(/templates have no/);
      expect((thrown as Error).message).toContain(missing);
      expect(existsSync(join(project, UPDATE_DIR))).toBe(false);
    },
  );

  it("a JSON merge that turns out unmergeable becomes a review with the reason", () => {
    olderProject(project, pristine);
    const code = runUpdate(
      { targetDir: project },
      {
        ...updateDeps(),
        classify: (input: ClassifyProjectInput) => {
          const result = classifyProject(input);
          writeFileSync(join(project, JSON_MERGE), "{ not json");
          return {
            ...result,
            entries: result.entries.map((entry) =>
              entry.path === JSON_MERGE
                ? {
                    ...entry,
                    action: "merge" as const,
                    default: "apply" as const,
                  }
                : entry,
            ),
          };
        },
      },
    );
    expect(code).toBe(0);
    const entry = planEntry(readPlan(project), JSON_MERGE);
    expect(entry.action).toBe("review");
    expect(entry.staged.merged).toBeUndefined();
    expect(entry.staged.theirs).toBe(`files/${JSON_MERGE}.staged`);
  });

  it("a git failure on one file while git is present is a review with a note", () => {
    olderProject(project, pristine);
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 9.9.9"; exit 0; fi\nexit 200\n',
    );
    chmodSync(join(bin, "git"), 0o755);
    process.env["PATH"] = bin;
    expect(runUpdate({ targetDir: project }, updateDeps())).toBe(0);
    const plan = readPlan(project);
    expect(plan.merge.tool).toBe("git-merge-file");
    for (const path of [TEXT_MERGE, TEXT_CONFLICT]) {
      expect(planEntry(plan, path).action).toBe("review");
    }
    expect(
      output()
        .split("\n")
        .some(
          (line) =>
            line.startsWith("note:") &&
            line.includes(TEXT_MERGE) &&
            line.includes("manual merge"),
        ),
    ).toBe(true);
  });

  it("a theirs tree that cannot be built is a plain Error, with nothing staged and no temp tree left", () => {
    olderProject(project, pristine);
    const scratch = mkdtempSync(join(tmpdir(), "update-review-tmp-"));
    vi.stubEnv("TMPDIR", scratch);
    try {
      let thrown: unknown;
      try {
        runUpdate(
          { targetDir: project },
          {
            ...updateDeps(),
            buildTheirs: () => {
              throw new Error("layout boom");
            },
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain("layout boom");
      expect(
        readdirSync(scratch).filter((name) => name.startsWith("m3l-theirs-")),
      ).toEqual([]);
      expect(existsSync(join(project, UPDATE_DIR))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("damaged migrations stop the run with a plain Error before anything is written", () => {
    olderProject(project, pristine);
    const migrationsPath = join(root, "migrations.json");
    writeFileSync(migrationsPath, "{ not json");
    let thrown: unknown;
    try {
      runUpdate({ targetDir: project }, { ...updateDeps(), migrationsPath });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect(existsSync(join(project, UPDATE_DIR))).toBe(false);
  });

  describe("ledger pack wiring notes", () => {
    function qualityProject(blob: string | undefined): {
      history: TemplateHistory;
    } {
      bootstrapFresh(project, ["quality"]);
      const pack = loadPack("quality");
      void serializePackManifest(pack.manifest);
      const manifestHash = sha256(blob ?? "no blob recorded");
      const history: TemplateHistory = {
        schemaVersion: 1,
        versions: {
          "1.0.0": {
            core: currentCoreHashes(),
            packs: {
              quality: {
                manifest: manifestHash,
                files: templateFileHashes(pack.filesDir),
              },
            },
          },
        },
        blobs: blob === undefined ? {} : { [manifestHash]: blob },
      };
      writeTree(project, {
        [LEDGER_PATH]: JSON.stringify({
          schemaVersion: 1,
          packs: [
            {
              name: "quality",
              cliVersion: "1.0.0",
              manifestSha256: manifestHash,
            },
          ],
        }),
      });
      simulateOlder(project, TAKE, "older: true\n");
      return { history };
    }

    function stageAndNotes(blob: string | undefined): string {
      const { history } = qualityProject(blob);
      expect(
        runUpdate(
          { targetDir: project },
          { history: { history }, runningVersion: RUNNING },
        ),
      ).toBe(0);
      const [entry] = readPlan(project).packs;
      expect(entry).toMatchObject({ name: "quality", outdated: true });
      expect(entry?.wiring).toEqual({ added: [], removed: [], changed: [] });
      return output();
    }

    it("notes that the history has no manifest for the recorded version, planning no wiring change", () => {
      expect(stageAndNotes(undefined)).toMatch(
        /note: pack "quality": .*no manifest for 1\.0\.0/,
      );
    });

    it("notes an unparsable recorded manifest as not readable", () => {
      expect(stageAndNotes("{ not json")).toMatch(
        /note: pack "quality": .*not readable/,
      );
    });

    const good = {
      settings: {},
      packageScripts: {},
      verifySteps: [] as unknown[],
    };
    it.each([
      ["no wiring at all", undefined],
      [
        "settings entries that are not an array",
        { ...good, settings: { E: "x" } },
      ],
      [
        "a settings entry without a hooks array",
        { ...good, settings: { E: [{ matcher: "Bash" }] } },
      ],
      [
        "a hook without a string command",
        { ...good, settings: { E: [{ hooks: [{ command: 1 }] }] } },
      ],
      ["a non-string package script", { ...good, packageScripts: { a: 1 } }],
      ["verifySteps that is not an array", { ...good, verifySteps: "x" }],
      [
        "a verify step without an id",
        { ...good, verifySteps: [{ name: "n" }] },
      ],
      ["a non-object settingsTopLevel", { ...good, settingsTopLevel: 3 }],
    ] as const)(
      "notes a recorded manifest with %s as not readable",
      (_name, wiring) => {
        const manifest = { ...loadPack("quality").manifest, wiring };
        expect(stageAndNotes(JSON.stringify(manifest))).toMatch(
          /note: pack "quality": .*not readable/,
        );
      },
    );
  });
});

describe("--update and --check-update agree on whether an update is available", () => {
  const FINAL =
    "up to date (base 1.0.0 (lock), CLI 99.0.0): 1 file(s) changed upstream, but your project already matches or keeps them";

  /** Upstream changed TAKE since 1.0.0, yet nothing would change here. */
  const NOTHING_TO_DO: readonly [string, () => { history: TemplateHistory }][] =
    [
      [
        "the owner already applied the upstream change by hand",
        () => {
          bootstrapFresh(project);
          simulateOlder(
            project,
            TAKE,
            "older: true\n",
            readText(project, TAKE),
          );
          return historyWith({
            ...currentCoreHashes(),
            [TAKE]: sha256("older: true\n"),
          });
        },
      ],
      [
        "the owner edited a file whose recorded base already is upstream's current text",
        () => {
          bootstrapFresh(project);
          // The lock (base 1.0.0) records upstream's current text as the
          // base, while the shipped 1.0.0 history holds an older one.
          simulateOlder(project, TAKE, readText(project, TAKE), "mine: true\n");
          return historyWith({
            ...currentCoreHashes(),
            [TAKE]: sha256("older: true\n"),
          });
        },
      ],
    ];

  it.each(NOTHING_TO_DO)(
    "both report nothing to do when %s",
    (_name, setup) => {
      const history = setup();
      const deps = { history, runningVersion: RUNNING };
      const before = snapshotTree(project);

      expect(runCheckUpdate({ targetDir: project }, deps)).toBe(0);
      const lines = output().split("\n");
      expect(lines).toContain("1 file(s) changed upstream, 0 added, 0 removed");
      expect(lines.at(-1)).toBe(FINAL);
      expect(output()).not.toContain("update available");

      log.mockClear();
      expect(runUpdate({ targetDir: project }, deps)).toBe(0);
      expect(output()).toContain("already up to date");
      expect(output()).not.toContain("staged update");
      expect(snapshotTree(project)).toEqual(before);
    },
  );

  it("both report an update when a file would change", () => {
    olderProject(project, pristine);
    const deps = updateDeps();
    expect(runCheckUpdate({ targetDir: project }, deps)).toBe(3);
    expect(output()).toContain("update available");
    log.mockClear();
    expect(runUpdate({ targetDir: project }, deps)).toBe(0);
    expect(output()).toContain("staged update");
    expect(existsSync(join(project, UPDATE_DIR, "plan.json"))).toBe(true);
  });
});
