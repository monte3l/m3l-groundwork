import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPack,
  listPackNames,
  loadPack,
  observeWiring,
  packsRootDir,
  stagePackFiles,
} from "../src/packs.js";
import type { PackManifest } from "../src/packs.js";

const here = dirname(fileURLToPath(import.meta.url));
const realPacksRoot = join(here, "..", "..", "..", "templates", "packs");

function writeManifest(
  packsRoot: string,
  name: string,
  manifest: Partial<PackManifest> = {},
): void {
  const packDir = join(packsRoot, name);
  mkdirSync(join(packDir, "files"), { recursive: true });
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      schemaVersion: 1,
      name,
      description: "a test pack",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: undefined,
      wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      adoptNotes: undefined,
      ...manifest,
    }),
  );
}

describe("packsRootDir", () => {
  it("resolves to a directory literally named templates/packs", () => {
    expect(packsRootDir().endsWith(join("templates", "packs"))).toBe(true);
  });
});

describe("listPackNames / loadPack", () => {
  let packsRoot: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-root-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
  });

  it("returns an empty list when the packs root doesn't exist", () => {
    expect(listPackNames(join(packsRoot, "missing"))).toEqual([]);
  });

  it("lists only directories that have a pack.json, sorted", () => {
    writeManifest(packsRoot, "zeta");
    writeManifest(packsRoot, "alpha");
    mkdirSync(join(packsRoot, "not-a-pack"));
    expect(listPackNames(packsRoot)).toEqual(["alpha", "zeta"]);
  });

  it("loads a valid manifest", () => {
    writeManifest(packsRoot, "demo", { description: "demo pack" });
    const pack = loadPack("demo", packsRoot);
    expect(pack.manifest.name).toBe("demo");
    expect(pack.manifest.description).toBe("demo pack");
    expect(pack.filesDir).toBe(join(packsRoot, "demo", "files"));
  });

  it("throws naming the available packs when the pack is unknown", () => {
    writeManifest(packsRoot, "known");
    expect(() => loadPack("nope", packsRoot)).toThrow(/unknown pack "nope"/);
    expect(() => loadPack("nope", packsRoot)).toThrow(/known/);
  });

  it("throws naming (none) when nothing is available", () => {
    expect(() => loadPack("nope", packsRoot)).toThrow(/\(none\)/);
  });

  it("throws when pack.json fails to parse", () => {
    mkdirSync(join(packsRoot, "broken"), { recursive: true });
    writeFileSync(join(packsRoot, "broken", "pack.json"), "{not json");
    expect(() => loadPack("broken", packsRoot)).toThrow(/failed to parse/);
  });

  it("throws on an unsupported schemaVersion", () => {
    writeManifest(packsRoot, "future", { schemaVersion: 2 });
    expect(() => loadPack("future", packsRoot)).toThrow(
      /unsupported pack\.json schemaVersion/,
    );
  });
});

