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
