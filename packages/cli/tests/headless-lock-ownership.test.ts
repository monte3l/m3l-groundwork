// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Lock ownership (src/headless/lock.ts): the lock file carries a per-run
 * nonce (pid plus a random part) next to the pid and ISO time, and a release
 * removes the lock only while it still holds this run's nonce. An operator
 * who cleared a "stale" lock, and a run B that then took it, must not have
 * run B's lock deleted by run A finishing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withApplyLock } from "../src/headless/lock.js";

let root: string;
const lockPath = (): string => join(root, ".groundwork", "headless", "lock");
const OTHER_RUN = "pid 424242 2020-01-01T00:00:00.000Z other-run-nonce\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hl-lock-own-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe("the lock's contents", () => {
  it("still holds this process's pid and an ISO time", async () => {
    let seen = "";
    await withApplyLock(root, () => {
      seen = readFileSync(lockPath(), "utf8");
    });
    expect(seen).toContain(String(process.pid));
    expect(seen).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
  });

  it("differs between two runs of one process even at the same instant, so a run can tell its lock from another's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const seen: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      await withApplyLock(root, () => {
        seen.push(readFileSync(lockPath(), "utf8"));
      });
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toContain(String(process.pid));
    expect(seen[0]).toContain("2026-01-01T00:00:00.000Z");
  });
});

describe("releasing a lock that is no longer this run's", () => {
  it("leaves another run's lock untouched after success and still resolves to fn's value", async () => {
    const value = await withApplyLock(root, () => {
      writeFileSync(lockPath(), OTHER_RUN);
      return 7;
    });
    expect(value).toBe(7);
    expect(readFileSync(lockPath(), "utf8")).toBe(OTHER_RUN);
  });

  it("leaves another run's lock untouched when fn fails, rethrowing fn's own error", async () => {
    const boom = new Error("boom");
    await expect(
      withApplyLock(root, () => {
        writeFileSync(lockPath(), OTHER_RUN);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(readFileSync(lockPath(), "utf8")).toBe(OTHER_RUN);
  });

  it("does not fail the run when the lock was removed under it, and creates nothing", async () => {
    const value = await withApplyLock(root, () => {
      rmSync(lockPath());
      return "ok";
    });
    expect(value).toBe("ok");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("leaves a symlink that replaced the lock alone, without following it, and does not fail the run", async () => {
    const elsewhere = join(root, "elsewhere");
    writeFileSync(elsewhere, "not a lock");
    const value = await withApplyLock(root, () => {
      rmSync(lockPath());
      symlinkSync(elsewhere, lockPath());
      return "ok";
    });
    expect(value).toBe("ok");
    expect(lstatSync(lockPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, "utf8")).toBe("not a lock");
  });

  it("leaves a non-regular file that replaced the lock alone and does not fail the run", async () => {
    const value = await withApplyLock(root, () => {
      rmSync(lockPath());
      mkdirSync(lockPath());
      return "ok";
    });
    expect(value).toBe("ok");
    expect(lstatSync(lockPath()).isDirectory()).toBe(true);
  });

  it("still removes its own lock when nothing replaced it", async () => {
    await withApplyLock(root, () => undefined);
    expect(existsSync(lockPath())).toBe(false);
  });
});
