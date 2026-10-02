// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `observeWiring` (`packs.ts`) calls a bare `readFileSync` on
 * `.claude/settings.json` once it has established (via `existsSync`) that
 * the file exists. An `EACCES`/`EPERM` on that read is a property of the
 * project file itself and must land as an observation string rather than
 * throwing (see `packs.test.ts`'s own permission-based suite); any OTHER
 * read failure (`EIO`, say) says something about the machine, not the
 * project, and must propagate as a thrown `Error` naming the settings path,
 * with the original failure chained as `cause`. `node:fs`'s `readFileSync`
 * is mocked (`importOriginal`-preserving) in this file ONLY, matching the
 * isolation pattern every other mocked-`node:fs` sibling file uses (see
 * `pack-stage-statsync-plan-error.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackManifest } from "../src/packs.js";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, readFileSync: readFileSyncMock };
});

const { observeWiring } = await import("../src/packs.js");

function manifest(): PackManifest {
  return {
    schemaVersion: 1,
    name: "demo",
    description: "demo",
    modes: ["fresh", "adopt"],
    budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
    requires: undefined,
    wiring: {
      settings: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
      packageScripts: {},
      verifySteps: [],
    },
    adoptNotes: undefined,
  };
}

describe("observeWiring -- a non-permission readFileSync failure on settings.json propagates, not folded into an observation", () => {
  let targetDir: string;
  let settingsPath: string;
  let realReadFileSync: typeof FsModule.readFileSync;
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReadFileSync = actual.readFileSync;
    readFileSyncMock.mockReset();
    targetDir = mkdtempSync(join(tmpdir(), "observe-wiring-io-"));
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    settingsPath = join(targetDir, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));

    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.readFileSync>) => {
        const [path] = args;
        if (path === settingsPath) {
          throw ioFailure;
        }
        return (
          realReadFileSync as (
            ...callArgs: Parameters<typeof FsModule.readFileSync>
          ) => ReturnType<typeof FsModule.readFileSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("throws an Error naming settings.json's path, with the original EIO failure chained as cause", () => {
    let thrown: unknown;
    try {
      observeWiring(targetDir, manifest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(ioFailure);
    expect((thrown as Error).message).toContain(settingsPath);
    expect((thrown as Error).cause).toBe(ioFailure);
  });
});

/**
 * `readSettingsOrObserve` (`packs.ts`) discriminates a read failure with
 * `permissionCode` alone (`EACCES`/`EPERM`), unlike `conflicts.ts`'s
 * `compareFile` and `read-guard.ts`'s own `guardedRead`, which both go
 * through the wider `recordedReadCode` (`EACCES`/`EPERM`/`ENOENT`/`ELOOP`/
 * `EISDIR`). A directory sitting at `.claude/settings.json` is a property of
 * the project's own tree -- `existsOrObserve`'s prior `stat` reports
 * `present` (a `stat` on a directory succeeds), and the subsequent
 * `readFileSync` then raises `EISDIR` -- exactly like the bare-file EISDIR
 * case `conflicts.test.ts`/`read-guard.test.ts` already guard elsewhere.
 * RED today: `observeWiring` throws instead of recording an observation,
 * which aborts the whole adopt-mode `packs` computation for every pack
 * (see `main.ts`'s un-try/catch'd `.map` over `observeWiring`).
 */
describe("observeWiring -- a directory sitting at .claude/settings.json (EISDIR on the read) is recorded as an observation, not thrown", () => {
  let targetDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(actual.readFileSync);
    targetDir = mkdtempSync(join(tmpdir(), "observe-wiring-eisdir-"));
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    settingsPath = join(targetDir, ".claude", "settings.json");
    mkdirSync(settingsPath);
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("records an observation naming the path and EISDIR instead of throwing", () => {
    let thrown: unknown;
    let observations: string[] = [];
    try {
      observations = observeWiring(targetDir, manifest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(
      observations.some(
        (o) => o.includes(settingsPath) && o.includes("EISDIR"),
      ),
    ).toBe(true);
  });
});

/**
 * A benign TOCTOU race: `existsOrObserve`'s `stat` finds the file present,
 * but it vanishes (another process, a concurrent `rm`) before the
 * subsequent `readFileSync` runs, which then raises `ENOENT`. This is a
 * property of the project's tree at the moment of the race, not of the
 * machine -- the same reasoning `read-guard.ts`'s `guardedRead` already
 * applies to a dangling-symlink `ENOENT`. RED today: `permissionCode`
 * does not recognize `ENOENT`, so `observeWiring` throws instead of
 * recording an observation and continuing.
 */
describe("observeWiring -- settings.json vanishes between the exists probe and the read (ENOENT race) is recorded as an observation, not thrown", () => {
  let targetDir: string;
  let settingsPath: string;
  let realReadFileSync: typeof FsModule.readFileSync;
  const raceFailure = Object.assign(new Error("simulated ENOENT race"), {
    code: "ENOENT",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReadFileSync = actual.readFileSync;
    readFileSyncMock.mockReset();
    targetDir = mkdtempSync(join(tmpdir(), "observe-wiring-race-"));
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    settingsPath = join(targetDir, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));

    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.readFileSync>) => {
        const [path] = args;
        if (path === settingsPath) {
          throw raceFailure;
        }
        return (
          realReadFileSync as (
            ...callArgs: Parameters<typeof FsModule.readFileSync>
          ) => ReturnType<typeof FsModule.readFileSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("records an observation naming the path and ENOENT instead of throwing", () => {
    let thrown: unknown;
    let observations: string[] = [];
    try {
      observations = observeWiring(targetDir, manifest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(
      observations.some(
        (o) => o.includes(settingsPath) && o.includes("ENOENT"),
      ),
    ).toBe(true);
  });
});