describe("installPack", () => {
  let packsRoot: string;
  let targetDir: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-install-root-"));
    targetDir = mkdtempSync(join(tmpdir(), "packs-install-target-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("throws when a required baseline path is missing from the target", () => {
    writeManifest(packsRoot, "needs-report", {
      requires: { paths: ["bin/lib/report.mjs"] },
    });
    const pack = loadPack("needs-report", packsRoot);
    expect(() => installPack(pack, targetDir, {})).toThrow(
      /requires "bin\/lib\/report\.mjs"/,
    );
  });

  it("copies files, merges settings.json, and appends a verify step", () => {
    writeManifest(packsRoot, "wired", {
      wiring: {
        settings: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "node .claude/hooks/x.mjs",
                  timeout: 30,
                },
              ],
            },
          ],
        },
        packageScripts: {},
        verifySteps: [
          {
            id: "x-gate",
            group: "build",
            name: "X gate",
            cmd: ["node", "bin/x.mjs"],
          },
        ],
      },
    });
    mkdirSync(join(packsRoot, "wired", "files", "bin"), { recursive: true });
    writeFileSync(join(packsRoot, "wired", "files", "bin", "x.mjs"), "// x\n");

    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(
      join(targetDir, ".claude", "settings.json"),
      JSON.stringify({ hooks: {} }),
    );

    const pack = loadPack("wired", packsRoot);
    const result = installPack(pack, targetDir, {});

    expect(result.filesWritten).toContain(join("bin", "x.mjs"));
    expect(existsSync(join(targetDir, "bin", "x.mjs"))).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
    ) as { hooks: { PreToolUse: unknown[] } };
    expect(settings.hooks.PreToolUse).toHaveLength(1);

    const steps = JSON.parse(
      readFileSync(
        join(targetDir, "bin", "lib", "verify-steps.packs.json"),
        "utf8",
      ),
    ) as unknown[];
    expect(steps).toEqual([
      {
        id: "x-gate",
        group: "build",
        name: "X gate",
        cmd: ["node", "bin/x.mjs"],
      },
    ]);
  });

  it("creates .claude/settings.json from scratch when the target has none", () => {
    writeManifest(packsRoot, "no-settings-yet", {
      wiring: {
        settings: {
          PreCompact: [{ hooks: [{ type: "command", command: "node a.mjs" }] }],
        },
        packageScripts: {},
        verifySteps: [],
      },
    });
    const pack = loadPack("no-settings-yet", packsRoot);
    installPack(pack, targetDir, {});
    expect(existsSync(join(targetDir, ".claude", "settings.json"))).toBe(true);
  });

  it("merges top-level settings keys without adding an empty hooks block", () => {
    writeManifest(packsRoot, "status", {
      wiring: {
        settings: {},
        settingsTopLevel: { statusLine: { type: "command", command: "s.mjs" } },
        packageScripts: {},
        verifySteps: [],
      },
    });
    const pack = loadPack("status", packsRoot);
    installPack(pack, targetDir, {});
    const settings = JSON.parse(
      readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings).toEqual({
      statusLine: { type: "command", command: "s.mjs" },
    });
  });

  it("keeps the baseline's hooks and $schema and is idempotent when a top-level pack is installed twice", () => {
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(
      join(targetDir, ".claude", "settings.json"),
      JSON.stringify({ $schema: "s", hooks: { Stop: [] } }),
    );
    writeManifest(packsRoot, "status", {
      wiring: {
        settings: {},
        settingsTopLevel: { statusLine: { type: "command", command: "s.mjs" } },
        packageScripts: {},
        verifySteps: [],
      },
    });
    const pack = loadPack("status", packsRoot);
    installPack(pack, targetDir, {});
    const first = readFileSync(
      join(targetDir, ".claude", "settings.json"),
      "utf8",
    );
    installPack(pack, targetDir, {});
    expect(
      readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
    ).toBe(first);
    expect(Object.keys(JSON.parse(first) as object)).toEqual([
      "$schema",
      "hooks",
      "statusLine",
    ]);
  });

  it("throws rather than overwrite a differing top-level key already in settings.json", () => {
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(
      join(targetDir, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } }),
    );
    writeManifest(packsRoot, "status", {
      wiring: {
        settings: {},
        settingsTopLevel: { statusLine: { type: "command", command: "s.mjs" } },
        packageScripts: {},
        verifySteps: [],
      },
    });
    const pack = loadPack("status", packsRoot);
    expect(() => installPack(pack, targetDir, {})).toThrow(/collision/);
  });

  it("merges package.json scripts and throws on a differing collision", () => {
    writeManifest(packsRoot, "scripted", {
      wiring: {
        settings: {},
        packageScripts: { lint: "eslint ." },
        verifySteps: [],
      },
    });
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify({ name: "acme", scripts: { build: "tsc" } }),
    );
    const pack = loadPack("scripted", packsRoot);
    installPack(pack, targetDir, {});
    const pkg = JSON.parse(
      readFileSync(join(targetDir, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts).toEqual({ build: "tsc", lint: "eslint ." });

    // Reinstalling with a colliding script value throws.
    writeManifest(packsRoot, "scripted-conflict", {
      wiring: {
        settings: {},
        packageScripts: { build: "webpack" },
        verifySteps: [],
      },
    });
    const conflicting = loadPack("scripted-conflict", packsRoot);
    expect(() => installPack(conflicting, targetDir, {})).toThrow(
      /script collision/,
    );
  });
});

