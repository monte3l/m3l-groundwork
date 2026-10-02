// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `fs-guard.ts`'s three symlink/non-directory refusals
 * (`assertNotSymlink`/`assertDirectoryComponent`/`assertFileDestination`)
 * all call `lstatSync(path, { throwIfNoEntry: false })` unguarded --
 * `throwIfNoEntry: false` only suppresses `ENOENT`, so any OTHER `lstat`
 * failure (most realistically `EACCES`, a search-permission-denied ancestor
 * -- fresh mode writing into a pre-existing `.claude` directory a previous
 * run left `chmod 000`, re-run with `--fresh --force`) propagates as the
 * RAW underlying error would propagate with no path named in a readable
 * message, no `--fresh --force` retry advice, and no `cause` set. Every row
 * below asserts that each call instead wraps the failure the same way the
 * rest of this package already wraps a guarded read failure (see
 * `survey/internal/read-guard.ts`).
 *
 * `node:fs` is mocked (`importOriginal`-preserving) only in the "other
 * errnos" describe below, to reach a code a real chmod can't easily
 * reproduce (`EIO`); the EACCES rows use a REAL `chmod 000` ancestor
 * (`it.skipIf(chmodIneffective)`, same guard every other EACCES-inducing
 * test in this package uses) so the genuine syscall is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNotSymlink,
  assertDirectoryComponent,
  assertFileDestination,
  FRESH_SYMLINK_ADVICE,
  FRESH_RETRY,
} from "../src/fs-guard.js";
import { chmodIneffective } from "./chmod-ineffective.js";

type Guard = (path: string, advice: string) => void;

