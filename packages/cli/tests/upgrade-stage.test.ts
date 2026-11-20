// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import { computePlan, renderRelease } from "../src/upgrade/plan.js";
import type { RenderedRelease, UpgradePlan } from "../src/upgrade/plan.js";
import { stageUpgrade } from "../src/upgrade/stage.js";
import {
  buildProject,
  snapshotTree,
  writeRelease,
} from "./upgrade-plan-fixture.js";
import type { FixtureRelease } from "./upgrade-plan-fixture.js";

const PACKAGE = `${JSON.stringify({ name: "__PROJECT_NAME__", scripts: { lint: "eslint ." } }, null, 2)}\n`;

const OLD: FixtureRelease = {
  core: {
    "package.json": PACKAGE,
    "a.txt": "a v1\n",
    "b.txt": "b v1\n",
    "d.txt": "d v1\n",
    "e.txt": "e v1\n",
    "f.txt": "f v1\n",
    "g.txt": "g v1\n",
    "h.txt": "h v1\n",
    "docs/guide.md": "guide v1\n",
  },
  packs: {},
};

const NEW: FixtureRelease = {
  core: {
    "package.json": PACKAGE,
    "a.txt": "a v2\n",
    "b.txt": "b v2\n",
    "c.txt": "c new\n",
    "d.txt": "d v1\n",
    "e.txt": "e v1\n",
    "f.txt": "f v1\n",
    "h.txt": "h v1\n",
    "docs/guide.md": "guide v2\n",
  },
  packs: {},
};

const TOKENS = { PROJECT_NAME: "acme", YEAR: "1999" };

/** Classes: a safe-update, b conflict-3way, c add, d conflict-2way, docs/guide.md safe-update, e current, f local-only, g remove, h user-deleted. */
const STAGED_PATHS = ["a.txt", "b.txt", "c.txt", "d.txt", "docs/guide.md"];