describe("stagePackFiles", () => {
  it("copies pack.json and the files/ tree, unmodified, into <groundworkDir>/packs/<name>/", () => {
    const packsRoot = mkdtempSync(join(tmpdir(), "packs-stage-root-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "packs-stage-gw-"));
    try {
      writeManifest(packsRoot, "stage-me");
      mkdirSync(join(packsRoot, "stage-me", "files", ".claude", "agents"), {
        recursive: true,
      });
      writeFileSync(
        join(packsRoot, "stage-me", "files", ".claude", "agents", "a.md"),
        "# a\n",
      );

      const pack = loadPack("stage-me", packsRoot);
      const written = stagePackFiles(pack, groundworkDir);

      expect(written).toContain("pack.json");
      expect(
        existsSync(join(groundworkDir, "packs", "stage-me", "pack.json")),
      ).toBe(true);
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "stage-me",
            "files",
            ".claude",
            "agents",
            "a.md",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(packsRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});

describe("observeWiring", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "observe-wiring-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
    return {
      schemaVersion: 1,
      name: "demo",
      description: "demo",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: undefined,
      wiring: {
        settings: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
        packageScripts: {},
        verifySteps: [
          { id: "x", group: "build", name: "X", cmd: ["node", "bin/x.mjs"] },
        ],
      },
      adoptNotes: undefined,
      ...overrides,
    };
  }

  it("reports no .claude/settings.json found when absent", () => {
    const observations = observeWiring(targetDir, manifest());
    expect(observations).toContain("no .claude/settings.json found");
  });

  it("reports whether a wired event already has entries", () => {
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(
      join(targetDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "x" }] },
          ],
        },
      }),
    );
    const observations = observeWiring(targetDir, manifest());
    expect(
      observations.some((o) => o.includes('already has a "PreToolUse" entry')),
    ).toBe(true);
  });

  it("reports whether a top-level settings key is already set", () => {
    const withStatusLine = manifest({
      wiring: {
        settings: {},
        settingsTopLevel: { statusLine: { type: "command", command: "s" } },
        packageScripts: {},
        verifySteps: [],
      },
    });
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(
      join(targetDir, ".claude", "settings.json"),
      JSON.stringify({ hooks: {} }),
    );
    expect(observeWiring(targetDir, withStatusLine)).toContain(
      '.claude/settings.json has no top-level "statusLine" yet',
    );

    writeFileSync(
      join(targetDir, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "mine" } }),
    );
    expect(
      observeWiring(targetDir, withStatusLine).some((o) =>
        o.includes('already sets a top-level "statusLine"'),
      ),
    ).toBe(true);
  });

  it("reports an unparseable settings.json", () => {
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(join(targetDir, ".claude", "settings.json"), "{not json");
    const observations = observeWiring(targetDir, manifest());
    expect(observations).toContain(
      ".claude/settings.json exists but could not be parsed",
    );
  });

  it("flags a present settings.local.json", () => {
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    writeFileSync(join(targetDir, ".claude", "settings.local.json"), "{}");
    const observations = observeWiring(targetDir, manifest());
    expect(observations.some((o) => o.includes("settings.local.json"))).toBe(
      true,
    );
  });

  it("reports whether a gate runner file exists, only when the pack declares verify steps", () => {
    const withSteps = observeWiring(targetDir, manifest());
    expect(
      withSteps.some((o) => o.includes("no bin/verify.mjs-shaped gate runner")),
    ).toBe(true);

    const withoutSteps = observeWiring(
      targetDir,
      manifest({
        wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      }),
    );
    expect(
      withoutSteps.some((o) => o.includes("verify-steps.packs.json")),
    ).toBe(false);
  });
});

describe("the real harness-extras pack", () => {
  it("loads cleanly from the real templates/packs directory", () => {
    const names = listPackNames();
    expect(names).toContain("harness-extras");
    const pack = loadPack("harness-extras");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(existsSync(pack.filesDir)).toBe(true);
    // packsRootDir()'s default resolves to the real templates/packs tree.
    expect(pack.filesDir.startsWith(realPacksRoot)).toBe(true);
  });
});

describe("the real statusline pack", () => {
  it("loads cleanly and declares its two top-level settings keys, no hooks and no gate", () => {
    expect(listPackNames()).toContain("statusline");
    const pack = loadPack("statusline");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.wiring.settings).toEqual({});
    expect(pack.manifest.wiring.verifySteps).toEqual([]);
    expect(Object.keys(pack.manifest.wiring.settingsTopLevel ?? {})).toEqual([
      "statusLine",
      "subagentStatusLine",
    ]);
    for (const value of Object.values(
      pack.manifest.wiring.settingsTopLevel ?? {},
    )) {
      expect(JSON.stringify(value)).toContain(
        "$CLAUDE_PROJECT_DIR/.claude/hooks/",
      );
    }
  });

  it("installs alongside harness-extras: every hook registration and both top-level keys survive together", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-both-"));
    try {
      mkdirSync(join(targetDir, ".claude"), { recursive: true });
      mkdirSync(join(targetDir, "bin", "lib"), { recursive: true });
      writeFileSync(join(targetDir, "bin", "lib", "agent-roster.mjs"), "");
      writeFileSync(join(targetDir, "bin", "lib", "report.mjs"), "");
      writeFileSync(
        join(targetDir, ".claude", "settings.json"),
        JSON.stringify({ $schema: "s", hooks: {} }),
      );
      installPack(loadPack("harness-extras"), targetDir, {});
      installPack(loadPack("statusline"), targetDir, {});
      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(settings)).toEqual([
        "$schema",
        "hooks",
        "statusLine",
        "subagentStatusLine",
      ]);
      expect(Object.keys(settings["hooks"] as object).sort()).toEqual([
        "PreCompact",
        "PreToolUse",
        "SessionStart",
      ]);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("the real claude-action pack", () => {
  it("loads cleanly and declares an empty wiring surface -- pure file drop, no hooks/settings/scripts/gate", () => {
    expect(listPackNames()).toContain("claude-action");
    const pack = loadPack("claude-action");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.wiring.settings).toEqual({});
    expect(pack.manifest.wiring.packageScripts).toEqual({});
    expect(pack.manifest.wiring.verifySteps).toEqual([]);
    expect(pack.manifest.wiring.settingsTopLevel).toBeUndefined();
    expect(existsSync(pack.filesDir)).toBe(true);
  });
});