describe.skipIf(chmodIneffective)(
  "fs-guard -- an EACCES lstat failure (chmod 000 ancestor) is wrapped, not left to propagate raw",
  () => {
    let dir: string;
    let locked: string;
    let target: string;

    beforeEach(async () => {
      // lstatSync is mocked for the whole file (see the top-level `vi.mock`
      // below) -- without an explicit passthrough here it would default to
      // `vi.fn()`'s `undefined` return, masking the real chmod-000 syscall
      // this describe block exists to exercise.
      const actual = await vi.importActual<typeof FsModule>("node:fs");
      lstatSyncMock.mockReset();
      lstatSyncMock.mockImplementation(actual.lstatSync);
      dir = mkdtempSync(join(tmpdir(), "fs-guard-eacces-"));
      locked = join(dir, ".claude");
      mkdirSync(locked);
      target = join(locked, "settings.json");
    });

    afterEach(() => {
      lstatSyncMock.mockReset();
      chmodSync(locked, 0o755);
      rmSync(dir, { recursive: true, force: true });
    });

    const GUARDS: [string, Guard][] = [
      ["assertNotSymlink", assertNotSymlink],
      ["assertDirectoryComponent", assertDirectoryComponent],
      ["assertFileDestination", assertFileDestination],
    ];

    it.each(GUARDS)(
      "%s wraps the EACCES failure: an Error naming the path, carrying FRESH --fresh --force advice, with cause set",
      (_name, guard) => {
        chmodSync(locked, 0o000);
        let thrown: unknown;
        try {
          guard(target, FRESH_SYMLINK_ADVICE);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(locked, 0o755);
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(target);
        expect((thrown as Error).message).toContain(FRESH_RETRY);
        expect((thrown as Error).cause).toBeDefined();
        expect(
          (thrown as Error & { cause?: { code?: unknown } }).cause?.code,
        ).toBe("EACCES");
      },
    );

    it.each(GUARDS)(
      "%s gives permission-specific advice for a real EACCES, not the symlink-removal wording -- still naming the path and carrying FRESH --fresh --force advice, cause set",
      (_name, guard) => {
        chmodSync(locked, 0o000);
        let thrown: unknown;
        try {
          guard(target, FRESH_SYMLINK_ADVICE);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(locked, 0o755);
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(target);
        expect(message).toContain(FRESH_RETRY);
        expect(message).not.toContain("remove it");
        expect(message.toLowerCase()).toMatch(/permission/);
        expect((thrown as Error).cause).toBeDefined();
      },
    );
  },
);

const { lstatSyncMock } = vi.hoisted(() => ({ lstatSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, lstatSync: lstatSyncMock };
});

describe("fs-guard -- a non-permission lstat failure (EIO) is wrapped the same way", () => {
  afterEach(() => {
    lstatSyncMock.mockReset();
  });

  const GUARDS: [string, Guard][] = [
    ["assertNotSymlink", assertNotSymlink],
    ["assertDirectoryComponent", assertDirectoryComponent],
    ["assertFileDestination", assertFileDestination],
  ];

  it.each(GUARDS)(
    "%s wraps an EIO lstat failure: an Error naming the path, with the original chained as cause",
    (_name, guard) => {
      const failure = Object.assign(new Error("simulated EIO"), {
        code: "EIO",
      });
      lstatSyncMock.mockImplementation(() => {
        throw failure;
      });
      const path = "/proj/.claude/settings.json";
      let thrown: unknown;
      try {
        guard(path, FRESH_SYMLINK_ADVICE);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBe(failure);
      expect((thrown as Error).message).toContain(path);
      expect((thrown as Error).cause).toBe(failure);
    },
  );

  it.each(GUARDS)(
    "%s keeps the generic (caller-supplied) advice for a non-permission errno -- the symlink-removal wording is NOT replaced",
    (_name, guard) => {
      const failure = Object.assign(new Error("simulated EIO"), {
        code: "EIO",
      });
      lstatSyncMock.mockImplementation(() => {
        throw failure;
      });
      const path = "/proj/.claude/settings.json";
      let thrown: unknown;
      try {
        guard(path, FRESH_SYMLINK_ADVICE);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("remove it");
      expect((thrown as Error).message).toContain(FRESH_RETRY);
    },
  );
});

describe("fs-guard -- a real EPERM lstat failure gets the same permission-specific advice as EACCES", () => {
  afterEach(() => {
    lstatSyncMock.mockReset();
  });

  const GUARDS: [string, Guard][] = [
    ["assertNotSymlink", assertNotSymlink],
    ["assertDirectoryComponent", assertDirectoryComponent],
    ["assertFileDestination", assertFileDestination],
  ];

  it.each(GUARDS)(
    "%s wraps an EPERM lstat failure with permission-specific advice, not the symlink-removal wording -- still naming the path and carrying FRESH --fresh --force advice, cause set",
    (_name, guard) => {
      const failure = Object.assign(new Error("simulated EPERM"), {
        code: "EPERM",
      });
      lstatSyncMock.mockImplementation(() => {
        throw failure;
      });
      const path = "/proj/.claude/settings.json";
      let thrown: unknown;
      try {
        guard(path, FRESH_SYMLINK_ADVICE);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(path);
      expect(message).toContain(FRESH_RETRY);
      expect(message).not.toContain("remove it");
      expect(message.toLowerCase()).toMatch(/permission/);
      expect((thrown as Error).cause).toBe(failure);
    },
  );
});

describe("fs-guard -- permissionAdvice's other two branches, reached only when the caller advice does NOT carry FRESH_RETRY", () => {
  afterEach(() => {
    lstatSyncMock.mockReset();
  });

  it("an advice already ending with the bare 're-run the CLI' tail gets the permissions-specific variant of THAT tail, not FRESH_RETRY's", () => {
    const failure = Object.assign(new Error("simulated EACCES"), {
      code: "EACCES",
    });
    lstatSyncMock.mockImplementation(() => {
      throw failure;
    });
    const path = "/proj/.groundwork/inventory.json";
    let thrown: unknown;
    try {
      // No `advice` argument: assertNotSymlink's own default is
      // "remove it and re-run the CLI", which ends with the bare
      // "re-run the CLI" tail but NOT with FRESH_RETRY.
      assertNotSymlink(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(path);
    expect(message).toContain("fix its permissions and re-run the CLI");
    expect(message).not.toContain("remove it");
    expect(message).not.toContain(FRESH_RETRY);
    expect((thrown as Error).cause).toBe(failure);
  });

  it("an advice ending with neither FRESH_RETRY nor the re-run tail is kept whole, prefixed by the generic permissions fix", () => {
    const failure = Object.assign(new Error("simulated EACCES"), {
      code: "EACCES",
    });
    lstatSyncMock.mockImplementation(() => {
      throw failure;
    });
    const path = "/proj/.groundwork/inventory.json";
    const customAdvice = "ask a project administrator";
    let thrown: unknown;
    try {
      assertNotSymlink(path, customAdvice);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(path);
    expect(message).toContain(`fix its permissions; ${customAdvice}`);
    expect((thrown as Error).cause).toBe(failure);
  });
});
