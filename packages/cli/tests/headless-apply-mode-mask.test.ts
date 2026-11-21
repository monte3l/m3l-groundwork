// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Special permission bits (setuid, setgid, sticky) never travel through an
 * apply: `parseJournal` refuses a recorded `before.mode` above 0o777 as
 * tampered, and a write over a target that itself carries special bits keeps
 * only `mode & 0o777`, in the file and in the journal it records.
 */
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import type * as FsModule from "node:fs";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { applyAdoptActions } from "../src/headless/apply.js";
import {
  parseJournal,
  serializeJournal,
} from "../src/headless/internal/apply-journal.js";
import { makeEnv, replaceStep } from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  vi.mocked(writeFileSync).mockReset();
  env.dispose();
});

const posix = process.platform !== "win32";
const canChmodSpecial = posix && process.getuid?.() !== 0;
const modeOf = (rel: string): number => statSync(env.abs(rel)).mode & 0o7777;

/** The mode recorded for step 0 in the journal text written during an apply. */
function recordedModes(): (number | undefined)[] {
  const modes: (number | undefined)[] = [];
  for (const call of vi.mocked(writeFileSync).mock.calls) {
    const [path, data] = call;
    if (typeof path !== "string" || !path.includes("journal.json")) continue;
    const steps = parseJournal(
      typeof data === "string"
        ? data
        : Buffer.from(data as Uint8Array).toString(),
    );
    for (const step of steps ?? []) modes.push(step.before?.mode);
  }
  return modes;
}

describe("parseJournal: special bits in a recorded mode", () => {
  test.each([0o4755, 0o2755, 0o1777, 0o7777, 0o4000, 0o2000, 0o1000])(
    "rejects before.mode %o as tampered",
    (mode) => {
      const text = serializeJournal([replaceStep("a.txt", "old", "new", mode)]);
      expect(parseJournal(text)).toBeUndefined();
    },
  );

  test.each([0o644, 0o600, 0o755, 0o400, 0o777, 0o000])(
    "still accepts permission-only mode %o",
    (mode) => {
      const steps = parseJournal(
        serializeJournal([replaceStep("a.txt", "old", "new", mode)]),
      );
      expect(steps?.[0]?.before?.mode).toBe(mode);
    },
  );

  it("refuses a leftover journal with a setuid mode, never restoring the file", async () => {
    env.put("a.txt", "new");
    env.writeJournal([replaceStep("a.txt", "old", "new", 0o4755)], {
      "0": "old",
    });
    await expect(
      applyAdoptActions({ root: env.root, actions: [] }),
    ).rejects.toThrow();
    expect(env.read("a.txt").toString()).toBe("new");
    if (posix) expect(modeOf("a.txt") & 0o7000).toBe(0);
  });
});

describe.skipIf(!canChmodSpecial)("a target carrying special bits", () => {
  test.each([0o4755, 0o2755, 0o1755])(
    "take-divergent over a %o target keeps only permission bits",
    async (mode) => {
      env.put("a.txt", "mine");
      chmodSync(env.abs("a.txt"), mode);
      await applyAdoptActions({
        root: env.root,
        actions: [env.take("a.txt", "theirs")],
      });
      expect(env.read("a.txt").toString()).toBe("theirs");
      expect(modeOf("a.txt") & 0o7000).toBe(0);
      expect(modeOf("a.txt")).toBe(mode & 0o777);
      expect(recordedModes()).toEqual([mode & 0o777]);
    },
  );

  test.each([0o4755, 0o2755, 0o1755])(
    "merge-keys over a %o target keeps only permission bits",
    async (mode) => {
      env.put("a.json", '{\n  "a": 1,\n  "b": 1\n}\n');
      chmodSync(env.abs("a.json"), mode);
      await applyAdoptActions({
        root: env.root,
        actions: [env.merge("a.json", '{\n  "a": 2,\n  "b": 2\n}\n', ["a"])],
      });
      expect(env.read("a.json").toString()).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
      expect(modeOf("a.json") & 0o7000).toBe(0);
      expect(modeOf("a.json")).toBe(mode & 0o777);
      expect(recordedModes()).toEqual([mode & 0o777]);
    },
  );
});

describe.skipIf(!posix)("ordinary modes (regression guard)", () => {
  test.each([0o644, 0o600, 0o755, 0o400])(
    "take-divergent keeps %o exactly and records it",
    async (mode) => {
      env.put("a.txt", "mine");
      chmodSync(env.abs("a.txt"), mode);
      await applyAdoptActions({
        root: env.root,
        actions: [env.take("a.txt", "theirs")],
      });
      expect(env.read("a.txt").toString()).toBe("theirs");
      expect(modeOf("a.txt")).toBe(mode);
      expect(recordedModes()).toEqual([mode]);
    },
  );

  test.each([0o644, 0o600, 0o755, 0o400])(
    "recovery restores mode %o exactly",
    async (mode) => {
      env.put("a.txt", "new");
      env.writeJournal([replaceStep("a.txt", "old", "new", mode)], {
        "0": "old",
      });
      await applyAdoptActions({ root: env.root, actions: [] });
      expect(env.read("a.txt").toString()).toBe("old");
      expect(modeOf("a.txt")).toBe(mode);
    },
  );
});
