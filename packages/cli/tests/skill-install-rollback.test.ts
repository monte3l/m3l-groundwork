// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Rollback of the generic installer: a write failing part-way leaves no
 * SKILL.md. `node:fs`'s `writeFileSync` is wrapped (real by default) so one
 * named file's write fails with ENOSPC, as `plugin-rollback.test.ts` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failing = vi.hoisted(() => ({ suffix: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const real = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof real>) => {
      const [path] = args;
      if (
        failing.suffix !== "" &&
        typeof path === "string" &&
        path.endsWith(failing.suffix)
      ) {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
          syscall: "write",
        });
      }
      real(...args);
    },
  };
});

const { installSkill } = await import("../src/plugin.js");
const { DEMO_SPEC, writeDemoSource } = await import("./skill-fixture.js");

let root: string;
let source: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-rollback-"));
  source = join(root, "source");
  target = join(root, "target");
  mkdirSync(target);
  writeDemoSource(source);
});

afterEach(() => {
  failing.suffix = "";
  rmSync(root, { recursive: true, force: true });
});

describe("installSkill rollback", () => {
  it("removes written files and leaves no SKILL.md when a later write fails", () => {
    failing.suffix = "step-1.md";
    const dir = join(target, ".claude", "skills", "demo");
    let thrown: unknown;
    try {
      installSkill(DEMO_SPEC, target, source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(
      (thrown as Error).message.startsWith(
        "could not install the /demo skill: ",
      ),
    ).toBe(true);
    expect((thrown as Error).cause).toMatchObject({ code: "ENOSPC" });
    expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(dir, "data.txt"))).toBe(false);
  });
});
