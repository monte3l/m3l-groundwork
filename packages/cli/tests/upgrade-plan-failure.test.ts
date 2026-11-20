// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `renderRelease`'s failure branches that need a collaborator to
 * misbehave: a temp-dir removal that fails after a render failure, and a
 * non-Error value thrown while rendering. `node:fs`'s `rmSync` and
 * `emitTemplate` are mocked (importOriginal-preserving, passthrough by
 * default) in this file ONLY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as EmitModule from "../src/emit.js";
import { buildManifest } from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import { writeRelease } from "./upgrade-plan-fixture.js";
import type { WrittenRelease } from "./upgrade-plan-fixture.js";

const { rmSyncMock, emitTemplateMock } = vi.hoisted(() => ({
  rmSyncMock: vi.fn(),
  emitTemplateMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, rmSync: rmSyncMock };
});
vi.mock("../src/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EmitModule>();
  return { ...actual, emitTemplate: emitTemplateMock };
});

const { renderRelease } = await import("../src/upgrade/plan.js");

describe("renderRelease -- failure while rendering", () => {
  let base: string;
  let tmpRoot: string;
  let realRmSync: typeof FsModule.rmSync;
  let manifest: Manifest;
  let release: WrittenRelease;

  beforeEach(async () => {
    const fs = await vi.importActual<typeof FsModule>("node:fs");
    const emit = await vi.importActual<typeof EmitModule>("../src/emit.js");
    realRmSync = fs.rmSync;
    rmSyncMock.mockReset();
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => realRmSync(...args),
    );
    emitTemplateMock.mockReset();
    emitTemplateMock.mockImplementation(
      (...args: Parameters<typeof EmitModule.emitTemplate>) =>
        emit.emitTemplate(...args),
    );
    base = mkdtempSync(join(tmpdir(), "upgrade-plan-failure-"));
    tmpRoot = join(base, "tmp");
    mkdirSync(tmpRoot);
    release = writeRelease(join(base, "rel"), {
      core: { "a.txt": "a\n" },
      packs: {},
    });
    manifest = buildManifest({
      targetDir: release.templatesDir,
      cliVersion: "1.0.0",
      tokens: { PROJECT_NAME: "acme", YEAR: "1999" },
      packs: [],
      files: ["a.txt"],
    });
  });

  afterEach(() => {
    realRmSync(base, { recursive: true, force: true });
  });

  const render = (): void => {
    renderRelease({
      manifest,
      cliVersion: "2.0.0",
      templatesDir: release.templatesDir,
      packsRoot: release.packsRoot,
      tmpRoot,
    });
  };

  it("names both the render failure and the leftover when removing the temp dir fails too", () => {
    emitTemplateMock.mockImplementation(() => {
      throw new Error("render exploded");
    });
    rmSyncMock.mockImplementation(() => {
      throw new Error("cleanup refused");
    });

    let thrown: unknown;
    try {
      render();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("render exploded");
    expect(message).toContain("cleanup refused");
    const left = readdirSync(tmpRoot);
    expect(left).toHaveLength(1);
    expect(message).toContain(join(tmpRoot, left[0] ?? ""));
    expect(((thrown as Error).cause as Error).message).toBe("render exploded");
  });

  it("reports a non-Error cleanup failure in the message too", () => {
    emitTemplateMock.mockImplementation(() => {
      throw new Error("render exploded");
    });
    rmSyncMock.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the cleanup failure is stringified
      throw "disk on fire";
    });

    expect(render).toThrowError(/render exploded.*disk on fire/s);
  });

  it("wraps a non-Error value thrown while rendering, keeping it as cause", () => {
    emitTemplateMock.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify it is still wrapped
      throw "plain boom";
    });

    let thrown: unknown;
    try {
      render();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("plain boom");
    expect((thrown as Error).message).toContain("2.0.0");
    expect((thrown as Error).cause).toBe("plain boom");
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
