// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The apply lock (src/headless/lock.ts): `.groundwork/headless/lock`,
 * created with exclusive create so two parallel fleet runs against one
 * project cannot both apply. A held lock is refused, never stolen or
 * deleted; the lock is released on success and on failure.
 *
 * Contract under test: `withApplyLock(root, fn)` runs `fn` while holding the
 * lock and resolves to its value; refusals are `ApplyError`s
 * (src/headless/errors.ts).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withApplyLock } from "../src/headless/lock.js";
import { ApplyError } from "../src/headless/errors.js";

let root: string;
const lockPath = (): string => join(root, ".groundwork", "headless", "lock");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hl-lock-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("withApplyLock", () => {
  it("holds the lock (pid and ISO time) while fn runs and resolves to its value", async () => {
    let seen = "";
    const value = await withApplyLock(root, () => {
      seen = readFileSync(lockPath(), "utf8");
      return 42;
    });
    expect(value).toBe(42);
    expect(seen).toContain(String(process.pid));
    expect(seen).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
  });

  it("accepts an async fn and holds the lock until it settles", async () => {
    let during = false;
    await withApplyLock(root, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      during = existsSync(lockPath());
    });
    expect(during).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("releases the lock after success", async () => {
    await withApplyLock(root, () => undefined);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("releases the lock and rethrows the same error when fn fails", async () => {
    const boom = new Error("boom");
    await expect(
      withApplyLock(root, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("refuses an existing lock with an ApplyError naming it, never running fn nor touching the lock", async () => {
    mkdirSync(join(root, ".groundwork", "headless"), { recursive: true });
    writeFileSync(lockPath(), "pid 1 2020-01-01T00:00:00.000Z");
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
    const message = (thrown as ApplyError).message;
    expect(message).toContain(lockPath());
    expect(message).toMatch(/remove/i);
    expect(ran).toBe(false);
    expect(readFileSync(lockPath(), "utf8")).toBe(
      "pid 1 2020-01-01T00:00:00.000Z",
    );
  });

  it.each([2, 6, 16])(
    "lets exactly one of %i concurrent holders proceed",
    async (n) => {
      let ran = 0;
      let losers = 0;
      let release: () => void = () => undefined;
      const losersDone = new Promise<void>((resolve) => {
        release = resolve;
        // Failure-path fallback only: a correct lock releases this via losers.
        setTimeout(resolve, 500).unref();
      });
      const results = await Promise.allSettled(
        Array.from({ length: n }, async () => {
          try {
            await withApplyLock(root, async () => {
              ran += 1;
              await losersDone;
            });
          } catch (error) {
            losers += 1;
            if (losers === n - 1) release();
            throw error;
          }
        }),
      );
      expect(ran).toBe(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(ApplyError);
        }
      }
      expect(existsSync(lockPath())).toBe(false);
    },
  );

  it("creates a missing .groundwork/headless directory", async () => {
    await withApplyLock(root, () => {
      expect(existsSync(lockPath())).toBe(true);
    });
  });

  it.each([
    ["the .groundwork directory", ".groundwork"],
    ["the .groundwork/headless directory", join(".groundwork", "headless")],
  ])(
    "refuses a symlinked %s and writes nothing through it",
    async (_n, rel) => {
      const outside = mkdtempSync(join(tmpdir(), "hl-lock-outside-"));
      try {
        if (rel === ".groundwork") {
          symlinkSync(outside, join(root, ".groundwork"));
        } else {
          mkdirSync(join(root, ".groundwork"));
          symlinkSync(outside, join(root, ".groundwork", "headless"));
        }
        let ran = false;
        await expect(
          withApplyLock(root, () => {
            ran = true;
          }),
        ).rejects.toBeInstanceOf(ApplyError);
        expect(ran).toBe(false);
        expect(readdirSync(outside)).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

const cannotUsePermissions =
  process.platform === "win32" || process.getuid?.() === 0;

describe.skipIf(cannotUsePermissions)(
  "withApplyLock: filesystem failures",
  () => {
    const headlessDir = (): string => join(root, ".groundwork", "headless");

    it("refuses with an ApplyError, running nothing, when .groundwork/headless cannot be created", async () => {
      mkdirSync(join(root, ".groundwork"));
      chmodSync(join(root, ".groundwork"), 0o500);
      let ran = false;
      let thrown: unknown;
      try {
        await withApplyLock(root, () => {
          ran = true;
        });
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(join(root, ".groundwork"), 0o700);
      }
      expect(thrown).toBeInstanceOf(ApplyError);
      expect((thrown as ApplyError).message).toContain(headlessDir());
      expect((thrown as ApplyError).cause).toBeInstanceOf(Error);
      expect(ran).toBe(false);
      expect(existsSync(headlessDir())).toBe(false);
    });

    it("refuses with an ApplyError chaining the cause when the lock cannot be created for a reason other than it existing", async () => {
      mkdirSync(headlessDir(), { recursive: true });
      chmodSync(headlessDir(), 0o500);
      let ran = false;
      let thrown: unknown;
      try {
        await withApplyLock(root, () => {
          ran = true;
        });
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(headlessDir(), 0o700);
      }
      expect(thrown).toBeInstanceOf(ApplyError);
      expect((thrown as ApplyError).message).toContain(lockPath());
      expect((thrown as ApplyError).message).not.toMatch(/another run holds/);
      expect(((thrown as ApplyError).cause as NodeJS.ErrnoException).code).toBe(
        "EACCES",
      );
      expect(ran).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("reports an ApplyError, keeping fn's value out of reach, when the lock cannot be removed after fn succeeded", async () => {
      let thrown: unknown;
      try {
        await withApplyLock(root, () => {
          chmodSync(headlessDir(), 0o500);
          return "value";
        });
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(headlessDir(), 0o700);
      }
      expect(thrown).toBeInstanceOf(ApplyError);
      expect((thrown as ApplyError).message).toContain(lockPath());
      expect((thrown as ApplyError).message).toMatch(/remove/);
      expect(((thrown as ApplyError).cause as NodeJS.ErrnoException).code).toBe(
        "EACCES",
      );
      // Left behind, so the next run refuses it rather than stealing it.
      expect(existsSync(lockPath())).toBe(true);
    });

    it("rethrows fn's own error unchanged when the lock cannot be removed after fn failed", async () => {
      const boom = new Error("fn failed");
      let thrown: unknown;
      try {
        await withApplyLock(root, () => {
          chmodSync(headlessDir(), 0o500);
          throw boom;
        });
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(headlessDir(), 0o700);
      }
      expect(thrown).toBe(boom);
    });

    it("refuses a lock directory that is a regular file", async () => {
      mkdirSync(join(root, ".groundwork"));
      writeFileSync(join(root, ".groundwork", "headless"), "a file");
      await expect(withApplyLock(root, () => undefined)).rejects.toBeInstanceOf(
        ApplyError,
      );
      expect(readFileSync(join(root, ".groundwork", "headless"), "utf8")).toBe(
        "a file",
      );
    });
  },
);

describe("ApplyError", () => {
  it("is an Error named ApplyError", () => {
    expectTypeOf<ApplyError>().toExtend<Error>();
    expect(Object.getPrototypeOf(ApplyError.prototype)).toBe(Error.prototype);
  });
});
