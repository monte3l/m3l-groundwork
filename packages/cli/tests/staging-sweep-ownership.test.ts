// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The stale work-directory sweep leaves a concurrent run's directory alone:
 * one whose owner file names another running process and is under a day old.
 * A dead owner, this process's own leftover, a directory with no owner file
 * and one past the age limit are still removed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareStaging, stageAtomically } from "../src/staging.js";

const OWNER = ".owner-pid";

let groundworkDir: string;
const target = () => ({
  groundworkDir,
  dirName: "packs",
  noun: "packs",
  plural: true,
});

function workDir(name: string, owner?: string): string {
  const dir = join(groundworkDir, name);
  mkdirSync(dir, { recursive: true });
  if (owner !== undefined) writeFileSync(join(dir, OWNER), owner);
  return dir;
}

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("no child pid");
  return child.pid;
}

beforeEach(() => {
  groundworkDir = mkdtempSync(join(tmpdir(), "sweep-owner-"));
});

afterEach(() => {
  rmSync(groundworkDir, { recursive: true, force: true });
});

describe("removeStaleWorkDirs through prepareStaging", () => {
  it("keeps a work directory whose owner is another running process", () => {
    const live = workDir(".packs-live111", String(process.ppid));
    prepareStaging(target());
    expect(existsSync(live)).toBe(true);
  });

  it("removes a work directory whose owner has exited", () => {
    const dead = workDir(".packs-dead111", String(deadPid()));
    prepareStaging(target());
    expect(existsSync(dead)).toBe(false);
  });

  it("removes this process's own leftover", () => {
    const own = workDir(".packs-own1111", String(process.pid));
    prepareStaging(target());
    expect(existsSync(own)).toBe(false);
  });

  it("removes a directory with no owner file, or an unreadable one", () => {
    const bare = workDir(".packs-bare111");
    const junk = workDir(".packs-junk111", "not a pid");
    prepareStaging(target());
    expect(existsSync(bare)).toBe(false);
    expect(existsSync(junk)).toBe(false);
  });

  it("removes a live owner's directory once it is past the age limit (a reused pid)", () => {
    const old = workDir(".packs-old11111", String(process.ppid));
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    prepareStaging(target());
    expect(existsSync(old)).toBe(false);
  });

  it("never touches another staging directory's work directories", () => {
    const other = workDir(".baseline-dead111", String(deadPid()));
    prepareStaging(target());
    expect(existsSync(other)).toBe(true);
  });
});

describe("stageAtomically owner file", () => {
  it("records the pid in the work directory, never in the staged directory", () => {
    let seen: string | undefined;
    stageAtomically(target(), (newDir) => {
      seen = join(newDir, "..", OWNER);
      expect(existsSync(seen)).toBe(true);
      expect(existsSync(join(newDir, OWNER))).toBe(false);
    });
    expect(seen).toBeDefined();
    expect(existsSync(join(groundworkDir, "packs", OWNER))).toBe(false);
  });
});
