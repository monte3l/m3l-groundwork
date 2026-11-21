// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Hardening faults of `applyAdoptActions` (src/headless/apply.ts) that need
 * a pass-through `node:fs` mock: a replace that fails before its rename (the
 * step never replaced anything) and the commit order (`applied.json` is
 * written before `txn/` is removed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { applyAdoptActions } from "../src/headless/apply.js";
import { failure, makeEnv } from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    rmSync: vi.fn(actual.rmSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

let env: Env;
beforeEach(() => {
  env = makeEnv({ gitignore: false });
});
afterEach(() => {
  vi.mocked(rmSync).mockReset();
  vi.mocked(renameSync).mockReset();
  env.dispose();
});

const fault = (code: string, message = `${code} fault`): Error =>
  Object.assign(new Error(message), { code });
const endsWith = (value: unknown, suffix: string): boolean =>
  typeof value === "string" && value.endsWith(suffix);

describe("a replace that fails before its rename", () => {
  /** Arms the rename onto t.txt to run `beforeFailing` and then fail. */
  async function armRename(beforeFailing: () => void): Promise<void> {
    const real = await vi.importActual<typeof FsModule>("node:fs");
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (endsWith(to, "/t.txt")) {
        beforeFailing();
        throw fault("EIO", "rename fault");
      }
      real.renameSync(from, to);
    });
  }

  it("does not report a user's edit as a leftover and leaves the target as the user left it", async () => {
    env.put("t.txt", "original");
    await armRename(() => {
      writeFileSync(env.abs("t.txt"), "user edit");
    });
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.take("t.txt", "taken")],
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(error.leftovers).toEqual([]);
    expect(error.written).toEqual([]);
    expect(error.message).toContain("rename fault");
    expect(env.read("t.txt").toString()).toBe("user edit");
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("does not report a deleted target as a leftover and does not recreate it", async () => {
    env.put("t.txt", "original");
    await armRename(() => {
      rmSync(env.abs("t.txt"));
    });
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.take("t.txt", "taken")],
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(error.leftovers).toEqual([]);
    expect(error.written).toEqual([]);
    expect(existsSync(env.abs("t.txt"))).toBe(false);
  });

  it("still rolls back an earlier install of the same run and lists only it as written", async () => {
    env.put("t.txt", "original");
    await armRename(() => undefined);
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.install("n.txt", "n"), env.take("t.txt", "taken")],
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(error.written).toEqual(["n.txt"]);
    expect(existsSync(env.abs("n.txt"))).toBe(false);
    expect(env.read("t.txt").toString()).toBe("original");
  });
});

describe("commit order", () => {
  it("writes applied.json before it removes txn/", async () => {
    const real = vi.mocked(rmSync).getMockImplementation();
    const seen: boolean[] = [];
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, "/txn")) {
        seen.push(existsSync(env.headless("applied.json")));
      }
      real?.(path, options);
    });
    await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("leaves txn/ without a journal and applied.json present when removing txn/ fails, then the next run warns that applied.json was written", async () => {
    const real = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, "/txn")) throw fault("EIO", "rm txn fault");
      real?.(path, options);
    });
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(result.warnings.join("\n")).toContain("txn");
    expect(existsSync(env.headless("txn"))).toBe(true);
    expect(existsSync(env.headless("txn/journal.json"))).toBe(false);
    const applied = JSON.parse(
      readFileSync(env.headless("applied.json"), "utf8"),
    ) as { changes: { path: string }[] };
    expect(applied.changes.map((change) => change.path)).toEqual(["n.txt"]);

    vi.mocked(rmSync).mockReset();
    const next = await applyAdoptActions({ root: env.root, actions: [] });
    const warnings = next.warnings.filter((w) => !w.includes(".gitignore"));
    expect(warnings).toHaveLength(1);
    const warning = warnings[0] ?? "";
    expect(warning).toContain("no journal");
    expect(warning).toContain("txn");
    expect(warning).toContain("applied.json");
    expect(warning).toMatch(/exists|present|was written|written/i);
    expect(warning).not.toMatch(/rolled back/i);
    expect(existsSync(env.headless("txn"))).toBe(false);
    const after = JSON.parse(
      readFileSync(env.headless("applied.json"), "utf8"),
    ) as { changes: { path: string }[] };
    expect(after.changes.map((change) => change.path)).toEqual(["n.txt"]);
  });
});
