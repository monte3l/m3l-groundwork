// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAsset } from "../src/assets.js";
import { installedCoreDir } from "../src/update-common.js";

vi.mock("../src/assets.js", () => ({ resolveAsset: vi.fn() }));

afterEach(() => {
  vi.mocked(resolveAsset).mockReset();
});

describe("installedCoreDir with unreadable templates", () => {
  it("throws a plain Error naming the damage, with the read failure as cause", () => {
    const root = mkdtempSync(join(tmpdir(), "core-dir-"));
    try {
      vi.mocked(resolveAsset).mockReturnValue(join(root, "missing"));
      let thrown: unknown;
      try {
        installedCoreDir("cannot check for an update");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(
        /^cannot check for an update: this CLI's templates \(.*missing\) cannot be read \(ENOENT\) -- .*reinstall/,
      );
      expect((thrown as Error).cause).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
