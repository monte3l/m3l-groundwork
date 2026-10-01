// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s pack-staging ordering (issue #99): the pack surveys
 * (`planConflicts`/`observeWiring`) are computed first, then
 * `assertAdoptWriteScope(targetDir, plannedPackStagingPaths(...))` runs
 * BEFORE any pack file is written, and only then does `stagePacks` run. A
 * real escaping path can't be constructed through the CLI itself: `--name`
 * is validated against `NPM_NAME_PATTERN` (no `..` survives it) and adopt
 * mode's default project name is `basename(targetDir)`, which can never
 * contain a path separator either -- so this file proves the ordering by
 * mocking `../src/pack-stage.js`'s `plannedPackStagingPaths` to throw (the
 * same shape a real CWE-22 escape would produce) and spying on `stagePacks`
 * to prove it is never reached, the same isolation pattern
 * `main-pack-errors.test.ts` uses for `packs.js` and
 * `main-pack-wiring-keys.test.ts` uses for proving a failure happens before
 * `.groundwork/` is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PackStageModule from "../src/pack-stage.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));
const installCustomizeSkillGuardedMock = vi.fn(() => ({
  filesWritten: [],
  location: "claude" as const,
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: installCustomizeSkillGuardedMock,
}));

const { plannedPackStagingPathsMock, stagePacksMock, callOrder } = vi.hoisted(
  () => ({
    plannedPackStagingPathsMock: vi.fn(),
    stagePacksMock: vi.fn(),
    callOrder: [] as string[],
  }),
);

vi.mock("../src/pack-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PackStageModule>();
  return {
    ...actual,
    plannedPackStagingPaths: (
      ...args: Parameters<typeof actual.plannedPackStagingPaths>
    ) => {
      callOrder.push("planned");
      return plannedPackStagingPathsMock(...args) as ReturnType<
        typeof actual.plannedPackStagingPaths
      >;
    },
    stagePacks: (...args: Parameters<typeof actual.stagePacks>) => {
      callOrder.push("staged");
      return stagePacksMock(...args) as ReturnType<typeof actual.stagePacks>;
    },
  };
});

const { main } = await import("../src/main.js");

describe("runAdopt pack-staging ordering (#99)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-pack-order-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
    plannedPackStagingPathsMock.mockReset();
    stagePacksMock.mockReset();
    callOrder.length = 0;
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("calls plannedPackStagingPaths (feeding assertAdoptWriteScope) BEFORE stagePacks on a normal run", () => {
    const projectDir = join(targetDir, "project-normal");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );

    plannedPackStagingPathsMock.mockImplementation(() => []);
    stagePacksMock.mockImplementation(() => []);

    main([projectDir]);

    expect(plannedPackStagingPathsMock).toHaveBeenCalled();
    expect(stagePacksMock).toHaveBeenCalled();
    const plannedIndex = callOrder.indexOf("planned");
    const stagedIndex = callOrder.indexOf("staged");
    expect(plannedIndex).toBeGreaterThanOrEqual(0);
    expect(stagedIndex).toBeGreaterThan(plannedIndex);
  });

  it("throws, calls stagePacks NEVER, and writes nothing under .groundwork/packs -- no .packs-* dir either -- when plannedPackStagingPaths (the write-scope check's input) throws an escape before any pack is written", () => {
    const projectDir = join(targetDir, "project-escape");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const groundworkDir = join(projectDir, ".groundwork");
    mkdirSync(groundworkDir, { recursive: true });
    const inventoryPath = join(groundworkDir, "inventory.json");
    const priorInventory = JSON.stringify({
      schemaVersion: 0,
      marker: "pre-existing",
    });
    writeFileSync(inventoryPath, priorInventory);

    const escapeError = new Error(
      "plannedPackStagingPaths: staged path escapes the staging directory",
    );
    plannedPackStagingPathsMock.mockImplementation(() => {
      throw escapeError;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(escapeError);
    expect(stagePacksMock).not.toHaveBeenCalled();
    expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    expect(
      readdirSync(groundworkDir).some((name) => name.startsWith(".packs-")),
    ).toBe(false);
    // The pre-existing inventory.json survives the failed run byte-for-byte
    // -- same discrimination main-pack-wiring-keys.test.ts's adopt-mode test
    // uses for "fails before .groundwork/ is touched".
    expect(existsSync(inventoryPath)).toBe(true);
    expect(readFileSync(inventoryPath, "utf8")).toBe(priorInventory);
  });
});
