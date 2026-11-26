// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * ASSUMED (review-fix round): `resolveUpdateBase` input gains an optional
 * `coreDir` (the running CLI's `templates/core`); its raw-bytes hashes are an
 * extra inference candidate named `runningVersion`. A base equal to or newer
 * than `runningVersion` (lock/flag) need not be in the history. Inference ties
 * go to the OLDEST candidate.
 *
 * `resolveUpdateBase` (which release a project was installed from) and
 * `diffAgainstHistory` (how that release's templates differ from the running
 * CLI's). Assumed signatures:
 *
 * - `resolveUpdateBase({ targetDir, history, runningVersion, baseVersion? })`
 *   returns `{ version, source: "flag" | "lock" | "inferred" }` or throws
 *   `CliUsageError`.
 * - `diffAgainstHistory({ targetDir, history, baseVersion, coreDir,
 *   packsRoot, lock?, ledger })` returns `{ core: { changed, added, removed },
 *   packs: [{ name, changed, added, removed, manifestChanged }], notes }`
 *   (all arrays of strings sorted by path/name), where `ledger` is
 *   `readInstalledPacksLedger(targetDir).entries`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffAgainstHistory, resolveUpdateBase } from "../src/update-base.js";
import { buildLock, LOCK_FILE, serializeLock } from "../src/lock.js";
import type { Lock, LockFile } from "../src/lock.js";
import { CliUsageError } from "../src/usage.js";
import { loadTemplateHistory } from "../src/template-history.js";
import type { TemplateHistory } from "../src/template-history.js";
import { packsRootDir, serializePackManifest, loadPack } from "../src/packs.js";
import { coreHistory, sha, writeTree } from "./update-base-fixtures.js";
import { bootstrapInto } from "./add-pack-fixtures.js";

let root: string;
let project: string;
let core: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "update-base-"));
  project = join(root, "project");
  core = join(root, "core");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function lockOf(
  fields: Partial<Omit<Lock, "schemaVersion" | "kind">> = {},
): Lock {
  return buildLock({
    baseVersion: "1.0.0",
    origin: "fresh",
    tokens: { PROJECT_NAME: "acme" },
    via: "fresh",
    updatedAt: "2026-01-01T00:00:00.000Z",
    skip: [],
    files: [],
    ...fields,
  });
}

function writeLock(lock: Lock): void {
  writeTree(project, { [LOCK_FILE]: serializeLock(lock) });
}

function lockFile(path: string, status: LockFile["status"]): LockFile {
  return { path, source: "core", baseSha256: sha(path), status };
}

const FILES = {
  "a.txt": "a",
  "b.txt": "b",
  "c.txt": "c",
  "d.txt": "d",
  "e.txt": "e",
  "f.txt": "f",
};