describe("stageUpgrade", () => {
  let base: string;
  let project: string;
  let tmpRoot: string;
  let manifest: Manifest;
  let release: RenderedRelease;
  let plan: UpgradePlan;

  const upgradeDir = (): string => join(project, ".groundwork", "upgrade");
  const stage = (): ReturnType<typeof stageUpgrade> =>
    stageUpgrade({ targetDir: project, plan, release });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "upgrade-stage-test-"));
    project = join(base, "project");
    tmpRoot = join(base, "tmp");
    mkdirSync(tmpRoot);
    const oldRelease = writeRelease(join(base, "old"), OLD);
    const newRelease = writeRelease(join(base, "new"), NEW);
    manifest = buildProject({
      written: oldRelease,
      packNames: [],
      targetDir: project,
      tokens: TOKENS,
      cliVersion: "1.0.0",
    });
    writeFileSync(join(project, "b.txt"), "b mine\n");
    writeFileSync(join(project, "f.txt"), "f mine\n");
    writeFileSync(join(project, "d.txt"), "d mine\n");
    Reflect.deleteProperty(manifest.files, "d.txt");
    rmSync(join(project, "h.txt"));
    release = renderRelease({
      manifest,
      cliVersion: "2.0.0",
      templatesDir: newRelease.templatesDir,
      packsRoot: newRelease.packsRoot,
      tmpRoot,
    });
    plan = computePlan({
      targetDir: project,
      manifest,
      release,
      cliVersion: "2.0.0",
    });
  });

  afterEach(() => {
    release.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it("fixture sanity: the plan has the classes the tests below rely on", () => {
    const byPath = Object.fromEntries(plan.files.map((e) => [e.path, e.class]));
    expect(byPath["a.txt"]).toBe("safe-update");
    expect(byPath["b.txt"]).toBe("conflict-3way");
    expect(byPath["c.txt"]).toBe("add");
    expect(byPath["d.txt"]).toBe("conflict-2way");
    expect(byPath["e.txt"]).toBe("current");
    expect(byPath["f.txt"]).toBe("local-only");
    expect(byPath["g.txt"]).toBe("remove");
    expect(byPath["h.txt"]).toBe("user-deleted");
  });

  it("returns the directory and the staged list", () => {
    const result = stage();
    expect(result.dir).toBe(upgradeDir());
    expect(result.staged).toHaveLength(STAGED_PATHS.length);
  });

  it("writes staged/<path>.staged for the four staged classes only, plus the report and plan.json", () => {
    stage();
    expect(readdirSync(upgradeDir()).sort()).toEqual([
      "plan.json",
      "staged",
      "upgrade-report.md",
    ]);
    for (const path of STAGED_PATHS) {
      expect(existsSync(join(upgradeDir(), "staged", `${path}.staged`))).toBe(
        true,
      );
    }
    const stagedFiles: string[] = [];
    const visit = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) visit(join(dir, entry.name), rel);
        else stagedFiles.push(rel);
      }
    };
    visit(join(upgradeDir(), "staged"), "");
    expect(stagedFiles.sort()).toEqual(
      STAGED_PATHS.map((p) => `${p}.staged`).sort(),
    );
  });

  it("stages the bytes of the rendered release, not the project's", () => {
    stage();
    const staged = (p: string): string =>
      readFileSync(join(upgradeDir(), "staged", `${p}.staged`), "utf8");
    expect(staged("a.txt")).toBe("a v2\n");
    expect(staged("b.txt")).toBe("b v2\n");
    expect(staged("c.txt")).toBe("c new\n");
    expect(staged("d.txt")).toBe("d v1\n");
    expect(staged("docs/guide.md")).toBe("guide v2\n");
  });

  it("writes plan.json as the plan plus legacy:false and the sorted staged list, hand-pinned", () => {
    stage();
    const text = readFileSync(join(upgradeDir(), "plan.json"), "utf8");
    const expectedStaged = [
      ["a.txt", "a v2\n"],
      ["b.txt", "b v2\n"],
      ["c.txt", "c new\n"],
      ["d.txt", "d v1\n"],
      ["docs/guide.md", "guide v2\n"],
    ].map(([path, content]) => ({
      path,
      staged: `staged/${path ?? ""}.staged`,
      sha256: sha256Hex(content ?? ""),
    }));
    expect(text).toBe(
      `${JSON.stringify({ ...plan, legacy: false, staged: expectedStaged }, null, 2)}\n`,
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      ...Object.keys(plan),
      "legacy",
      "staged",
    ]);
    expect(parsed["legacy"]).toBe(false);
    expect(parsed["schemaVersion"]).toBe(1);
  });

  it("records each staged file's sha256 as the hash of the staged bytes", () => {
    stage();
    const parsed = JSON.parse(
      readFileSync(join(upgradeDir(), "plan.json"), "utf8"),
    ) as { staged: { path: string; staged: string; sha256: string }[] };
    expect(parsed.staged.map((s) => s.path)).toEqual(STAGED_PATHS);
    for (const entry of parsed.staged) {
      expect(entry.sha256).toBe(
        sha256Hex(readFileSync(join(upgradeDir(), entry.staged))),
      );
    }
  });

  it("holds no timestamp and no absolute path in plan.json", () => {
    stage();
    const text = readFileSync(join(upgradeDir(), "plan.json"), "utf8");
    expect(text).not.toContain(base);
    expect(text).not.toContain(release.dir);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("writes the report from renderUpgradeReport's contract", () => {
    stage();
    const report = readFileSync(
      join(upgradeDir(), "upgrade-report.md"),
      "utf8",
    );
    expect(report.split("\n")[0]).toBe("# Upgrade plan");
    expect(report).toContain("From 1.0.0 to 2.0.0.");
  });

  it("changes nothing outside .groundwork/upgrade/", () => {
    const outside = (): Record<string, string> =>
      Object.fromEntries(
        Object.entries(snapshotTree(project)).filter(
          ([path]) =>
            path !== ".groundwork" && !path.startsWith(".groundwork/"),
        ),
      );
    const before = outside();
    stage();
    expect(outside()).toEqual(before);
    expect(readdirSync(join(project, ".groundwork"))).toEqual(["upgrade"]);
  });

  it("replaces a previous .groundwork/upgrade/ wholesale", () => {
    stage();
    writeFileSync(join(upgradeDir(), "staged", "old.staged"), "stale\n");
    writeFileSync(join(upgradeDir(), "extra.txt"), "stale\n");
    stage();
    expect(existsSync(join(upgradeDir(), "staged", "old.staged"))).toBe(false);
    expect(existsSync(join(upgradeDir(), "extra.txt"))).toBe(false);
    expect(existsSync(join(upgradeDir(), "plan.json"))).toBe(true);
  });

  it("gives the same files and bytes for two runs of the same inputs", () => {
    stage();
    const first = snapshotTree(upgradeDir());
    stage();
    expect(snapshotTree(upgradeDir())).toEqual(first);
  });

  it("refuses a symlinked .groundwork, leaving the previous staging intact", () => {
    const real = join(base, "real-groundwork");
    mkdirSync(join(real, "upgrade"), { recursive: true });
    writeFileSync(join(real, "upgrade", "marker.txt"), "previous\n");
    symlinkSync(real, join(project, ".groundwork"));
    expect(() => stage()).toThrow(/symlink/i);
    expect(readFileSync(join(real, "upgrade", "marker.txt"), "utf8")).toBe(
      "previous\n",
    );
    expect(readdirSync(real)).toEqual(["upgrade"]);
  });

  it("refuses a symlinked .groundwork/upgrade, leaving the previous staging intact", () => {
    const real = join(base, "real-upgrade");
    mkdirSync(real);
    writeFileSync(join(real, "marker.txt"), "previous\n");
    mkdirSync(join(project, ".groundwork"));
    symlinkSync(real, join(project, ".groundwork", "upgrade"));
    expect(() => stage()).toThrow(/symlink/i);
    expect(readdirSync(real)).toEqual(["marker.txt"]);
    expect(readFileSync(join(real, "marker.txt"), "utf8")).toBe("previous\n");
  });

  it("leaves the previous staging intact and no work directory when writing fails midway", () => {
    stage();
    const before = snapshotTree(upgradeDir());
    // A staged file's source vanishing from the release fails the write
    // after other files were already written to the work directory.
    rmSync(join(release.dir, "docs", "guide.md"));
    expect(() => stage()).toThrow(Error);
    expect(snapshotTree(upgradeDir())).toEqual(before);
    expect(
      readdirSync(join(project, ".groundwork")).filter((n) =>
        n.startsWith(".upgrade-"),
      ),
    ).toEqual([]);
  });

  it("creates no .groundwork/upgrade/ when the first staging fails", () => {
    rmSync(join(release.dir, "a.txt"));
    expect(() => stage()).toThrow(Error);
    expect(existsSync(upgradeDir())).toBe(false);
  });
});
