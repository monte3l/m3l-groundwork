// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `gitMergeFile`'s mapping of the errors `execFileSync` raises for output
 * above `maxBuffer` (`ENOBUFS`) and a timeout (`ETIMEDOUT`). The child process
 * is stubbed, so the suite never waits out a real timeout nor produces a
 * large output. Both errors carry `signal: "SIGTERM"` in Node, which must not
 * surface as "killed by SIGTERM".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { gitMergeFile } from "../src/git.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFileSync: vi.fn(),
}));

afterEach(() => {
  vi.mocked(childProcess.execFileSync).mockReset();
});

function failWith(code: string): string {
  vi.mocked(childProcess.execFileSync).mockImplementation(() => {
    throw Object.assign(new Error(`spawnSync git ${code}`), {
      code,
      signal: "SIGTERM",
      status: null,
      stdout: "LEAKY-GIT-OUTPUT",
      stderr: "LEAKY-GIT-ERROR",
    });
  });
  const result = gitMergeFile({
    ours: "a\n",
    base: "b\n",
    theirs: "c\n",
    baseVersion: "1.0.0",
    cliVersion: "1.1.0",
  });
  expect(result).toHaveProperty("unavailable");
  return (result as { unavailable: string }).unavailable;
}

describe("gitMergeFile: errors execFileSync raises for its own limits", () => {
  it("maps ENOBUFS to a file-too-large reason, not a SIGTERM kill", () => {
    const message = failWith("ENOBUFS");
    expect(message).toMatch(/too large/i);
    expect(message).not.toMatch(/SIGTERM|killed/);
    expect(message).not.toContain("LEAKY");
  });

  it("maps ETIMEDOUT to a timeout reason, not a SIGTERM kill", () => {
    const message = failWith("ETIMEDOUT");
    expect(message).toMatch(/time(d)?[ -]?out/i);
    expect(message).not.toMatch(/SIGTERM|killed/);
    expect(message).not.toContain("LEAKY");
  });
});