describe("resolveUpdateBase", () => {
  const history = coreHistory({ "1.0.0": FILES, "1.1.0": FILES });

  it("prefers --base-version over the lock", () => {
    writeLock(lockOf({ baseVersion: "1.0.0" }));
    expect(
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
        baseVersion: "1.1.0",
      }),
    ).toMatchObject({ version: "1.1.0", source: "flag" });
  });

  it("uses the lock's baseVersion when there is no flag", () => {
    writeLock(lockOf({ baseVersion: "1.0.0" }));
    expect(
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
      }),
    ).toMatchObject({ version: "1.0.0", source: "lock" });
  });

  it("accepts a lock whose baseVersion is the running version though the history does not list it", () => {
    writeLock(lockOf({ baseVersion: "1.2.0" }));
    expect(
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
      }),
    ).toMatchObject({ version: "1.2.0", source: "lock" });
  });

  it.each(["1.2.0", "1.3.0"])(
    "accepts --base-version %s (running 1.2.0) though the history does not list it",
    (flag) => {
      writeTree(project, { "a.txt": "a" });
      expect(
        resolveUpdateBase({
          targetDir: project,
          history,
          runningVersion: "1.2.0",
          baseVersion: flag,
        }),
      ).toMatchObject({ version: flag, source: "flag" });
    },
  );

  it("still refuses a lock newer than the running version even when the history lacks it", () => {
    writeLock(lockOf({ baseVersion: "1.3.0" }));
    expect(() =>
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
      }),
    ).toThrowError(CliUsageError);
  });

  it("refuses a flag version the history does not hold", () => {
    writeTree(project, { "a.txt": "a" });
    expect(() =>
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
        baseVersion: "0.9.0",
      }),
    ).toThrowError(CliUsageError);
  });

  it("refuses a lock baseVersion the history does not hold", () => {
    writeLock(lockOf({ baseVersion: "0.9.0" }));
    expect(() =>
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
      }),
    ).toThrowError(CliUsageError);
  });

  it("refuses an invalid lock, naming it", () => {
    writeTree(project, { [LOCK_FILE]: "{ not json" });
    expect(() =>
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
      }),
    ).toThrowError(/groundwork\.lock\.json/);
  });

  it("refuses a lock newer than the running CLI and points at a newer npx", () => {
    writeLock(lockOf({ baseVersion: "1.1.0" }));
    let thrown: unknown;
    try {
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.0.0",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toContain(
      "npx @monte3l/groundwork@1.1.0",
    );
  });

  it("refuses an unknown-origin project with no lock and no matching files, asking for --base-version", () => {
    writeTree(project, { "readme.txt": "hello" });
    let thrown: unknown;
    try {
      resolveUpdateBase({
        targetDir: project,
        history,
        runningVersion: "1.2.0",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toContain(
      "--base-version <x.y.z>",
    );
  });

  describe("inference", () => {
    it("picks the version whose hashes match the most project files", () => {
      const h = coreHistory({
        "1.0.0": FILES,
        "1.1.0": { ...FILES, "e.txt": "e2", "f.txt": "f2" },
      });
      writeTree(project, FILES);
      expect(
        resolveUpdateBase({
          targetDir: project,
          history: h,
          runningVersion: "1.2.0",
        }),
      ).toMatchObject({ version: "1.0.0", source: "inferred" });
    });

    it("breaks a tie toward the OLDEST version (over-reporting beats a false up-to-date)", () => {
      writeTree(project, FILES);
      expect(
        resolveUpdateBase({
          targetDir: project,
          history,
          runningVersion: "1.2.0",
        }),
      ).toMatchObject({ version: "1.0.0", source: "inferred" });
    });

    it("names the running version when the live templates (coreDir) match best, though the history lacks it", () => {
      writeTree(project, FILES);
      writeTree(core, FILES);
      const older = coreHistory({
        "1.0.0": { ...FILES, "d.txt": "d0", "e.txt": "e0", "f.txt": "f0" },
      });
      expect(
        resolveUpdateBase({
          targetDir: project,
          history: older,
          runningVersion: "1.2.0",
          coreDir: core,
        }),
      ).toMatchObject({ version: "1.2.0", source: "inferred" });
    });

    it("prefers the oldest recorded release over the live templates on a tie", () => {
      writeTree(project, FILES);
      writeTree(core, FILES);
      expect(
        resolveUpdateBase({
          targetDir: project,
          history: coreHistory({ "1.0.0": FILES }),
          runningVersion: "1.2.0",
          coreDir: core,
        }),
      ).toMatchObject({ version: "1.0.0", source: "inferred" });
    });

    it("accepts exactly five matching files", () => {
      const five = Object.fromEntries(Object.entries(FILES).slice(0, 5));
      writeTree(project, five);
      expect(
        resolveUpdateBase({
          targetDir: project,
          history: coreHistory({ "1.0.0": FILES }),
          runningVersion: "1.2.0",
        }),
      ).toMatchObject({ version: "1.0.0", source: "inferred" });
    });

    it("refuses four matching files", () => {
      const four = Object.fromEntries(Object.entries(FILES).slice(0, 4));
      writeTree(project, four);
      expect(() =>
        resolveUpdateBase({
          targetDir: project,
          history: coreHistory({ "1.0.0": FILES }),
          runningVersion: "1.2.0",
        }),
      ).toThrowError(CliUsageError);
    });

    it("does not count files whose bytes differ", () => {
      writeTree(project, { ...FILES, "a.txt": "x", "b.txt": "y" });
      expect(() =>
        resolveUpdateBase({
          targetDir: project,
          history: coreHistory({ "1.0.0": FILES }),
          runningVersion: "1.2.0",
        }),
      ).toThrowError(CliUsageError);
    });

    it("infers a real release from a project emitted from the real templates", () => {
      const loaded = loadTemplateHistory();
      if (!("history" in loaded)) throw new Error(loaded.note);
      bootstrapInto(project);
      const base = resolveUpdateBase({
        targetDir: project,
        history: loaded.history,
        runningVersion: "999.0.0",
      });
      expect(base.source).toBe("inferred");
      expect(Object.keys(loaded.history.versions)).toContain(base.version);
    });
  });
});

describe("diffAgainstHistory (core)", () => {
  const baseFiles = { "a.txt": "a", "b.txt": "b", "c.txt": "c" };

  function diff(
    options: {
      history?: TemplateHistory;
      lock?: Lock;
    } = {},
  ): ReturnType<typeof diffAgainstHistory> {
    return diffAgainstHistory({
      targetDir: project,
      history: options.history ?? coreHistory({ "1.0.0": baseFiles }),
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot: join(root, "no-packs"),
      ...(options.lock === undefined ? {} : { lock: options.lock }),
      ledger: [],
    });
  }

  it("reports nothing for an identical tree", () => {
    writeTree(core, baseFiles);
    writeTree(project, baseFiles);
    expect(diff().core).toEqual({ changed: [], added: [], removed: [] });
  });

  it("reports changed, added and removed paths", () => {
    writeTree(core, { "a.txt": "A!", "b.txt": "b", "new.txt": "n" });
    writeTree(project, baseFiles);
    expect(diff().core).toEqual({
      changed: ["a.txt"],
      added: ["new.txt"],
      removed: ["c.txt"],
    });
  });

  it("restores escaped dotfile names and does not substitute tokens", () => {
    writeTree(core, {
      _gitignore: "node_modules\n",
      "README.md": "# __PROJECT_NAME__\n",
    });
    const history = coreHistory({
      "1.0.0": {
        ".gitignore": "node_modules\n",
        "README.md": "# __PROJECT_NAME__\n",
      },
    });
    expect(diff({ history }).core).toEqual({
      changed: [],
      added: [],
      removed: [],
    });
  });

  it("excludes paths on the lock's skip list from every count", () => {
    writeTree(core, { "a.txt": "A!", "new.txt": "n" });
    writeTree(project, baseFiles);
    const lock = lockOf({
      skip: ["a.txt", "new.txt", "c.txt"],
      files: [lockFile("b.txt", "installed"), lockFile("c.txt", "installed")],
    });
    // c.txt is skipped; b.txt is not, so it alone is a removal.
    expect(diff({ lock }).core).toEqual({
      changed: [],
      added: [],
      removed: ["b.txt"],
    });
  });

  it.each(["declined", "removed"] as const)(
    "excludes lock entries with status %s from every count",
    (status) => {
      writeTree(core, { "a.txt": "A!", "b.txt": "b", "new.txt": "n" });
      const lock = lockOf({
        files: [
          lockFile("a.txt", status),
          lockFile("new.txt", status),
          lockFile("c.txt", status),
        ],
      });
      expect(diff({ lock }).core).toEqual({
        changed: [],
        added: [],
        removed: [],
      });
    },
  );

  it("with a lock, counts a removed path listed installed or kept, but not declined or removed", () => {
    writeTree(core, { "a.txt": "a" });
    const files = { ...baseFiles, "d.txt": "d", "e.txt": "e" };
    writeTree(project, files);
    const lock = lockOf({
      files: [
        lockFile("b.txt", "installed"),
        lockFile("c.txt", "kept"),
        lockFile("d.txt", "declined"),
        lockFile("e.txt", "removed"),
      ],
    });
    expect(
      diff({ lock, history: coreHistory({ "1.0.0": files }) }).core.removed,
    ).toEqual(["b.txt", "c.txt"]);
  });

  it("with no lock, counts a removed path only when the file exists in the project", () => {
    writeTree(core, { "a.txt": "a" });
    writeTree(project, { "b.txt": "b" });
    expect(diff().core.removed).toEqual(["b.txt"]);
  });
});

describe("diffAgainstHistory (packs)", () => {
  let packsRoot: string;

  /** Copies the real quality pack into a throwaway packs root. */
  function realPackCopy(): void {
    packsRoot = join(root, "packs");
    cpSync(join(packsRootDir(), "quality"), join(packsRoot, "quality"), {
      recursive: true,
    });
  }

  /** A history recording the copied pack's manifest but none of its files. */
  function historyOfCurrentPack(): TemplateHistory {
    const text = serializePackManifest(loadPack("quality", packsRoot).manifest);
    if (text === undefined) throw new Error("manifest is not JSON");
    return {
      schemaVersion: 1,
      versions: {
        "1.0.0": {
          core: {},
          packs: { quality: { manifest: sha(text), files: {} } },
        },
      },
      blobs: { [sha(text)]: text },
    };
  }

  it("does not report packs missing from the ledger", () => {
    realPackCopy();
    const result = diffAgainstHistory({
      targetDir: project,
      history: historyOfCurrentPack(),
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [],
    });
    expect(result.packs).toEqual([]);
  });

  it("notes, and does not report as changed, a pack the history lacks at that version", () => {
    realPackCopy();
    const result = diffAgainstHistory({
      targetDir: project,
      history: coreHistory({ "1.0.0": {} }),
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [{ name: "quality" }],
    });
    expect(result.packs).toEqual([]);
    expect(result.notes.join("\n")).toContain("quality");
  });

  it("compares a pack against its own ledger cliVersion, not the base", () => {
    realPackCopy();
    const history = historyOfCurrentPack();
    // The pack is recorded only at 1.0.0: a ledger version of 0.5.0 (absent)
    // is a note, while the base 1.0.0 would have yielded a comparison.
    const result = diffAgainstHistory({
      targetDir: project,
      history,
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [{ name: "quality", cliVersion: "0.5.0" }],
    });
    expect(result.packs).toEqual([]);
    expect(result.notes.join("\n")).toContain("quality");
  });

  it("falls back to the base version when the ledger entry has no cliVersion, and reports files added upstream", () => {
    realPackCopy();
    // The recorded pack holds no files; the shipped pack has some -> added.
    const result = diffAgainstHistory({
      targetDir: project,
      history: historyOfCurrentPack(),
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [{ name: "quality" }],
    });
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      name: "quality",
      manifestChanged: false,
      changed: [],
      removed: [],
    });
    expect(result.packs[0]?.added.length).toBeGreaterThan(0);
  });

  it("reports a recorded file the shipped pack lacks as removed, and a differing hash as changed", () => {
    realPackCopy();
    const base = historyOfCurrentPack();
    const shipped = diffAgainstHistory({
      targetDir: project,
      history: base,
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [{ name: "quality" }],
    }).packs[0];
    const shippedFiles = shipped?.added ?? [];
    const [first, ...rest] = shippedFiles;
    if (first === undefined) throw new Error("expected shipped pack files");
    const entry = base.versions["1.0.0"];
    if (entry === undefined) throw new Error("fixture");
    const recorded = entry.packs["quality"];
    if (recorded === undefined) throw new Error("fixture");
    const history: TemplateHistory = {
      ...base,
      versions: {
        "1.0.0": {
          core: {},
          packs: {
            quality: {
              manifest: recorded.manifest,
              files: {
                [first]: sha("stale contents"),
                "gone/upstream.txt": sha("x"),
              },
            },
          },
        },
      },
    };
    const result = diffAgainstHistory({
      targetDir: project,
      history,
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [{ name: "quality" }],
    }).packs[0];
    expect(result?.changed).toEqual([first]);
    expect(result?.removed).toEqual(["gone/upstream.txt"]);
    expect(result?.added).toEqual(rest.sort());
  });

  it("reports a manifest hash difference", () => {
    realPackCopy();
    const base = historyOfCurrentPack();
    const other = `${JSON.stringify({ different: true }, null, 2)}\n`;
    const history: TemplateHistory = {
      ...base,
      versions: {
        "1.0.0": {
          core: {},
          packs: { quality: { manifest: sha(other), files: {} } },
        },
      },
      blobs: { [sha(other)]: other },
    };
    const result = diffAgainstHistory({
      targetDir: project,
      history,
      baseVersion: "1.0.0",
      coreDir: core,
      packsRoot,
      ledger: [{ name: "quality" }],
    }).packs[0];
    expect(result?.manifestChanged).toBe(true);
  });
});
