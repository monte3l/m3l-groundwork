// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `inspectCustomizeSkill(targetDir)` (`../src/plugin.js`): the read-only
 * verdict on `<targetDir>/.claude/skills/customize/` that `--add-pack`'s
 * closing `next:` line depends on. `current` is the project's copy being
 * byte-identical to this CLI's payload (installed here by the real
 * `installCustomizeSkill`, never hand-faked); `absent` is nothing there;
 * `stale` is a copy that differs; `unusable` is a symlinked component or an
 * entry that cannot be read. It never writes, whatever it answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodIneffective } from "./chmod-ineffective.js";
import { snapshotTree } from "./add-pack-fixtures.js";

const { lstatSyncMock } = vi.hoisted(() => ({ lstatSyncMock: vi.fn() }));

// Pass-through unless a test arms `lstatFailure` for a project path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, lstatSync: lstatSyncMock };
});

const { inspectCustomizeSkill, installCustomizeSkill } =
  await import("../src/plugin.js");

let lstatFailure: ((path: string) => unknown) | undefined;

let root: string;
let target: string;
const skillDir = (): string => join(target, ".claude", "skills", "customize");

beforeEach(async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs");
  lstatFailure = undefined;
  lstatSyncMock.mockReset();
  lstatSyncMock.mockImplementation(
    (...args: Parameters<typeof FsModule.lstatSync>) => {
      const [path] = args;
      const failure = lstatFailure?.(String(path));
      if (failure !== undefined) throw failure as Error;
      return actual.lstatSync(...args);
    },
  );
  root = mkdtempSync(join(tmpdir(), "plugin-inspect-"));
  target = join(root, "project");
  mkdirSync(target);
});

afterEach(() => {
  lstatSyncMock.mockReset();
  rmSync(root, { recursive: true, force: true });
});

/** The verdict, asserting it left the whole sandbox byte-identical. */
function inspectReadOnly(): string {
  const before = snapshotTree(root);
  const verdict = inspectCustomizeSkill(target);
  expect(snapshotTree(root)).toEqual(before);
  return verdict;
}

describe("inspectCustomizeSkill", () => {
  it("is absent when the project has no .claude at all", () => {
    expect(inspectReadOnly()).toBe("absent");
  });

  it("is absent when .claude/skills exists but holds no customize directory", () => {
    mkdirSync(join(target, ".claude", "skills", "other"), { recursive: true });
    expect(inspectReadOnly()).toBe("absent");
  });

  it("is current right after the real installer wrote this CLI's payload", () => {
    installCustomizeSkill(target);
    expect(inspectReadOnly()).toBe("current");
  });

  it.each([
    ["SKILL.md", "# an older copy\n"],
    ["pack-map.ts", "export const old = 1;\n"],
    ["step-0-reconcile.md", "# older step\n"],
  ])("is stale when %s differs from the payload", (name, content) => {
    installCustomizeSkill(target);
    writeFileSync(join(skillDir(), name), content);
    expect(inspectReadOnly()).toBe("stale");
  });

  it("is stale for a project-authored SKILL.md alone", () => {
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(
      join(skillDir(), "SKILL.md"),
      "---\nname: customize\n---\n# mine\n",
    );
    expect(inspectReadOnly()).toBe("stale");
  });

  it.skipIf(process.platform === "win32")(
    "is unusable when .claude/skills/customize is a symlink, even to a current copy",
    () => {
      installCustomizeSkill(root); // a current copy elsewhere, outside the project
      mkdirSync(join(target, ".claude", "skills"), { recursive: true });
      symlinkSync(join(root, ".claude", "skills", "customize"), skillDir());
      expect(inspectReadOnly()).toBe("unusable");
    },
  );

  it.skipIf(process.platform === "win32")(
    "is unusable when an ancestor component (.claude/skills) is a symlink",
    () => {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(join(elsewhere, "customize"), { recursive: true });
      mkdirSync(join(target, ".claude"));
      symlinkSync(elsewhere, join(target, ".claude", "skills"));
      expect(inspectReadOnly()).toBe("unusable");
    },
  );

  it.skipIf(chmodIneffective)(
    "is unusable when SKILL.md exists but cannot be read",
    () => {
      installCustomizeSkill(target);
      const skillMd = join(skillDir(), "SKILL.md");
      // Content snapshot BEFORE the chmod: snapshotTree cannot read the
      // unreadable file itself.
      const before = snapshotTree(root);
      const metaBefore = lstatSync(skillMd);
      chmodSync(skillMd, 0o000);
      let verdict: string;
      try {
        verdict = inspectCustomizeSkill(target);
        const metaAfter = lstatSync(skillMd);
        expect(metaAfter.mode & 0o777).toBe(0o000);
        expect(metaAfter.size).toBe(metaBefore.size);
        expect(metaAfter.mtimeMs).toBe(metaBefore.mtimeMs);
      } finally {
        chmodSync(skillMd, metaBefore.mode & 0o777);
      }
      expect(verdict).toBe("unusable");
      expect(snapshotTree(root)).toEqual(before);
    },
  );

  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`simulated ${code}`), { code });
  const failOnSkillMd = (failure: unknown): void => {
    lstatFailure = (path) =>
      path.replaceAll("\\", "/").endsWith("/customize/SKILL.md")
        ? failure
        : undefined;
  };

  it.each(["EACCES", "EPERM", "ELOOP", "ENOTDIR", "ENAMETOOLONG"])(
    "is unusable when inspecting the project's entry fails with %s",
    (code) => {
      installCustomizeSkill(target);
      failOnSkillMd(errno(code));
      expect(inspectCustomizeSkill(target)).toBe("unusable");
    },
  );

  it.each([
    ["EIO", errno("EIO")],
    ["EMFILE", errno("EMFILE")],
    ["a TypeError", new TypeError("simulated bug")],
  ])(
    "rethrows %s (a machine fault or a bug, not a fact about the project) as a could-not-inspect error with the original as cause",
    (_label, failure) => {
      installCustomizeSkill(target);
      failOnSkillMd(failure);
      let thrown: unknown;
      try {
        inspectCustomizeSkill(target);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("could not inspect the /customize skill");
      expect(message).not.toContain("could not install");
      let current: unknown = thrown;
      let found = false;
      for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
        current = current.cause;
        if (current === failure) found = true;
      }
      expect(found).toBe(true);
    },
  );
});
