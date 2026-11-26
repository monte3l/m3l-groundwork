// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `gitMergeFile({ ours, base, theirs, baseVersion, cliVersion })`: a thin
 * wrapper over `git merge-file -p --diff3` on three temp files kept under
 * `os.tmpdir()` (never in a project) and removed in a `finally`. Returns
 * `{ text, conflicts }` (conflicts is the exit status, 0-127) or
 * `{ unavailable: reason }` for a missing git, a status above 127 or a
 * signal. Real git for the merge cases; a PATH override for the rest.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { gitMergeFile } from "../src/git.js";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;
const FILLER = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"];

let sandbox: string;
let savedPath: string | undefined;
let savedTmp: string | undefined;
let savedGlobal: string | undefined;
let savedNoSystem: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "git-merge-file-"));
  mkdirSync(join(sandbox, "tmp"));
  savedPath = process.env["PATH"];
  savedTmp = process.env["TMPDIR"];
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedNoSystem = process.env["GIT_CONFIG_NOSYSTEM"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["TMPDIR"] = join(sandbox, "tmp");
});

afterEach(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PATH", savedPath);
  restore("TMPDIR", savedTmp);
  restore("GIT_CONFIG_GLOBAL", savedGlobal);
  restore("GIT_CONFIG_NOSYSTEM", savedNoSystem);
  rmSync(sandbox, { recursive: true, force: true });
});

const tempEntries = (): string[] => readdirSync(join(sandbox, "tmp"));

/** Puts a fake `git` (a shell script) alone on PATH. */
function fakeGit(script: string): void {
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env["PATH"] = bin;
}

function input(ours: string, base: string, theirs: string) {
  return { ours, base, theirs, baseVersion: "1.0.0", cliVersion: "1.1.0" };
}

describe("gitMergeFile", () => {
  it("merges non-conflicting hunks cleanly with conflicts 0", () => {
    const base = lines("old header", ...FILLER, "old footer");
    const ours = lines("old header", ...FILLER, "my footer");
    const theirs = lines("new header", ...FILLER, "old footer");
    expect(gitMergeFile(input(ours, base, theirs))).toEqual({
      text: lines("new header", ...FILLER, "my footer"),
      conflicts: 0,
    });
  });

  it("reports the conflict count and keeps diff3 markers with the three labels", () => {
    const base = lines("h", ...FILLER, "f");
    const ours = lines("mine h", ...FILLER, "mine f");
    const theirs = lines("their h", ...FILLER, "their f");
    const result = gitMergeFile(input(ours, base, theirs));
    expect(result).toMatchObject({ conflicts: 2 });
    const { text } = result as { text: string };
    expect(text).toContain("<<<<<<< yours");
    expect(text).toContain("||||||| groundwork 1.0.0");
    expect(text).toContain(">>>>>>> groundwork 1.1.0");
    expect(text).toContain("mine h");
    expect(text).toContain("their f");
  });

  it("reports one conflict for one overlapping hunk", () => {
    const base = lines("h", ...FILLER);
    const result = gitMergeFile(
      input(lines("mine", ...FILLER), base, lines("theirs", ...FILLER)),
    );
    expect(result).toMatchObject({ conflicts: 1 });
  });

  it("returns unavailable when git is not on PATH, leaving no temp file", () => {
    mkdirSync(join(sandbox, "empty"));
    process.env["PATH"] = join(sandbox, "empty");
    const result = gitMergeFile(input("a\n", "b\n", "c\n"));
    expect(result).toHaveProperty("unavailable");
    expect(typeof (result as { unavailable: string }).unavailable).toBe(
      "string",
    );
    expect(tempEntries()).toEqual([]);
  });

  it("returns unavailable for an exit status above 127, leaving no temp file", () => {
    fakeGit("exit 200");
    expect(gitMergeFile(input("a\n", "b\n", "c\n"))).toHaveProperty(
      "unavailable",
    );
    expect(tempEntries()).toEqual([]);
  });

  it("returns unavailable when git dies from a signal", () => {
    fakeGit("kill -9 $$");
    expect(gitMergeFile(input("a\n", "b\n", "c\n"))).toHaveProperty(
      "unavailable",
    );
    expect(tempEntries()).toEqual([]);
  });

  it("removes its temp files after a successful merge and a conflicted one", () => {
    gitMergeFile(input("a\n", "a\n", "b\n"));
    gitMergeFile(input("x\n", "a\n", "y\n"));
    expect(tempEntries()).toEqual([]);
  });

  it("keeps its temp files out of the project directory", () => {
    const project = join(sandbox, "project");
    mkdirSync(project);
    const before = readdirSync(project);
    gitMergeFile(input("x\n", "a\n", "y\n"));
    expect(readdirSync(project)).toEqual(before);
  });

  describe("hermetic spawn", () => {
    it("runs git in its temp directory with the system and global git config disabled", () => {
      // Differ from the suite's own defaults, so only the implementation can
      // have set these for the child.
      process.env["GIT_CONFIG_GLOBAL"] = join(sandbox, "user-gitconfig");
      process.env["GIT_CONFIG_NOSYSTEM"] = "0";
      const out = join(sandbox, "seen.txt");
      fakeGit(
        [
          `echo "cwd=$(pwd)" > "${out}"`,
          `echo "nosystem=$GIT_CONFIG_NOSYSTEM" >> "${out}"`,
          `echo "global=$GIT_CONFIG_GLOBAL" >> "${out}"`,
          "exit 0",
        ].join("\n"),
      );
      gitMergeFile(input("a\n", "b\n", "c\n"));
      const seen = readFileSync(out, "utf8");
      expect(seen).toMatch(/^cwd=.*m3l-merge-[^/\n]*$/m);
      expect(seen).toContain("nosystem=1");
      expect(seen).toContain(`global=${devNull}`);
    });
  });

  describe("failure mapping", () => {
    const reason = (): string => {
      const result = gitMergeFile(input("a\n", "b\n", "c\n"));
      expect(result).toHaveProperty("unavailable");
      return (result as { unavailable: string }).unavailable;
    };

    it("maps a temp-directory failure to a message naming the temp directory, not git", () => {
      process.env["TMPDIR"] = join(sandbox, "does-not-exist");
      const message = reason();
      expect(message).toMatch(/temp(orary)? director/i);
      expect(message).not.toMatch(/could not run/);
      expect(message).not.toMatch(/git/);
    });

    it("maps a failing exit status with empty stdout (a git wrapper failure) to unavailable", () => {
      fakeGit("echo LEAKY-STDERR >&2\nexit 5");
      const result = gitMergeFile(input("a\n", "b\n", "c\n"));
      expect(result).not.toHaveProperty("text");
      expect(result).not.toHaveProperty("conflicts");
      expect((result as { unavailable: string }).unavailable).not.toContain(
        "LEAKY",
      );
    });

    it("still returns the text and conflict count when git reports conflicts on stdout", () => {
      fakeGit("echo merged-with-markers\nexit 3");
      expect(gitMergeFile(input("a\n", "b\n", "c\n"))).toEqual({
        text: "merged-with-markers\n",
        conflicts: 3,
      });
    });

    it("never copies git's stdout or stderr into the reason", () => {
      fakeGit("echo LEAKY-OUT\necho LEAKY-ERR >&2\nexit 200");
      expect(reason()).not.toContain("LEAKY");
    });
  });
});
