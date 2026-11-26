// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `fetchBase` against the real npm registry: runs only with
 * `M3L_E2E_NETWORK=1`, so an offline `pnpm test:e2e` stays green.
 */
import { describe, expect, it } from "vitest";
import { fetchBase, fetchedBaseFile } from "../src/fetch-base.js";

const enabled = process.env["M3L_E2E_NETWORK"] === "1";

describe("fetchBase (real npm)", () => {
  it.skipIf(!enabled)(
    "returns the templates of the oldest published release (needs M3L_E2E_NETWORK=1: it contacts the npm registry)",
    () => {
      const base = fetchBase({ version: "1.0.0" });
      expect(base.version).toBe("1.0.0");
      expect(base.core.size).toBeGreaterThan(0);
      expect(fetchedBaseFile(base, "core", "package.json")).toBeInstanceOf(
        Uint8Array,
      );
    },
    120_000,
  );
});
