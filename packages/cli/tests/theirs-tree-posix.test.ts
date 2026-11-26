// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `buildTheirsTree`'s `sources` keys are always `/`-separated project paths,
 * even when the install steps report platform (backslash) paths. Assumes the
 * normalization replaces each `\` with `/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { emitTemplate as EmitTemplate } from "../src/emit.js";
import { buildTheirsTree } from "../src/theirs-tree.js";
import { TOKENS } from "./update-classify-fixtures.js";

vi.mock("../src/emit.js", async (importOriginal) => {
  const actual = await importOriginal<{ emitTemplate: typeof EmitTemplate }>();
  return {
    ...actual,
    emitTemplate: (...args: Parameters<typeof EmitTemplate>) => {
      const result = actual.emitTemplate(...args);
      return {
        ...result,
        filesWritten: result.filesWritten.map((path) =>
          path.replaceAll("/", "\\"),
        ),
      };
    },
  };
});

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "theirs-posix-"));
  vi.stubEnv("TMPDIR", scratch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("buildTheirsTree sources", () => {
  it("never keys a source by a path holding a backslash", () => {
    const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
    try {
      const keys = [...theirs.sources.keys()];
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => key.includes("\\"))).toEqual([]);
      expect(theirs.sources.get(".claude/settings.json")).toBe("core");
    } finally {
      theirs.cleanup();
    }
  });
});
