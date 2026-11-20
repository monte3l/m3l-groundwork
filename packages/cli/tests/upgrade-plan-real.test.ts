// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templatesCoreDir } from "../src/main.js";
import { packsRootDir } from "../src/packs.js";
import { computePlan, renderRelease } from "../src/upgrade/plan.js";
import { buildProject } from "./upgrade-plan-fixture.js";

describe("plan against the real baseline", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "upgrade-plan-real-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.each([[[]], [["harness-extras"]], [["quality"]], [["publishing"]]])(
    "renders what fresh mode emitted, so every path and key is current (packs: %j)",
    (packNames: string[]) => {
      const tmpRoot = join(base, "tmp");
      const targetDir = join(base, "project");
      rmSync(tmpRoot, { recursive: true, force: true });
      const written = {
        templatesDir: templatesCoreDir(),
        packsRoot: packsRootDir(),
      };
      const manifest = buildProject({
        written,
        packNames,
        targetDir,
        tokens: { PROJECT_NAME: "acme", YEAR: "2026" },
        cliVersion: "1.0.0",
      });
      const tmp = mkdtempSync(join(base, "tmp-"));

      const release = renderRelease({
        manifest,
        cliVersion: "1.0.0",
        ...written,
        tmpRoot: tmp,
      });
      try {
        const plan = computePlan({
          targetDir,
          manifest,
          release,
          cliVersion: "1.0.0",
        });

        expect(plan.files.length).toBeGreaterThan(50);
        expect(plan.files.filter((e) => e.class !== "current")).toEqual([]);
        const keys = Object.values(plan.jsonKeys).flat();
        expect(Object.keys(plan.jsonKeys)).toContain("package.json");
        expect(keys.length).toBeGreaterThan(5);
        expect(keys.filter((e) => e.class !== "current")).toEqual([]);
      } finally {
        release.dispose();
      }
      expect(readdirSync(tmp)).toEqual([]);
    },
    60_000,
  );
});
