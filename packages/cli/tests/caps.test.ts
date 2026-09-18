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
      };
      const actual = countPackBudget(join(packDir, "files"));
      expect(manifest.budget, `pack "${entry.name}"`).toEqual(actual);
    }
  });
});
