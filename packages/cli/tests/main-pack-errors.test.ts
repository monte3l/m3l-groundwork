// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Only an unknown or fresh-incapable `--pack` is a usage error (exit 2). Any
 * other `loadPack` failure -- a corrupt shipped pack.json, a read error -- is
 * not the caller's mistake and must surface unchanged (exit 1). packs.js is
 * mocked (importOriginal-preserving) so one named pack can fail to load, and
 * a second named pack can load but declare no fresh-mode support.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PacksModule from "../src/packs.js";

const corrupt = new Error('pack "corrupt": pack.json failed to parse');

vi.mock("../src/packs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PacksModule>();
  // A real pack's shape, with just its name/modes overridden, so the fake
  // stays Pack-shaped without hand-rolling the rest of a manifest.
  const adoptOnlyBase = actual.loadPack("harness-extras");
  const adoptOnly: PacksModule.Pack = {
    ...adoptOnlyBase,
    manifest: {
      ...adoptOnlyBase.manifest,
      name: "adopt-only",
      modes: ["adopt"],
    },
  };
  return {
    ...actual,
    listPackNames: (root?: string) => [
      ...actual.listPackNames(root),
      "corrupt",
      "adopt-only",
    ],
    loadPack: (name: string, root?: string) => {
      if (name === "corrupt") throw corrupt;
      if (name === "adopt-only") return adoptOnly;
      return actual.loadPack(name, root);
    },
  };
});

const { main, CliUsageError } = await import("../src/main.js");

describe("main --pack load failures", () => {
  it("rethrows a non-usage loadPack failure unchanged and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "main-pack-errors-"));
    const target = join(dir, "t");
    try {
      let thrown: unknown;
      try {
        main([target, "--pack", "corrupt"]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(corrupt);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a pack whose manifest does not support fresh mode as a usage error (exit 2) and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "main-pack-errors-"));
    const target = join(dir, "t");
    try {
      let thrown: unknown;
      try {
        main([target, "--pack", "adopt-only"]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toMatch(
        /does not support fresh mode \(modes: adopt\)/,
      );
      // Same mapping bin/m3l-groundwork.mjs applies at the real process exit.
      const exitCode = thrown instanceof CliUsageError ? 2 : 1;
      expect(exitCode).toBe(2);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
