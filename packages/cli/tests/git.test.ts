// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test verifies gitInit and runInstall (src/git.ts) invoke the right
// subprocess commands -- `git init -q` and `pnpm install`, each in the given
// directory -- without actually running git or pnpm. It mocks
// node:child_process's execFileSync via vi.hoisted, the pattern this repo's
// CLAUDE.md documents (see "Testing") for closing a per-file coverage gap
// without mocking away the thing genuinely under test: the assertion is on
// the exact command/args/cwd passed to the subprocess boundary, not on a
// stubbed-out git.ts function.
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { gitInit, runInstall } = await import("../src/git.js");

afterEach(() => {
  execFileSyncMock.mockReset();
});

describe("gitInit", () => {
  it("runs `git init -q` in the given directory", () => {
    execFileSyncMock.mockReturnValue("");
    gitInit("/tmp/some-project");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["init", "-q"],
      expect.objectContaining({ cwd: "/tmp/some-project" }),
    );
  });
});

describe("runInstall", () => {
  it("runs `pnpm install` in the given directory", () => {
    execFileSyncMock.mockReturnValue("");
    runInstall("/tmp/some-project");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "pnpm",
      ["install"],
      expect.objectContaining({ cwd: "/tmp/some-project" }),
    );
  });
});

describe.each([
  ["gitInit", gitInit],
  ["runInstall", runInstall],
])("%s stdio", (_name, run) => {
  it("defaults stdio to 'inherit'", () => {
    execFileSyncMock.mockReturnValue("");
    run("/tmp/some-project");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("passes a given string stdio value straight through to execFileSync", () => {
    execFileSyncMock.mockReturnValue("");
    run("/tmp/some-project", "pipe");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: "/tmp/some-project", stdio: "pipe" }),
    );
  });

  it("passes a given stdio tuple straight through to execFileSync", () => {
    execFileSyncMock.mockReturnValue("");
    const tuple: ("ignore" | number)[] = ["ignore", 2, 2];
    run("/tmp/some-project", tuple);
    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ stdio: tuple }),
    );
  });
});
