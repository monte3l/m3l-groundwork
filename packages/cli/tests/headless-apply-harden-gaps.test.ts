// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Fault seams of `applyAdoptActions` (src/headless/apply.ts) added with the
 * hardening: a `.groundwork/headless/.gitignore` create that fails with
 * something other than EEXIST, and a dry run whose check for a pending
 * `txn/` fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { applyAdoptActions } from "../src/headless/apply.js";
import { failure, makeEnv } from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});

let env: Env;
beforeEach(() => {
  env = makeEnv({ gitignore: false });
});
afterEach(() => {
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(lstatSync).mockReset();
  env.dispose();
});

const fault = (code: string, message = `${code} fault`): Error =>
  Object.assign(new Error(message), { code });
const endsWith = (value: unknown, suffix: string): boolean =>
  typeof value === "string" && value.endsWith(suffix);

describe("a .gitignore create that fails with something other than EEXIST", () => {
  it("warns, names the file and the lines to add, and the run still applies", async () => {
    const real = await vi.importActual<typeof FsModule>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (endsWith(path, "/headless/.gitignore")) {
        throw fault("EACCES", "gitignore denied");
      }
      real.writeFileSync(path, data, options);
    });
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(result.changes.map((change) => change.path)).toEqual(["n.txt"]);
    expect(env.read("n.txt").toString()).toBe("n");
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0] ?? "";
    expect(warning).toContain(".gitignore");
    expect(warning).toContain("gitignore denied");
    expect(warning).toContain("txn/");
    expect(warning).toContain("lock");
    expect(existsSync(env.headless(".gitignore"))).toBe(false);
  });
});

describe("a dry run whose check for a pending txn/ fails", () => {
  it("throws an ApplyError that chains the cause and says nothing was written", async () => {
    const real = await vi.importActual<typeof FsModule>("node:fs");
    const cause = fault("EIO", "lstat txn fault");
    vi.mocked(lstatSync).mockImplementation(((path: string, options: never) => {
      if (endsWith(path, "/headless/txn")) throw cause;
      return real.lstatSync(path, options);
    }) as typeof lstatSync);
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.install("n.txt", "n")],
        dryRun: true,
      }),
    );
    expect(error.message).toContain("lstat txn fault");
    expect(error.message).toContain("nothing was written");
    expect(error.cause).toBe(cause);
    expect(existsSync(env.abs("n.txt"))).toBe(false);
  });
});
