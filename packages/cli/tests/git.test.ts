// This test verifies gitInit and runInstall (src/git.ts) invoke the right
// subprocess commands -- `git init -q` and `pnpm install`, each in the given
// directory -- without actually running git or pnpm. It mocks
// node:child_process's execFileSync via vi.hoisted, the pattern this repo's
// CLAUDE.md documents (see "Testing") for closing a per-file coverage gap
// without mocking away the thing genuinely under test: the assertion is on
// the exact command/args/cwd passed to the subprocess boundary, not on a
// stubbed-out git.ts function.
import { describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { gitInit, runInstall } = await import("../src/git.js");

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
