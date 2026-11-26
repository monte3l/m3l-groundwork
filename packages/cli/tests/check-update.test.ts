// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runCheckUpdate(options, deps?)`: exit code, report and read-only
 * guarantee, with the template history and running version injected.
 * `options` is `{ targetDir, baseVersion? }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCheckUpdate } from "../src/check-update.js";
import { classifyProject } from "../src/update-classify.js";
import { buildTheirsTree } from "../src/theirs-tree.js";
import { CliUsageError } from "../src/usage.js";
import { restoreDotfilePath } from "../src/assets.js";
import { templatesCoreDir } from "../src/main.js";
import { buildLock, LOCK_FILE, serializeLock } from "../src/lock.js";
import type { TemplateHistory } from "../src/template-history.js";
import { bootstrapInto, snapshotTree } from "./add-pack-fixtures.js";
import { loadPack, packsRootDir, serializePackManifest } from "../src/packs.js";
import {
  LEDGER_PATH,
  inspectPackInstallations,
  templateFileHashes,
} from "../src/pack-installation.js";
import { sha, writeTree } from "./update-base-fixtures.js";
import {
  bootstrapFresh,
  readLockOrThrow,
  simulateOlder,
} from "./update-classify-fixtures.js";

let root: string;
let project: string;
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-update-"));
  project = join(root, "project");
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Every line printed through console.log, joined. */
function output(): string {
  return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

/** The raw-bytes hashes of the running CLI's `templates/core`, by project path. */
function currentCoreHashes(): Record<string, string> {
  const base = templatesCoreDir();
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(base, full).split("\\").join("/");
        out[restoreDotfilePath(rel)] = sha(readFileSync(full, "utf8"));
      }
    }
  };
  walk(base);
  return out;
}

function historyWith(
  core: Record<string, string>,
  version = "1.0.0",
): { history: TemplateHistory } {
  return {
    history: {
      schemaVersion: 1,
      versions: { [version]: { core, packs: {} } },
      blobs: {},
    },
  };
}

function lockText(baseVersion: string): string {
  return serializeLock(
    buildLock({
      baseVersion,
      origin: "fresh",
      tokens: { PROJECT_NAME: "acme" },
      via: "fresh",
      updatedAt: "2026-01-01T00:00:00.000Z",
      skip: [],
      files: [],
    }),
  );
}

describe("runCheckUpdate", () => {
  it("exits 0 with 'up to date (base X, CLI Y)' when the base equals the running version", () => {
    bootstrapInto(project);
    const before = snapshotTree(project);
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.1.0" },
      { history: historyWith({}, "1.1.0"), runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    expect(output()).toContain("up to date (base 1.1.0 (flag), CLI 1.1.0)");
    expect(snapshotTree(project)).toEqual(before);
  });

  it("exits 0 without comparing when the base is newer than the running version", () => {
    bootstrapInto(project);
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.1.0" },
      { history: historyWith({}, "1.1.0"), runningVersion: "1.0.0" },
    );
    expect(code).toBe(0);
    expect(output()).toContain("up to date (base 1.1.0 (flag), CLI 1.0.0)");
  });

  it("exits 0 and prints 'up to date' when an older base recorded identical templates", () => {
    bootstrapInto(project);
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      { history: historyWith(currentCoreHashes()), runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    expect(output().split("\n")[0]).toBe("base 1.0.0 (flag), CLI 1.1.0");
    expect(output()).toContain("up to date");
    expect(output()).not.toContain("update available");
  });

  it("exits 3 with the counts and 'update available' for a seeded difference", () => {
    bootstrapInto(project);
    writeTree(project, { "only-in-base.txt": "x" });
    const before = snapshotTree(project);
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      {
        history: historyWith({
          ...currentCoreHashes(),
          "only-in-base.txt": sha("x"),
          "package.json": sha("an older package.json"),
        }),
        runningVersion: "1.1.0",
      },
    );
    expect(code).toBe(3);
    const text = output();
    expect(text.split("\n")[0]).toBe("base 1.0.0 (flag), CLI 1.1.0");
    expect(text).toContain("1 file(s) changed upstream, 0 added, 1 removed");
    expect(text).toContain("update available");
    expect(text).not.toContain("--update");
    expect(snapshotTree(project)).toEqual(before);
  });

  it("takes the base from the lock and reports its source", () => {
    bootstrapInto(project);
    writeTree(project, { [LOCK_FILE]: lockText("1.0.0") });
    const code = runCheckUpdate(
      { targetDir: project },
      {
        history: historyWith({ "package.json": sha("older") }),
        runningVersion: "1.1.0",
      },
    );
    expect(code).toBe(3);
    expect(output().split("\n")[0]).toBe("base 1.0.0 (lock), CLI 1.1.0");
  });

  it("lets --base-version override the lock", () => {
    bootstrapInto(project);
    writeTree(project, { [LOCK_FILE]: lockText("1.0.0") });
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.0.0": { core: {}, packs: {} },
        "1.0.5": { core: currentCoreHashes(), packs: {} },
      },
      blobs: {},
    };
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.5" },
      { history: { history }, runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    expect(output().split("\n")[0]).toBe("base 1.0.5 (flag), CLI 1.1.0");
  });

  it("prints a 'note:' line for a ledger pack the history cannot compare", () => {
    bootstrapInto(project, ["quality"]);
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      { history: historyWith(currentCoreHashes()), runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    const notes = output()
      .split("\n")
      .filter((line) => line.startsWith("note:"));
    expect(notes.some((line) => line.includes("quality"))).toBe(true);
    expect(output()).not.toContain("outdated: quality");
    // A skipped comparison is never reported as a bare "up to date".
    expect(output()).toMatch(
      /up to date \(\d+ comparison\(s\) skipped -- see notes\)/,
    );
  });
});

describe("runCheckUpdate refusals", () => {
  const deps = (): {
    history: { history: TemplateHistory };
    runningVersion: string;
  } => ({
    history: historyWith(currentCoreHashes(), "1.0.0"),
    runningVersion: "1.1.0",
  });

  it("refuses a target that does not exist, creating nothing", () => {
    const missing = join(root, "missing");
    expect(() => runCheckUpdate({ targetDir: missing }, deps())).toThrowError(
      CliUsageError,
    );
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a target that is a file", () => {
    writeTree(root, { "file.txt": "x" });
    expect(() =>
      runCheckUpdate({ targetDir: join(root, "file.txt") }, deps()),
    ).toThrowError(CliUsageError);
  });

  it("refuses an interrupted adopt and advises re-running adopt", () => {
    writeTree(project, { ".groundwork/adoption-report.md": "partial" });
    const before = snapshotTree(project);
    expect(() =>
      runCheckUpdate({ targetDir: project, baseVersion: "1.0.0" }, deps()),
    ).toThrowError(/adopt/);
    expect(snapshotTree(project)).toEqual(before);
  });

  it("refuses an unknown-origin project with no lock", () => {
    writeTree(project, { "readme.txt": "hello" });
    const before = snapshotTree(project);
    expect(() =>
      runCheckUpdate({ targetDir: project, baseVersion: "1.0.0" }, deps()),
    ).toThrowError(CliUsageError);
    expect(snapshotTree(project)).toEqual(before);
  });

  it("refuses when no base can be resolved, asking for --base-version", () => {
    bootstrapInto(project);
    // The recorded release shares no file with the project: inference fails.
    const before = snapshotTree(project);
    expect(() =>
      runCheckUpdate(
        { targetDir: project },
        {
          history: historyWith({ "nothing.txt": sha("x") }),
          runningVersion: "1.1.0",
          // No live templates either, so the running version cannot match.
          coreDir: join(root, "no-core"),
        },
      ),
    ).toThrowError(/--base-version <x\.y\.z>/);
    expect(snapshotTree(project)).toEqual(before);
  });

  it("refuses a lock newer than the CLI and names the newer npx", () => {
    bootstrapInto(project);
    writeTree(project, { [LOCK_FILE]: lockText("2.0.0") });
    const before = snapshotTree(project);
    expect(() =>
      runCheckUpdate(
        { targetDir: project },
        { history: historyWith({}, "2.0.0"), runningVersion: "1.1.0" },
      ),
    ).toThrowError(/npx @monte3l\/groundwork@2\.0\.0/);
    expect(snapshotTree(project)).toEqual(before);
  });

  it("refuses an invalid lock", () => {
    bootstrapInto(project);
    writeTree(project, { [LOCK_FILE]: "{ not json" });
    expect(() => runCheckUpdate({ targetDir: project }, deps())).toThrowError(
      CliUsageError,
    );
  });

  it("never mentions --update in a refusal", () => {
    writeTree(project, { "readme.txt": "hello" });
    let message = "";
    try {
      runCheckUpdate({ targetDir: project }, deps());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("--update");
  });
});

/** A history entry for the real `quality` pack as the running CLI ships it, optionally altered. */
function qualityRecord(
  alter: { manifest?: string; files?: Record<string, string> } = {},
): {
  versionEntry: TemplateHistory["versions"][string];
  blobs: Record<string, string>;
} {
  const pack = loadPack("quality", packsRootDir());
  const text = serializePackManifest(pack.manifest);
  if (text === undefined) throw new Error("manifest is not JSON");
  const manifestText = alter.manifest ?? text;
  return {
    versionEntry: {
      core: {},
      packs: {
        quality: {
          manifest: sha(manifestText),
          files: alter.files ?? templateFileHashes(pack.filesDir),
        },
      },
    },
    blobs: { [sha(manifestText)]: manifestText },
  };
}

function ledgerText(cliVersion: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    packs: [{ name: "quality", cliVersion }],
  });
}

describe("runCheckUpdate: the running version is not in the history", () => {
  it("reports up to date for a lock whose baseVersion is the running version (source shown)", () => {
    bootstrapInto(project);
    writeTree(project, { [LOCK_FILE]: lockText("1.1.0") });
    const code = runCheckUpdate(
      { targetDir: project },
      { history: historyWith({}, "1.0.0"), runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    expect(output()).toContain("up to date (base 1.1.0 (lock), CLI 1.1.0)");
  });

  it("infers the running version when the live templates match the project best", () => {
    bootstrapInto(project);
    const code = runCheckUpdate(
      { targetDir: project },
      {
        history: historyWith({ "nothing.txt": sha("x") }, "1.0.0"),
        runningVersion: "1.1.0",
      },
    );
    expect(code).toBe(0);
    expect(output()).toContain("up to date (base 1.1.0 (inferred), CLI 1.1.0)");
  });
});

describe("runCheckUpdate: ledger packs under the up-to-date shortcut", () => {
  function setup(alter?: Parameters<typeof qualityRecord>[0]): {
    history: { history: TemplateHistory };
  } {
    bootstrapInto(project, ["quality"]);
    writeTree(project, {
      [LOCK_FILE]: lockText("1.1.0"),
      [LEDGER_PATH]: ledgerText("1.0.0"),
    });
    const { versionEntry, blobs } = qualityRecord(alter);
    return {
      history: {
        history: {
          schemaVersion: 1,
          versions: { "1.0.0": versionEntry },
          blobs,
        },
      },
    };
  }

  it("still compares a ledger pack at its own cliVersion: exit 3 with the pack line", () => {
    const { history } = setup({ files: { "gone/upstream.txt": sha("x") } });
    const code = runCheckUpdate(
      { targetDir: project },
      { history, runningVersion: "1.1.0" },
    );
    expect(code).toBe(3);
    expect(output()).toMatch(/pack "quality": /);
    expect(output()).toContain("update available");
  });

  it("prints ', manifest changed' on the pack line when the manifest hash differs", () => {
    const { history } = setup({
      manifest: `${JSON.stringify({ different: true }, null, 2)}\n`,
    });
    const code = runCheckUpdate(
      { targetDir: project },
      { history, runningVersion: "1.1.0" },
    );
    expect(code).toBe(3);
    expect(output()).toMatch(/pack "quality": .*, manifest changed/);
  });

  it("reports plain up to date (source shown) when the pack matches too", () => {
    const { history } = setup();
    const code = runCheckUpdate(
      { targetDir: project },
      { history, runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    expect(output()).toContain("up to date (base 1.1.0 (lock), CLI 1.1.0)");
    expect(output()).not.toContain("update available");
  });
});

describe("runCheckUpdate: honest verdicts and notes", () => {
  it("reports 'up to date (N comparison(s) skipped -- see notes)' with exit 0 for a pack the history cannot compare", () => {
    bootstrapInto(project, ["quality"]);
    writeTree(project, { [LEDGER_PATH]: ledgerText("0.5.0") });
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      { history: historyWith(currentCoreHashes()), runningVersion: "1.1.0" },
    );
    expect(code).toBe(0);
    expect(output()).toMatch(/note: .*quality/);
    expect(output()).toMatch(
      /up to date \(\d+ comparison\(s\) skipped -- see notes\)/,
    );
  });

  it("keeps 'update available' and exit 3 when a comparison was skipped but a change exists", () => {
    bootstrapInto(project, ["quality"]);
    writeTree(project, { [LEDGER_PATH]: ledgerText("0.5.0") });
    const code = runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      {
        history: historyWith({
          ...currentCoreHashes(),
          "package.json": sha("older"),
        }),
        runningVersion: "1.1.0",
      },
    );
    expect(code).toBe(3);
    expect(output()).toContain("update available");
  });

  it("notes a pack installed by file evidence but missing from the ledger", () => {
    bootstrapInto(project, ["quality"]);
    runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      { history: historyWith(currentCoreHashes()), runningVersion: "1.1.0" },
    );
    expect(output()).toMatch(
      /note: pack "quality" looks \w+, but .*installed-packs\.json does not list it -- not compared/,
    );
  });

  it("prints the inspection notes and flags an undetermined unledgered pack as not classified", () => {
    bootstrapInto(project);
    writeTree(project, { ".claude/settings.json": "{ broken" });
    const expected = inspectPackInstallations(project, undefined, {
      history: historyWith(currentCoreHashes()),
      runningVersion: "1.1.0",
    });
    expect(expected.undetermined.length).toBeGreaterThan(0);
    runCheckUpdate(
      { targetDir: project, baseVersion: "1.0.0" },
      { history: historyWith(currentCoreHashes()), runningVersion: "1.1.0" },
    );
    const lines = output().split("\n");
    for (const note of expected.undetermined) {
      expect(lines.filter((line) => line === `note: ${note}`)).toHaveLength(1);
    }
    expect(output()).toMatch(
      /pack "[\w-]+" could not be classified -- not compared/,
    );
  });

  it("notes the tie and takes the oldest release when inference is ambiguous", () => {
    bootstrapInto(project);
    const core = currentCoreHashes();
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.0.0": { core, packs: {} },
        "1.0.5": { core, packs: {} },
      },
      blobs: {},
    };
    runCheckUpdate(
      { targetDir: project },
      { history: { history }, runningVersion: "1.1.0" },
    );
    expect(output().split("\n")[0]).toBe("base 1.0.0 (inferred), CLI 1.1.0");
    expect(output()).toMatch(/note: .*tie/i);
  });
});

describe("runCheckUpdate: damaged inputs", () => {
  it("throws a plain Error (not a usage error) when the shipped history cannot be loaded", () => {
    bootstrapInto(project);
    let thrown: unknown;
    try {
      runCheckUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        {
          history: { note: "history file is missing" },
          runningVersion: "1.1.0",
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toMatch(/damaged/);
    expect((thrown as Error).message).toContain("history file is missing");
  });

  it("refuses a target that cannot be stat'ed (symlink loop) with the cause chained", () => {
    mkdirSync(root, { recursive: true });
    const a = join(root, "loop-a");
    const b = join(root, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    let thrown: unknown;
    try {
      runCheckUpdate(
        { targetDir: a },
        { history: historyWith({}), runningVersion: "1.1.0" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toContain("could not be checked");
    expect((thrown as CliUsageError).cause).toBeInstanceOf(Error);
  });

  it("compares against an explicit empty coreDir (fixture path) without throwing", () => {
    bootstrapInto(project);
    expect(() =>
      runCheckUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        {
          history: historyWith({}),
          runningVersion: "1.1.0",
          coreDir: join(root, "no-core"),
        },
      ),
    ).not.toThrow();
  });
});

describe.skipIf(process.platform === "win32")(
  "runCheckUpdate: 'if you update' preview",
  () => {
    let scratch: string;
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), "check-update-tmp-"));
      // os.tmpdir() reads TMPDIR: the theirs tree lands in a private dir.
      vi.stubEnv("TMPDIR", scratch);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(scratch, { recursive: true, force: true });
    });

    const theirsLeftovers = (): string[] =>
      readdirSync(scratch).filter((name) => name.startsWith("m3l-theirs-"));

    /** A project installed from an older release with two changed files. */
    function olderProject(): { history: { history: TemplateHistory } } {
      bootstrapFresh(project);
      simulateOlder(project, "lefthook.yml", "older: true\n");
      simulateOlder(
        project,
        "eslint.config.js",
        "export default [];\n",
        "export default [];\n// mine\n",
      );
      return {
        history: historyWith({
          ...currentCoreHashes(),
          "lefthook.yml": sha("older: true\n"),
          "eslint.config.js": sha("export default [];\n"),
        }),
      };
    }

    it("prints one 'if you update:' line with the non-zero counts, after the count lines", () => {
      const { history } = olderProject();
      const code = runCheckUpdate(
        { targetDir: project },
        { history, runningVersion: "99.0.0" },
      );
      expect(code).toBe(3);
      const lines = output().split("\n");
      const preview = lines.filter((l) => l.startsWith("if you update:"));
      expect(preview).toEqual([
        "if you update: 1 update cleanly, 1 need a merge",
      ]);
      const countIndex = lines.findIndex((l) => l.includes("changed upstream"));
      expect(lines.indexOf(preview[0] as string)).toBeGreaterThan(countIndex);
      expect(theirsLeftovers()).toEqual([]);
    });

    it("leaves the project tree byte-identical", () => {
      const { history } = olderProject();
      const before = snapshotTree(project);
      runCheckUpdate(
        { targetDir: project },
        { history, runningVersion: "99.0.0" },
      );
      expect(snapshotTree(project)).toEqual(before);
    });

    it("omits the line when nothing would change locally, keeping exit 3", () => {
      bootstrapFresh(project);
      const base = readLockOrThrow(project).baseVersion;
      const code = runCheckUpdate(
        { targetDir: project },
        {
          history: historyWith(
            { ...currentCoreHashes(), "lefthook.yml": sha("older") },
            base,
          ),
          runningVersion: "99.0.0",
        },
      );
      expect(code).toBe(3);
      expect(output()).not.toContain("if you update:");
      expect(theirsLeftovers()).toEqual([]);
    });

    it("omits the line and builds no tree when the base is not older than the CLI", () => {
      bootstrapFresh(project);
      const base = readLockOrThrow(project).baseVersion;
      const code = runCheckUpdate(
        { targetDir: project },
        {
          history: historyWith(currentCoreHashes(), base),
          runningVersion: base,
        },
      );
      expect(code).toBe(0);
      expect(output()).not.toContain("if you update:");
    });

    it("cleans the temp tree even when printing throws", () => {
      const { history } = olderProject();
      log.mockImplementation(() => {
        throw new Error("stdout closed");
      });
      expect(() =>
        runCheckUpdate(
          { targetDir: project },
          { history, runningVersion: "99.0.0" },
        ),
      ).toThrow("stdout closed");
      expect(theirsLeftovers()).toEqual([]);
    });

    /** The final line printed. */
    const lastLine = (): string => output().split("\n").at(-1) ?? "";
    const SKIPPED =
      /^up to date \([1-9]\d* comparison\(s\) skipped -- see notes\)$/;

    /** A project whose base is older than the CLI but whose templates are unchanged. */
    function unchangedProject(): { history: { history: TemplateHistory } } {
      bootstrapFresh(project);
      return {
        history: historyWith(
          currentCoreHashes(),
          readLockOrThrow(project).baseVersion,
        ),
      };
    }

    it("counts a failed theirs-tree build as a skipped comparison in the verdict", () => {
      bootstrapFresh(project);
      const base = readLockOrThrow(project).baseVersion;
      const code = runCheckUpdate(
        { targetDir: project },
        {
          // An empty history and an absent coreDir: no upstream difference.
          history: historyWith({}, base),
          runningVersion: "99.0.0",
          coreDir: join(root, "no-core"),
        },
      );
      expect(code).toBe(0);
      expect(output()).toContain("note: update preview skipped");
      expect(lastLine()).toMatch(SKIPPED);
      expect(theirsLeftovers()).toEqual([]);
    });

    it("counts a damaged migrations file as a skipped comparison in the verdict", () => {
      const { history } = unchangedProject();
      // Assumes CheckUpdateDeps.migrationsPath? points loadMigrations at a file.
      const migrationsPath = join(root, "migrations.json");
      writeFileSync(migrationsPath, "{ not json");
      const code = runCheckUpdate(
        { targetDir: project },
        { history, runningVersion: "99.0.0", migrationsPath },
      );
      expect(code).toBe(0);
      expect(output()).toMatch(/note: migrations .*ignored/);
      expect(lastLine()).toMatch(SKIPPED);
    });

    it("never closes with a bare 'up to date (base ...' when a preview note was printed", () => {
      const { history } = unchangedProject();
      const migrationsPath = join(root, "migrations.json");
      writeFileSync(migrationsPath, "{ not json");
      runCheckUpdate(
        { targetDir: project },
        { history, runningVersion: "99.0.0", migrationsPath },
      );
      expect(output()).toContain("note:");
      expect(lastLine()).not.toMatch(/^up to date \(base /);
    });

    it("never closes with a bare 'up to date (base ...' after printing 'if you update:'", () => {
      bootstrapFresh(project);
      // The history says nothing changed upstream, yet the project's own
      // base snapshot is older, so the preview has something to report.
      simulateOlder(project, "lefthook.yml", "older: true\n");
      const history = historyWith(currentCoreHashes(), "1.0.0");
      runCheckUpdate(
        { targetDir: project },
        { history, runningVersion: "99.0.0" },
      );
      expect(output()).toContain("if you update:");
      expect(lastLine()).not.toMatch(/^up to date \(base /);
    });

    it("notes a ledger pack the CLI no longer ships, saying its files are left alone", () => {
      bootstrapFresh(project);
      writeTree(project, {
        [LEDGER_PATH]: JSON.stringify({
          schemaVersion: 1,
          packs: [{ name: "retired-pack", cliVersion: "1.0.0" }],
        }),
      });
      runCheckUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        {
          history: historyWith(currentCoreHashes()),
          runningVersion: "99.0.0",
        },
      );
      const notes = output()
        .split("\n")
        .filter(
          (line) => line.startsWith("note:") && line.includes("retired-pack"),
        );
      expect(notes.some((line) => line.includes("no longer ships"))).toBe(true);
      expect(output()).not.toContain("not in the preview");
    });

    describe("preview failure handling", () => {
      // Assumes CheckUpdateDeps.classify? and CheckUpdateDeps.buildTheirs?
      // replace classifyProject and buildTheirsTree.
      it("keeps the report and the exit code when classification throws, and cleans up", () => {
        const { history } = olderProject();
        const code = runCheckUpdate(
          { targetDir: project },
          {
            history,
            runningVersion: "99.0.0",
            classify: () => {
              throw new Error("classifier exploded");
            },
          },
        );
        expect(code).toBe(3);
        expect(output()).toContain(
          "note: update preview skipped: classifier exploded",
        );
        expect(output()).toContain("update available");
        expect(output()).not.toContain("if you update:");
        expect(theirsLeftovers()).toEqual([]);
      });

      it("never lets a throwing cleanup replace a successful report", () => {
        const { history } = olderProject();
        let leftover = "";
        const code = runCheckUpdate(
          { targetDir: project },
          {
            history,
            runningVersion: "99.0.0",
            buildTheirs: (input: Parameters<typeof buildTheirsTree>[0]) => {
              const real = buildTheirsTree(input);
              leftover = real.dir;
              return {
                ...real,
                cleanup: () => {
                  throw new Error("cleanup failed");
                },
              };
            },
          },
        );
        rmSync(leftover, { recursive: true, force: true });
        expect(code).toBe(3);
        expect(output()).toContain("if you update:");
        expect(output()).toContain("update available");
        const notes = output()
          .split("\n")
          .filter((line) => line.startsWith("note:"));
        expect(notes.some((line) => line.includes(leftover))).toBe(true);
      });

      it("never lets a throwing cleanup replace the original preview failure", () => {
        const { history } = olderProject();
        const code = runCheckUpdate(
          { targetDir: project },
          {
            history,
            runningVersion: "99.0.0",
            classify: () => {
              throw new Error("classifier exploded");
            },
            buildTheirs: (input: Parameters<typeof buildTheirsTree>[0]) => {
              const real = buildTheirsTree(input);
              return {
                ...real,
                cleanup: () => {
                  real.cleanup();
                  throw new Error("cleanup failed");
                },
              };
            },
          },
        );
        expect(code).toBe(3);
        expect(output()).toContain(
          "note: update preview skipped: classifier exploded",
        );
      });
    });

    describe("the project's origin reaches the classification", () => {
      function lockWith(origin: "fresh" | "adopt"): void {
        const lock = readLockOrThrow(project);
        writeFileSync(
          join(project, LOCK_FILE),
          serializeLock(
            buildLock({
              baseVersion: lock.baseVersion,
              origin,
              tokens: lock.tokens,
              via: lock.via,
              updatedAt: lock.updatedAt,
              skip: lock.skip,
              files: lock.files,
            }),
          ),
        );
      }
      function originSeen(): string[] {
        const seen: string[] = [];
        runCheckUpdate(
          { targetDir: project },
          {
            history: historyWith(
              currentCoreHashes(),
              readLockOrThrow(project).baseVersion,
            ),
            runningVersion: "99.0.0",
            classify: (input: Parameters<typeof classifyProject>[0]) => {
              seen.push(input.origin);
              return classifyProject(input);
            },
          },
        );
        return seen;
      }

      it.each([
        ["fresh", "fresh"],
        ["adopt", "adopted"],
      ] as const)(
        "a lock with origin %s is classified as %s",
        (lockOrigin, expected) => {
          bootstrapFresh(project);
          lockWith(lockOrigin);
          expect(originSeen()).toEqual([expected]);
        },
      );
    });
  },
);
