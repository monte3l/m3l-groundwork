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
 * RAW underlying error: no path named in a readable message, no `--fresh
 * --force` retry advice, and no `cause` set (it the original error itself).
 * This file's RED state: every row below currently fails because nothing
 * wraps that raw error yet. `code-implementer` closes the gap by wrapping
 * every `lstatSync` call the same way the rest of this package already
 * wraps a guarded read failure (see `survey/internal/read-guard.ts`).
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
});
