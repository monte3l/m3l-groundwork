// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `record-bootstrap.ts` against a real temp directory: attribution, the
 * ledger, snapshot replacement and the destination guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeRecordDestination,
  recordFreshBootstrap,
} from "../src/record-bootstrap.js";
import { parseLock } from "../src/lock.js";
import { listPackNames, loadPack } from "../src/packs.js";

const renameControl = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameControl.fail) throw new Error("injected rename failure");
      actual.renameSync(...args);
    },
  };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "record-bootstrap-"));
});

afterEach(() => {
  renameControl.fail = false;
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function readLockFile() {
  return parseLock(
    readFileSync(join(root, ".groundwork", "groundwork.lock.json"), "utf8"),
  );
}

describe("recordFreshBootstrap", () => {
  it("attributes a path a pack wrote to that pack, over the core file at the same path", () => {
    const name = listPackNames()[0] as string;
    const { manifest } = loadPack(name);
    put("shared.txt", "from pack");
    put("only-core.txt", "core");
    put("ledger-only.txt", "x");

    const count = recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["shared.txt", "only-core.txt"],
      skillFiles: [],
      packs: [
        {
          manifest,
          filesWritten: ["shared.txt", "ledger-only.txt"],
          wiringApplied: ["w"],
        },
      ],
    });

    expect(count).toBe(3);
    const bySource = Object.fromEntries(
      readLockFile().files.map((f) => [f.path, f.source]),
    );
    expect(bySource).toEqual({
      "shared.txt": `pack:${manifest.name}`,
      "only-core.txt": "core",
      "ledger-only.txt": `pack:${manifest.name}`,
    });
    const ledger = JSON.parse(
      readFileSync(join(root, ".groundwork", "installed-packs.json"), "utf8"),
    ) as { packs: { name: string; wiring: { applied: string[] } }[] };
    expect(ledger.packs.map((p) => p.name)).toEqual([manifest.name]);
    expect(ledger.packs[0]?.wiring.applied).toEqual(["w"]);
  });

  it("writes no ledger without packs, and replaces a stale base snapshot", () => {
    put("a.txt", "A");
    put(".groundwork/base/stale.txt.base", "old");

    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [],
    });

    expect(existsSync(join(root, ".groundwork", "installed-packs.json"))).toBe(
      false,
    );
    expect(
      existsSync(join(root, ".groundwork", "base", "stale.txt.base")),
    ).toBe(false);
    expect(
      readFileSync(join(root, ".groundwork", "base", "a.txt.base"), "utf8"),
    ).toBe("A");
  });

  it("propagates the filesystem error when a recorded file is missing", () => {
    expect(() =>
      recordFreshBootstrap({
        targetDir: root,
        tokens: {},
        coreFiles: ["missing.txt"],
        skillFiles: [],
        packs: [],
      }),
    ).toThrow(/ENOENT/);
  });
});

describe("recordFreshBootstrap re-record", () => {
  it("removes the previous lock when the re-record fails midway, and still throws", () => {
    put("a.txt", "A");
    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [],
    });
    const lockPath = join(root, ".groundwork", "groundwork.lock.json");
    expect(existsSync(lockPath)).toBe(true);

    expect(() =>
      recordFreshBootstrap({
        targetDir: root,
        tokens: {},
        coreFiles: ["a.txt", "missing.txt"],
        skillFiles: [],
        packs: [],
      }),
    ).toThrow(/ENOENT/);

    expect(existsSync(lockPath)).toBe(false);
  });
});

const LEDGER_REL = ".groundwork/installed-packs.json";

function ledgerEntry(name: string, via: string): Record<string, unknown> {
  return {
    name,
    installedAt: "2026-01-01T00:00:00.000Z",
    via,
    cliVersion: "0.0.0",
    manifestSha256: "a".repeat(64),
    files: [],
    wiring: { applied: [], skipped: [] },
    dropped: [],
  };
}

function seedLedger(entries: Record<string, unknown>[]): string {
  const text = `${JSON.stringify({ schemaVersion: 1, packs: entries }, null, 2)}\n`;
  put(LEDGER_REL, text);
  return text;
}

function readLedger(): { packs: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(root, LEDGER_REL), "utf8")) as {
    packs: Record<string, unknown>[];
  };
}

