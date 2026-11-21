// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Hardening of the apply lock (src/headless/lock.ts) that needs injected
 * faults: a failed exclusive create that is not `EEXIST` must never remove a
 * lock another run holds at that path, and a release failure after `fn`
 * failed keeps `fn`'s error primary while reporting the lock was left
 * behind. Every `node:fs` call runs the real function unless a test arms it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withApplyLock } from "../src/headless/lock.js";
import { ApplyError } from "../src/headless/errors.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    openSync: vi.fn(actual.openSync),
    rmSync: vi.fn(actual.rmSync),
    writeSync: vi.fn(actual.writeSync),
  };
});

let root: string;
const headlessDir = (): string => join(root, ".groundwork", "headless");
const lockPath = (): string => join(headlessDir(), "lock");
const isLock = (value: unknown): boolean =>
  typeof value === "string" && value.endsWith("/headless/lock");
const fault = (code: string): Error =>
  Object.assign(new Error(`${code} fault`), { code });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hl-lock-hard-"));
});
afterEach(() => {
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(openSync).mockReset();
  vi.mocked(rmSync).mockReset();
  vi.mocked(writeSync).mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe("withApplyLock: a failed create that is not EEXIST", () => {
  it.each(["EACCES", "EMFILE"])(
    "leaves a lock another run holds in place when the create fails with %s",
    async (code) => {
      mkdirSync(headlessDir(), { recursive: true });
      writeFileSync(lockPath(), "racing run's lock");
      const realWrite = vi.mocked(writeFileSync).getMockImplementation();
      vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
        if (isLock(path)) throw fault(code);
        return realWrite?.(path, data, options);
      });
      const realOpen = vi.mocked(openSync).getMockImplementation();
      vi.mocked(openSync).mockImplementation((path, flags, mode) => {
        if (isLock(path) && flags !== "r") throw fault(code);
        return (realOpen as typeof openSync)(path, flags, mode);
      });
      let ran = false;
      let thrown: unknown;
      try {
        await withApplyLock(root, () => {
          ran = true;
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ApplyError);
      expect(((thrown as ApplyError).cause as { code?: string }).code).toBe(
        code,
      );
      expect(ran).toBe(false);
      expect(readFileSync(lockPath(), "utf8")).toBe("racing run's lock");
    },
  );
});

describe("withApplyLock: the lock cannot be released after fn failed", () => {
  it("keeps fn's error primary and says the lock was left behind", async () => {
    const boom = new Error("fn failed");
    const releaseFault = fault("EIO");
    const real = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (isLock(path)) throw releaseFault;
      return real?.(path, options);
    });
    let thrown: unknown;
    try {
      await withApplyLock(root, () => {
        throw boom;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const primary = thrown === boom || (thrown as Error).cause === boom;
    expect(primary).toBe(true);
    const report = thrown as Error & { releaseError?: unknown };
    expect(
      report.releaseError !== undefined || /lock/i.test(report.message),
    ).toBe(true);
    vi.mocked(rmSync).mockReset();
  });
});

describe("withApplyLock: reading the lock back at release fails for another reason", () => {
  it("fails a successful run with an ApplyError whose cause is the read error", async () => {
    const readFault = fault("EIO");
    const realOpen = vi.mocked(openSync).getMockImplementation();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (isLock(path) && flags !== "wx") throw readFault;
      return (realOpen as typeof openSync)(path, flags, mode);
    });
    const thrown = await failureOf(() => withApplyLock(root, () => "ok"));
    expect(thrown).toBeInstanceOf(ApplyError);
    expect((thrown as ApplyError).cause).toBe(readFault);
  });

  it("keeps fn's error primary, carrying the read error as releaseError", async () => {
    const readFault = fault("EIO");
    const boom = new Error("fn failed");
    const realOpen = vi.mocked(openSync).getMockImplementation();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (isLock(path) && flags !== "wx") throw readFault;
      return (realOpen as typeof openSync)(path, flags, mode);
    });
    const thrown = await failureOf(() =>
      withApplyLock(root, () => {
        throw boom;
      }),
    );
    expect(thrown).toBe(boom);
    expect((thrown as Error & { releaseError?: unknown }).releaseError).toBe(
      readFault,
    );
  });
});

/** Makes removing the lock fail, leaving every other removal real. */
function failLockRelease(releaseFault: Error): void {
  const real = vi.mocked(rmSync).getMockImplementation();
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (isLock(path)) throw releaseFault;
    return real?.(path, options);
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("withApplyLock: writing the lock's contents fails after the create", () => {
  it("removes the lock it created and throws an ApplyError naming it, with the write failure as cause", async () => {
    const writeFault = fault("ENOSPC");
    vi.mocked(writeSync).mockImplementation(() => {
      throw writeFault;
    });
    let ran = false;
    const thrown = await failureOf(() =>
      withApplyLock(root, () => {
        ran = true;
      }),
    );
    expect(thrown).toBeInstanceOf(ApplyError);
    expect((thrown as ApplyError).message).toContain(lockPath());
    expect((thrown as ApplyError).cause).toBe(writeFault);
    expect(ran).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("still reports the write failure when removing the half-made lock fails too", async () => {
    const writeFault = fault("ENOSPC");
    vi.mocked(writeSync).mockImplementation(() => {
      throw writeFault;
    });
    failLockRelease(fault("EIO"));
    const thrown = await failureOf(() => withApplyLock(root, () => undefined));
    expect(thrown).toBeInstanceOf(ApplyError);
    expect((thrown as ApplyError).cause).toBe(writeFault);
  });
});

describe("withApplyLock: fn fails with a value that cannot carry releaseError", () => {
  it("wraps a thrown primitive in an ApplyError naming the lock, with cause and releaseError", async () => {
    const releaseFault = fault("EIO");
    failLockRelease(releaseFault);
    const thrown = await failureOf(() =>
      withApplyLock(root, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional primitive to verify the lock-left-behind wrapper
        throw "boom";
      }),
    );
    expect(thrown).toBeInstanceOf(ApplyError);
    const error = thrown as ApplyError & { releaseError?: unknown };
    expect(error.message).toContain(lockPath());
    expect(error.message).toContain("boom");
    expect(error.cause).toBe("boom");
    expect(error.releaseError).toBe(releaseFault);
  });

  it("wraps a frozen Error, which refuses the releaseError property, naming the lock", async () => {
    const releaseFault = fault("EIO");
    failLockRelease(releaseFault);
    const frozen: Error = Object.freeze(new Error("frozen failure"));
    const thrown = await failureOf(() =>
      withApplyLock(root, () => {
        throw frozen;
      }),
    );
    expect(thrown).toBeInstanceOf(ApplyError);
    const error = thrown as ApplyError & { releaseError?: unknown };
    expect(error.message).toContain(lockPath());
    expect(error.message).toContain("frozen failure");
    expect(error.cause).toBe(frozen);
    expect(error.releaseError).toBe(releaseFault);
  });
});
