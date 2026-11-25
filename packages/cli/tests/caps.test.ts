// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAP_LIMITS,
  countBaselineCaps,
  countDirEntries,
  countPackBudget,
  countProjectCaps,
} from "../src/caps.js";
import type { CapCounts } from "../src/caps.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesCoreDir = join(here, "..", "..", "..", "templates", "core");
const templatesPacksDir = join(here, "..", "..", "..", "templates", "packs");

describe("countDirEntries", () => {
  it("returns 0 for a directory that doesn't exist", () => {
    expect(countDirEntries("/does/not/exist")).toBe(0);
  });

  it("counts every entry with no filter, and only matching ones with one", () => {
    const dir = mkdtempSync(join(tmpdir(), "count-dir-"));
    try {
      writeFileSync(join(dir, "a.mjs"), "");
      writeFileSync(join(dir, "b.txt"), "");
      expect(countDirEntries(dir)).toBe(2);
      expect(countDirEntries(dir, (n) => n.endsWith(".mjs"))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("countBaselineCaps / countPackBudget", () => {
  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "caps-root-"));
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "a-skill"), { recursive: true });
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "Explore.md"), "");
    writeFileSync(join(dir, ".claude", "agents", "not-an-agent.txt"), "");
    writeFileSync(join(dir, ".claude", "hooks", "guard-foo.mjs"), "");
    writeFileSync(join(dir, ".claude", "hooks", "guard-bar.js"), "");
    writeFileSync(join(dir, ".claude", "hooks", "README.md"), "");
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
    );
    return dir;
  }

  it("counts every capped category, adding 1 for /customize on the baseline path", () => {
    const root = makeRoot();
    try {
      const counts = countBaselineCaps(root);
      expect(counts).toEqual({
        agents: 1,
        skills: 2, // 1 real skill dir + 1 for /customize
        hooks: 2,
        workflows: 1,
        scripts: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts the same categories without the /customize adjustment for a pack", () => {
    const root = makeRoot();
    try {
      const counts = countPackBudget(root);
      expect(counts.skills).toBe(1);
      expect(counts.agents).toBe(1);
      expect(counts.hooks).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds the second argument's own key count on top of the files/ tree's own package.json scripts", () => {
    const root = makeRoot();
    try {
      // makeRoot()'s own package.json already declares 2 scripts (build, test).
      const counts = countPackBudget(root, { foo: "bar", baz: "qux" });
      expect(counts.scripts).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is backward compatible: omitting the second argument behaves exactly like passing an empty object", () => {
    const root = makeRoot();
    try {
      expect(countPackBudget(root, {}).scripts).toBe(
        countPackBudget(root).scripts,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports 0 scripts when package.json has no scripts block, or fails to parse, or is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-scripts-"));
    try {
      expect(countBaselineCaps(dir).scripts).toBe(0);

      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      expect(countBaselineCaps(dir).scripts).toBe(0);

      writeFileSync(join(dir, "package.json"), "{not json");
      expect(countBaselineCaps(dir).scripts).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the real templates/core tree", () => {
  it("still meets every stated cap", () => {
    const counts = countBaselineCaps(templatesCoreDir);
    expect(counts.agents).toBeLessThanOrEqual(CAP_LIMITS.agents);
    expect(counts.skills).toBeLessThanOrEqual(CAP_LIMITS.skills);
    expect(counts.hooks).toBeLessThanOrEqual(CAP_LIMITS.hooks);
    expect(counts.workflows).toBeLessThanOrEqual(CAP_LIMITS.workflows);
    expect(counts.scripts).toBeLessThanOrEqual(CAP_LIMITS.scripts);
  });
});

describe("every templates/packs/*/pack.json", () => {
  it("declares a budget matching what its own files/ tree actually contains", () => {
    if (!existsSync(templatesPacksDir)) return;

    for (const entry of readdirSync(templatesPacksDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const packDir = join(templatesPacksDir, entry.name);
      const manifestPath = join(packDir, "pack.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        budget: CapCounts;
        wiring: { packageScripts?: Record<string, string> };
      };
      const actual = countPackBudget(
        join(packDir, "files"),
        manifest.wiring?.packageScripts,
      );
      expect(manifest.budget, `pack "${entry.name}"`).toEqual(actual);
    }
  });
});

describe("countProjectCaps", () => {
  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "caps-project-"));
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "one"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "customize"), { recursive: true });
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "a.md"), "");
    writeFileSync(join(dir, ".claude", "agents", "b.md"), "");
    writeFileSync(join(dir, ".claude", "agents", "notes.txt"), "");
    writeFileSync(join(dir, ".claude", "hooks", "h.mjs"), "");
    writeFileSync(join(dir, ".claude", "hooks", "README.md"), "");
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "");
    writeFileSync(join(dir, ".github", "workflows", "rel.yaml"), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { a: "1", b: "2", c: "3" } }),
    );
    return dir;
  }

  it("counts what the project root actually holds, with no /customize adjustment", () => {
    const dir = makeProject();
    try {
      expect(countProjectCaps(dir)).toEqual({
        agents: 2,
        skills: 2, // "one" and "customize": both are real entries, nothing is added
        hooks: 1,
        workflows: 2,
        scripts: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns zeros for a project with none of the capped artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-project-empty-"));
    try {
      expect(countProjectCaps(dir)).toEqual({
        agents: 0,
        skills: 0,
        hooks: 0,
        workflows: 0,
        scripts: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agrees with countBaselineCaps on the real baseline, less the /customize skill that countBaselineCaps adds", () => {
    const baseline = countBaselineCaps(templatesCoreDir);
    expect(countProjectCaps(templatesCoreDir)).toEqual({
      ...baseline,
      skills: baseline.skills - 1,
    });
  });

  it("leaves countBaselineCaps and countPackBudget results unchanged", () => {
    const dir = makeProject();
    try {
      expect(countBaselineCaps(dir).skills).toBe(3);
      expect(countPackBudget(dir, { x: "y" }).scripts).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
