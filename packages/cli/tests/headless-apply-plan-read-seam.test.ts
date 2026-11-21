// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The answers-file read seam of `runApplyDryRun`: a file that grows between
 * the size check and the read, and a read failure carrying no errno code.
 * Only a read by file descriptor is intercepted (the answers read); the
 * wrapper passes everything else through to the real filesystem.
 */
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  fdRead: undefined as undefined | (() => Buffer),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === "number" && seam.fdRead !== undefined) {
        return seam.fdRead();
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../src/usage-error.js";
import { runApplyDryRun } from "../src/headless/apply-plan.js";

describe("runApplyDryRun answers read seam", () => {
  let root: string;
  let answersPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hl-apply-seam-"));
    answersPath = join(root, "answers.json");
    writeFileSync(answersPath, "{}");
  });

  afterEach(() => {
    seam.fdRead = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const failure = async (): Promise<CliUsageError> => {
    let thrown: unknown;
    try {
      await runApplyDryRun({ targetDir: root, applyPath: answersPath });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    return thrown as CliUsageError;
  };

  it("refuses a file that grew past the cap between the size check and the read", async () => {
    seam.fdRead = () => Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
    const error = await failure();
    expect(error.message).toContain("larger than 8 MiB");
    expect(error.message).toContain(answersPath);
  });

  it("is a runtime error, not a usage error, when the read fails without an errno code", async () => {
    const cause = new Error("disk went away");
    seam.fdRead = () => {
      throw cause;
    };
    let thrown: unknown;
    try {
      await runApplyDryRun({ targetDir: root, applyPath: answersPath });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect((thrown as Error).cause).toBe(cause);
  });
});