describe("recordFreshBootstrap ledger on a re-run", () => {
  it("leaves an existing ledger byte-identical when no pack is installed", () => {
    put("a.txt", "A");
    const before = seedLedger([ledgerEntry("x", "add-pack")]);

    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [],
    });

    expect(readFileSync(join(root, LEDGER_REL), "utf8")).toBe(before);
  });

  it("keeps an existing entry untouched and adds the newly installed pack", () => {
    const { manifest } = loadPack(listPackNames()[0] as string);
    put("a.txt", "A");
    put("p.txt", "P");
    const existing = ledgerEntry("x", "add-pack");
    seedLedger([existing]);

    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [{ manifest, filesWritten: ["p.txt"], wiringApplied: [] }],
    });

    const { packs } = readLedger();
    expect(packs.find((p) => p["name"] === "x")).toEqual(existing);
    const added = packs.find((p) => p["name"] === manifest.name);
    expect(added?.["via"]).toBe("fresh");
    expect(packs).toHaveLength(2);
  });

  it("replaces the entry of a re-installed pack with a fresh one and keeps the others", () => {
    const { manifest } = loadPack(listPackNames()[0] as string);
    put("a.txt", "A");
    put("p.txt", "P");
    const other = ledgerEntry("x", "add-pack");
    seedLedger([ledgerEntry(manifest.name, "add-pack"), other]);

    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [{ manifest, filesWritten: ["p.txt"], wiringApplied: [] }],
    });

    const { packs } = readLedger();
    expect(packs).toHaveLength(2);
    expect(packs.find((p) => p["name"] === "x")).toEqual(other);
    const replaced = packs.filter((p) => p["name"] === manifest.name);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.["via"]).toBe("fresh");
    expect(replaced[0]?.["files"]).toHaveLength(1);
  });
});

describe("recordFreshBootstrap ledger entries of unexpected shape", () => {
  it("keeps entries without a string name untouched and still adds the new pack", () => {
    const { manifest } = loadPack(listPackNames()[0] as string);
    put("a.txt", "A");
    put("p.txt", "P");
    const odd: unknown[] = ["junk", 7, { name: 5 }, { other: true }];
    put(
      LEDGER_REL,
      JSON.stringify({
        schemaVersion: 1,
        packs: [...odd, ledgerEntry("x", "add-pack")],
      }),
    );

    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [{ manifest, filesWritten: ["p.txt"], wiringApplied: [] }],
    });

    const { packs } = readLedger();
    expect(packs.slice(0, 4)).toEqual(odd);
    expect(packs).toHaveLength(6);
    expect(packs[5]?.["name"]).toBe(manifest.name);
  });
});

describe("assertSafeRecordDestination on an existing ledger", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["a wrong schema version", JSON.stringify({ schemaVersion: 2, packs: [] })],
    [
      "an entry named __proto__",
      '{"schemaVersion":1,"packs":[{"name":"__proto__"}]}',
    ],
    [
      "an entry named constructor",
      '{"schemaVersion":1,"packs":[{"name":"constructor"}]}',
    ],
    ["a top-level array", "[]"],
    ["a null document", "null"],
    ["a missing packs key", JSON.stringify({ schemaVersion: 1 })],
    ["a packs value that is not an array", '{"schemaVersion":1,"packs":{}}'],
    [
      "an entry named prototype",
      '{"schemaVersion":1,"packs":[{"name":"prototype"}]}',
    ],
  ])("refuses a ledger with %s, naming the file", (_label, text) => {
    put(LEDGER_REL, text);
    expect(() => {
      assertSafeRecordDestination(root);
    }).toThrow(/installed-packs\.json.*not a valid ledger/s);
  });

  it("accepts a valid existing ledger", () => {
    seedLedger([ledgerEntry("x", "add-pack")]);
    expect(() => {
      assertSafeRecordDestination(root);
    }).not.toThrow();
  });
});

describe("assertSafeRecordDestination", () => {
  it("accepts a target with no .groundwork", () => {
    expect(() => {
      assertSafeRecordDestination(root);
    }).not.toThrow();
  });

  it("refuses a symlinked .groundwork", () => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, ".groundwork"));
    expect(() => {
      assertSafeRecordDestination(root);
    }).toThrow(/\.groundwork/);
  });

  it("refuses a .groundwork/base that is a file", () => {
    put(".groundwork/base", "not a dir");
    expect(() => {
      assertSafeRecordDestination(root);
    }).toThrow(/base/);
  });

  it.each([
    ".groundwork/groundwork.lock.json",
    ".groundwork/installed-packs.json",
  ])("refuses %s when it is a directory", (rel) => {
    mkdirSync(join(root, rel), { recursive: true });
    expect(() => {
      assertSafeRecordDestination(root);
    }).toThrow(/installed-packs\.json|groundwork\.lock\.json/);
  });
});

describe("the temporary lock path", () => {
  const TMP_REL = ".groundwork/groundwork.lock.json.tmp";

  it("refuses a symlink at the temp lock path before any write, leaving its target untouched", () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "");
    mkdirSync(join(root, ".groundwork"), { recursive: true });
    symlinkSync(outside, join(root, TMP_REL));

    expect(() => {
      assertSafeRecordDestination(root);
    }).toThrow(/symlink.*groundwork\.lock\.json\.tmp/is);
    expect(readFileSync(outside, "utf8")).toBe("");
  });

  it("refuses a directory at the temp lock path, naming it", () => {
    mkdirSync(join(root, TMP_REL), { recursive: true });
    expect(() => {
      assertSafeRecordDestination(root);
    }).toThrow(/groundwork\.lock\.json\.tmp/);
  });

  it("leaves no temp lock behind when the rename fails, and propagates the error", () => {
    put("a.txt", "A");
    renameControl.fail = true;

    expect(() =>
      recordFreshBootstrap({
        targetDir: root,
        tokens: {},
        coreFiles: ["a.txt"],
        skillFiles: [],
        packs: [],
      }),
    ).toThrow(/injected rename failure/);

    expect(existsSync(join(root, TMP_REL))).toBe(false);
    expect(existsSync(join(root, ".groundwork", "groundwork.lock.json"))).toBe(
      false,
    );
  });
});

describe("ledger merge pinning", () => {
  function seedRaw(packs: unknown[]): void {
    put(
      LEDGER_REL,
      JSON.stringify({ schemaVersion: 1, extra: 1, packs }, null, 2),
    );
  }

  function run(manifest: ReturnType<typeof loadPack>["manifest"]): void {
    put("a.txt", "A");
    put("p.txt", "P");
    recordFreshBootstrap({
      targetDir: root,
      tokens: {},
      coreFiles: ["a.txt"],
      skillFiles: [],
      packs: [{ manifest, filesWritten: ["p.txt"], wiringApplied: [] }],
    });
  }

  it("keeps unknown top-level keys, replaces in place and preserves the order of the others", () => {
    const { manifest } = loadPack(listPackNames()[0] as string);
    const x = ledgerEntry("x", "add-pack");
    const y = ledgerEntry("y", "add-pack");
    seedRaw([x, ledgerEntry(manifest.name, "add-pack"), y]);

    run(manifest);

    const ledger = JSON.parse(readFileSync(join(root, LEDGER_REL), "utf8")) as {
      extra: unknown;
      packs: Record<string, unknown>[];
    };
    expect(ledger.extra).toBe(1);
    expect(ledger.packs.map((p) => p["name"])).toEqual([
      "x",
      manifest.name,
      "y",
    ]);
    expect(ledger.packs[0]).toEqual(x);
    expect(ledger.packs[1]?.["via"]).toBe("fresh");
    expect(ledger.packs[2]).toEqual(y);
  });

  it("collapses duplicate same-name entries of a reinstalled pack into one replaced entry", () => {
    const { manifest } = loadPack(listPackNames()[0] as string);
    const x = ledgerEntry("x", "add-pack");
    seedRaw([
      ledgerEntry(manifest.name, "add-pack"),
      x,
      ledgerEntry(manifest.name, "add-pack"),
    ]);

    run(manifest);

    const { packs } = readLedger();
    expect(packs.map((p) => p["name"])).toEqual([manifest.name, "x"]);
    expect(packs[0]?.["via"]).toBe("fresh");
    expect(packs[1]).toEqual(x);
  });
});
