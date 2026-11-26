// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Read-only per-project pack installation status (issue #377, slice 2):
 * origin classification, tokenized-template matching, the installed-packs
 * ledger reader, file/wiring facts and the pure classifier. Fixtures are
 * REAL bootstrapped trees (`templates/core` plus a real pack, emitted into a
 * per-test mkdtemp sandbox), never a mock of the thing under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodIneffective } from "./chmod-ineffective.js";
import { emitTemplate } from "../src/emit.js";
import { templatesCoreDir } from "../src/main.js";
import { installPack, listPackNames, loadPack } from "../src/packs.js";
import {
  classifyPackInstallation,
  classifyProjectOrigin,
  collectPackInstallFacts,
  PACK_STATUS_LABELS,
  inspectPackInstallations,
  isPackOutdated,
  matchesTokenizedTemplate,
  readInstalledPacksLedger,
} from "../src/pack-installation.js";
import { resolveCliVersion } from "../src/inventory.js";
import { restoreDotfilePath } from "../src/assets.js";
import { loadTemplateHistory } from "../src/template-history.js";
import type { TemplateHistory } from "../src/template-history.js";
import type { Pack } from "../src/packs.js";
import type {
  LedgerEntry,
  PackInstallFacts,
  ProjectOrigin,
} from "../src/pack-installation.js";

const TOKENS = { PROJECT_NAME: "acme", YEAR: "2026" };
const BOOTSTRAPPED: ProjectOrigin = { kind: "bootstrapped", evidence: [] };
const UNKNOWN: ProjectOrigin = { kind: "unknown", evidence: [] };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pack-installation-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** A bootstrapped project: the real baseline plus the named real packs. */
function bootstrap(packs: string[] = []): string {
  const dir = join(root, "project");
  emitTemplate(templatesCoreDir(), dir, TOKENS);
  for (const name of packs) {
    installPack(loadPack(name), dir, TOKENS);
  }
  return dir;
}

const VALID_INVENTORY = JSON.stringify({ schemaVersion: 1 });

describe("classifyProjectOrigin", () => {
  it("classifies a valid .groundwork/inventory.json as adopted, carrying its schema version", () => {
    write(
      root,
      ".groundwork/inventory.json",
      JSON.stringify({ schemaVersion: 3 }),
    );
    const origin = classifyProjectOrigin(root);
    expect(origin.kind).toBe("adopted");
    if (origin.kind === "adopted") {
      expect(origin.inventorySchemaVersion).toBe(3);
    }
    expect(origin.evidence.length).toBeGreaterThan(0);
  });

  it.each([
    ["a string schemaVersion", JSON.stringify({ schemaVersion: "1" })],
    ["a fractional schemaVersion", JSON.stringify({ schemaVersion: 1.5 })],
    ["no schemaVersion", JSON.stringify({})],
    ["a non-object", JSON.stringify([1])],
    ["malformed JSON", "{ not json"],
  ])("does not treat an inventory with %s as adopted", (_label, content) => {
    write(root, ".groundwork/inventory.json", content);
    expect(classifyProjectOrigin(root).kind).not.toBe("adopted");
  });

  it("does not follow a symlinked inventory.json", () => {
    write(root, "elsewhere/inv.json", VALID_INVENTORY);
    mkdirSync(join(root, ".groundwork"), { recursive: true });
    symlinkSync(
      join(root, "elsewhere/inv.json"),
      join(root, ".groundwork/inventory.json"),
    );
    expect(classifyProjectOrigin(root).kind).not.toBe("adopted");
  });

  it("does not treat a directory named inventory.json as adopted", () => {
    mkdirSync(join(root, ".groundwork/inventory.json"), { recursive: true });
    expect(classifyProjectOrigin(root).kind).not.toBe("adopted");
  });

  it.each([
    ["a packs/ directory", ".groundwork/packs/x.txt"],
    ["a baseline/ directory", ".groundwork/baseline/x.txt"],
    ["an adoption-report.md", ".groundwork/adoption-report.md"],
    ["a .packs-* work dir", ".groundwork/.packs-abc123/x.txt"],
    ["a .baseline-* work dir", ".groundwork/.baseline-abc123/x.txt"],
  ])("classifies %s without an inventory as interrupted-adopt", (_l, rel) => {
    write(root, rel, "x");
    const origin = classifyProjectOrigin(root);
    expect(origin.kind).toBe("interrupted-adopt");
    expect(origin.evidence.length).toBeGreaterThan(0);
  });

  it("classifies the real baseline as bootstrapped with evidence", () => {
    const dir = bootstrap();
    const origin = classifyProjectOrigin(dir);
    expect(origin.kind).toBe("bootstrapped");
    expect(origin.evidence.length).toBeGreaterThan(0);
  });

  it.each([
    "bin/verify.mjs",
    "bin/lib/verify-steps.mjs",
    "bin/lib/verify-steps.packs.json",
    ".claude/settings.json",
  ])("is unknown, not bootstrapped, when %s is missing", (missing) => {
    const dir = bootstrap();
    unlinkSync(join(dir, missing));
    expect(classifyProjectOrigin(dir).kind).toBe("unknown");
  });

  it("is unknown for an empty directory", () => {
    expect(classifyProjectOrigin(root).kind).toBe("unknown");
  });

  it("ranks adopted above bootstrapped", () => {
    const dir = bootstrap();
    write(dir, ".groundwork/inventory.json", VALID_INVENTORY);
    expect(classifyProjectOrigin(dir).kind).toBe("adopted");
  });

  it("ranks adopted above interrupted-adopt", () => {
    write(root, ".groundwork/packs/x.txt", "x");
    write(root, ".groundwork/inventory.json", VALID_INVENTORY);
    expect(classifyProjectOrigin(root).kind).toBe("adopted");
  });

  it("ranks interrupted-adopt above bootstrapped", () => {
    const dir = bootstrap();
    write(dir, ".groundwork/adoption-report.md", "x");
    expect(classifyProjectOrigin(dir).kind).toBe("interrupted-adopt");
  });
});

describe("matchesTokenizedTemplate", () => {
  const KEYS = ["PROJECT_NAME", "YEAR"];

  it.each([
    ["same value", "name: __PROJECT_NAME__\n", "name: acme\n", true],
    ["a different value", "name: __PROJECT_NAME__\n", "name: other-x\n", true],
    [
      "two tokens",
      "(c) __YEAR__ __PROJECT_NAME__\n",
      "(c) 1999 widgets\n",
      true,
    ],
    ["token at start", "__PROJECT_NAME__ tail", "zed tail", true],
    ["token at end", "head __PROJECT_NAME__", "head zed", true],
    ["an empty token slot", "name: __PROJECT_NAME__\n", "name: \n", false],
    ["a newline inside a slot", "a __PROJECT_NAME__ b", "a x\ny b", false],
    ["changed text after a token", "a __YEAR__ b", "a 1 c", false],
    ["changed text before a token", "a __YEAR__ b", "z 1 b", false],
    ["extra trailing text", "a __YEAR__ b", "a 1 b extra", false],
    ["extra leading text", "a __YEAR__ b", "extra a 1 b", false],
    ["a missing trailing piece", "a __YEAR__ b", "a 1", false],
    [
      "pieces out of order",
      "x __YEAR__ y __PROJECT_NAME__ z",
      "x 1 z 2 y",
      false,
    ],
  ])("%s", (_label, template, actual, expected) => {
    expect(matchesTokenizedTemplate(template, actual, KEYS)).toBe(expected);
  });

  it("is plain equality for a template with no tokens", () => {
    expect(matchesTokenizedTemplate("same", "same", KEYS)).toBe(true);
    expect(matchesTokenizedTemplate("same", "same ", KEYS)).toBe(false);
  });

  it("leaves __KEY__ text for a key outside tokenKeys as a literal", () => {
    expect(
      matchesTokenizedTemplate("a __OTHER__ b", "a __OTHER__ b", KEYS),
    ).toBe(true);
    expect(matchesTokenizedTemplate("a __OTHER__ b", "a x b", KEYS)).toBe(
      false,
    );
  });

  it("treats regex metacharacters in the template as literals", () => {
    expect(matchesTokenizedTemplate("a.*(b) __YEAR__", "a.*(b) 1", KEYS)).toBe(
      true,
    );
    expect(matchesTokenizedTemplate("a.*(b) __YEAR__", "aXXb 1", KEYS)).toBe(
      false,
    );
  });
});

describe("readInstalledPacksLedger", () => {
  const LEDGER = ".groundwork/installed-packs.json";

  it("returns empty names and no notes when the file is missing", () => {
    expect(readInstalledPacksLedger(root)).toEqual({
      names: [],
      entries: [],
      undetermined: [],
    });
  });

  it("reads the names of a valid schema-1 ledger", () => {
    write(
      root,
      LEDGER,
      JSON.stringify({
        schemaVersion: 1,
        packs: [{ name: "quality", extra: 1 }, { name: "statusline" }],
      }),
    );
    expect(readInstalledPacksLedger(root)).toEqual({
      names: ["quality", "statusline"],
      entries: [{ name: "quality" }, { name: "statusline" }],
      undetermined: [],
    });
  });

  it("returns entries carrying cliVersion and manifestSha256 when they are strings", () => {
    write(
      root,
      LEDGER,
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            name: "quality",
            cliVersion: "1.4.0",
            manifestSha256: "ab".repeat(32),
          },
          { name: "statusline", cliVersion: "1.5.0" },
        ],
      }),
    );
    expect(readInstalledPacksLedger(root).entries).toEqual([
      { name: "quality", cliVersion: "1.4.0", manifestSha256: "ab".repeat(32) },
      { name: "statusline", cliVersion: "1.5.0" },
    ]);
  });

  it("drops an optional field that is not a string but keeps the entry", () => {
    write(
      root,
      LEDGER,
      JSON.stringify({
        schemaVersion: 1,
        packs: [{ name: "quality", cliVersion: 7, manifestSha256: null }],
      }),
    );
    const result = readInstalledPacksLedger(root);
    expect(result.names).toEqual(["quality"]);
    expect(result.entries).toEqual([{ name: "quality" }]);
    expect(result.undetermined).toEqual([]);
  });

  it("keeps entries in step with names when bad entries are skipped, with the same note", () => {
    write(
      root,
      LEDGER,
      `{"schemaVersion":1,"packs":[{"name":"__proto__","cliVersion":"1.0.0"},{"name":7},{"name":"quality","cliVersion":"1.4.0"}]}`,
    );
    const result = readInstalledPacksLedger(root);
    expect(result.names).toEqual(["quality"]);
    expect(result.entries).toEqual([{ name: "quality", cliVersion: "1.4.0" }]);
    expect(result.undetermined).toHaveLength(1);
    expect(result.undetermined[0]).toMatch(
      /2 entries without a usable pack name/,
    );
  });

  it.each([
    ["malformed JSON", "{ nope"],
    ["a non-object", "[1, 2]"],
    [
      "a future schemaVersion",
      JSON.stringify({ schemaVersion: 2, packs: [{ name: "quality" }] }),
    ],
    [
      "a missing schemaVersion",
      JSON.stringify({ packs: [{ name: "quality" }] }),
    ],
  ])(
    "skips the whole file with a note for %s, never throwing",
    (_l, content) => {
      write(root, LEDGER, content);
      const result = readInstalledPacksLedger(root);
      expect(result.names).toEqual([]);
      expect(result.undetermined.length).toBeGreaterThan(0);
    },
  );

  it("skips a non-string or prototype-sensitive entry but keeps the rest, with a note", () => {
    const polluted = `{"schemaVersion":1,"packs":[{"name":"__proto__"},{"name":7},{"name":"quality"},{"name":"constructor"}]}`;
    write(root, LEDGER, polluted);
    const result = readInstalledPacksLedger(root);
    expect(result.names).toEqual(["quality"]);
    expect(result.undetermined.length).toBeGreaterThan(0);
  });

  it("does not follow a symlinked ledger", () => {
    write(
      root,
      "elsewhere/l.json",
      JSON.stringify({ schemaVersion: 1, packs: [{ name: "quality" }] }),
    );
    mkdirSync(join(root, ".groundwork"), { recursive: true });
    symlinkSync(join(root, "elsewhere/l.json"), join(root, LEDGER));
    const result = readInstalledPacksLedger(root);
    expect(result.names).toEqual([]);
    expect(result.undetermined.length).toBeGreaterThan(0);
  });

  it("does not read a directory in place of the ledger", () => {
    mkdirSync(join(root, LEDGER), { recursive: true });
    const result = readInstalledPacksLedger(root);
    expect(result.names).toEqual([]);
    expect(result.undetermined.length).toBeGreaterThan(0);
  });
});

describe("collectPackInstallFacts + classifyPackInstallation (real fixtures)", () => {
  function inspect(
    dir: string,
    packName: string,
    origin: ProjectOrigin = BOOTSTRAPPED,
    tokens: Record<string, string> = TOKENS,
  ): { facts: PackInstallFacts; undetermined: string[] } {
    const undetermined: string[] = [];
    const facts = collectPackInstallFacts(
      dir,
      loadPack(packName),
      tokens,
      origin,
      undetermined,
    );
    return { facts, undetermined };
  }

  function statusOf(
    facts: PackInstallFacts,
    packName: string,
    undetermined: string[],
  ): string {
    return classifyPackInstallation(facts, [], packName, undetermined).status;
  }

  it("reports a freshly installed pack as installed: files present, wiring complete", () => {
    const dir = bootstrap(["publishing"]);
    const { facts, undetermined } = inspect(dir, "publishing");
    expect(facts.files.absent).toEqual([]);
    expect(facts.files.modified).toEqual([]);
    expect(facts.files.present).toContain("bin/check-publish-version.mjs");
    expect(facts.wiring).toBe("complete");
    expect(
      classifyPackInstallation(facts, [], "publishing", undetermined),
    ).toMatchObject({ status: "installed", source: "detected" });
  });

  it("reports a pack never installed as not-installed: files absent, wiring absent", () => {
    const dir = bootstrap();
    const { facts, undetermined } = inspect(dir, "publishing");
    expect(facts.files.present).toEqual([]);
    expect(facts.files.absent).toContain("bin/check-publish-version.mjs");
    expect(facts.wiring).toBe("absent");
    expect(statusOf(facts, "publishing", undetermined)).toBe("not-installed");
  });

  it("reports a pack with one file deleted as partial and lists it under absent", () => {
    const dir = bootstrap(["publishing"]);
    unlinkSync(join(dir, "bin/check-publish-version.mjs"));
    const { facts, undetermined } = inspect(dir, "publishing");
    expect(facts.files.absent).toEqual(["bin/check-publish-version.mjs"]);
    expect(facts.files.present.length).toBeGreaterThan(0);
    expect(statusOf(facts, "publishing", undetermined)).toBe("partial");
  });

  it("reports an edited pack file as modified yet the pack still installed", () => {
    const dir = bootstrap(["publishing"]);
    const file = join(dir, "bin/check-publish-version.mjs");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n// local edit\n`);
    const { facts, undetermined } = inspect(dir, "publishing");
    expect(facts.files.modified).toEqual(["bin/check-publish-version.mjs"]);
    expect(facts.files.present).not.toContain("bin/check-publish-version.mjs");
    expect(statusOf(facts, "publishing", undetermined)).toBe("installed");
  });

  it("counts a token-bearing file installed under another project name and year as present", () => {
    const dir = bootstrap(["licensing"]);
    const { facts } = inspect(dir, "licensing", BOOTSTRAPPED, {
      PROJECT_NAME: "totally-different",
      YEAR: "1999",
    });
    expect(facts.files.present).toContain("REUSE.toml");
    expect(facts.files.modified).toEqual([]);
  });

  it("counts a token-bearing file whose non-token text changed as modified", () => {
    const dir = bootstrap(["licensing"]);
    const file = join(dir, "REUSE.toml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("version = 1", "version = 2"),
    );
    const { facts } = inspect(dir, "licensing", BOOTSTRAPPED, {
      PROJECT_NAME: "totally-different",
      YEAR: "1999",
    });
    expect(facts.files.modified).toEqual(["REUSE.toml"]);
  });

  it("reports files present but wiring removed as wiring absent and the pack partial", () => {
    const dir = bootstrap(["licensing"]);
    writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[]\n");
    const { facts, undetermined } = inspect(dir, "licensing");
    expect(facts.wiring).toBe("absent");
    expect(statusOf(facts, "licensing", undetermined)).toBe("partial");
  });

  it("reports one of two wiring parts missing as wiring partial", () => {
    // publishing wires both packageScripts and a verify step.
    const dir = bootstrap(["publishing"]);
    writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[]\n");
    const { facts } = inspect(dir, "publishing");
    expect(facts.wiring).toBe("partial");
  });

  it("treats a colliding verify step as not present, without throwing", () => {
    const dir = bootstrap();
    const real = loadPack("licensing").manifest.wiring.verifySteps[0];
    const steps = [{ ...real, cmd: ["something", "else"] }];
    writeFileSync(
      join(dir, "bin/lib/verify-steps.packs.json"),
      JSON.stringify(steps),
    );
    const { facts } = inspect(dir, "licensing");
    expect(facts.wiring).toBe("absent");
  });

  it("is not-applicable for wiring when the origin is not bootstrapped", () => {
    const dir = bootstrap(["licensing"]);
    expect(inspect(dir, "licensing", UNKNOWN).facts.wiring).toBe(
      "not-applicable",
    );
    expect(
      inspect(dir, "licensing", {
        kind: "adopted",
        evidence: [],
        inventorySchemaVersion: 1,
      }).facts.wiring,
    ).toBe("not-applicable");
  });

  it("never reports not-installed when settings.json is unparseable: wiring unknown, a note, status undetermined", () => {
    const dir = bootstrap();
    writeFileSync(join(dir, ".claude/settings.json"), "{ broken");
    const { facts, undetermined } = inspect(dir, "harness-extras");
    expect(facts.wiring).toBe("unknown");
    expect(undetermined.length).toBeGreaterThan(0);
    expect(statusOf(facts, "harness-extras", undetermined)).toBe(
      "undetermined",
    );
  });

  it("never reports not-installed when verify-steps.packs.json is unparseable", () => {
    const dir = bootstrap();
    writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "{ broken");
    const { facts, undetermined } = inspect(dir, "licensing");
    expect(facts.wiring).toBe("unknown");
    expect(statusOf(facts, "licensing", undetermined)).toBe("undetermined");
  });

  it("does not write anything while collecting facts", () => {
    const dir = bootstrap(["licensing"]);
    const before = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    inspect(dir, "licensing");
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(
      before,
    );
  });
});

describe("classifyPackInstallation (pure rules)", () => {
  const files = (
    present: string[],
    absent: string[],
    modified: string[] = [],
  ): PackInstallFacts["files"] => ({ present, absent, modified });
  const facts = (
    f: PackInstallFacts["files"],
    wiring: PackInstallFacts["wiring"],
  ): PackInstallFacts => ({ files: f, wiring });

  it.each([
    [
      "all present, wiring complete",
      files(["a", "b"], []),
      "complete",
      "installed",
    ],
    [
      "all present, wiring not-applicable",
      files(["a"], []),
      "not-applicable",
      "installed",
    ],
    [
      "present and modified, wiring complete",
      files(["a"], [], ["b"]),
      "complete",
      "installed",
    ],
    [
      "all modified, not-applicable (no file shown to match, no wiring evidence)",
      files([], [], ["a"]),
      "not-applicable",
      "partial",
    ],
    [
      "all modified, wiring complete",
      files([], [], ["a", "b"]),
      "complete",
      "installed",
    ],
    [
      "all present, wiring unknown",
      files(["a"], []),
      "unknown",
      "undetermined",
    ],
    [
      "some present some absent, wiring unknown",
      files(["a"], ["b"]),
      "unknown",
      "undetermined",
    ],
    [
      "all modified, wiring unknown",
      files([], [], ["a"]),
      "unknown",
      "undetermined",
    ],
    [
      "all absent, wiring absent",
      files([], ["a", "b"]),
      "absent",
      "not-installed",
    ],
    [
      "all absent, not-applicable",
      files([], ["a"]),
      "not-applicable",
      "not-installed",
    ],
    [
      "some absent, wiring complete",
      files(["a"], ["b"]),
      "complete",
      "partial",
    ],
    ["all present, wiring absent", files(["a"], []), "absent", "partial"],
    ["all present, wiring partial", files(["a"], []), "partial", "partial"],
    ["all absent, wiring complete", files([], ["a"]), "complete", "partial"],
    ["all absent, wiring partial", files([], ["a"]), "partial", "partial"],
  ] as const)("%s => %s", (_l, f, wiring, expected) => {
    expect(classifyPackInstallation(facts(f, wiring), [], "p", []).status).toBe(
      expected,
    );
  });

  it("returns undetermined, never not-installed, when a note exists", () => {
    const result = classifyPackInstallation(
      facts(files([], ["a"]), "absent"),
      [],
      "p",
      ["could not read x"],
    );
    expect(result.status).toBe("undetermined");
  });

  it("returns undetermined, never not-installed, for wiring unknown without a note", () => {
    const result = classifyPackInstallation(
      facts(files([], ["a"]), "unknown"),
      [],
      "p",
      [],
    );
    expect(result.status).toBe("undetermined");
  });

  it("returns undetermined for a pack with zero files and not-applicable wiring", () => {
    expect(
      classifyPackInstallation(
        facts(files([], []), "not-applicable"),
        [],
        "p",
        [],
      ).status,
    ).toBe("undetermined");
  });

  it("reports a ledger-listed pack as installed from the ledger, still returning the facts", () => {
    const f = facts(files([], ["a"]), "absent");
    const result = classifyPackInstallation(f, ["p", "q"], "p", ["a note"]);
    expect(result).toEqual({
      status: "installed",
      source: "ledger",
      files: f.files,
      wiring: "absent",
    });
  });

  it("reports detected source and ignores ledger entries for other packs", () => {
    const result = classifyPackInstallation(
      facts(files([], ["a"]), "absent"),
      ["other"],
      "p",
      [],
    );
    expect(result).toMatchObject({
      status: "not-installed",
      source: "detected",
    });
  });
});

describe("inspectPackInstallations", () => {
  it("reports the origin, every pack's modes and description, and per-pack status", () => {
    const dir = bootstrap(["licensing"]);
    const report = inspectPackInstallations(dir);
    expect(report.origin.kind).toBe("bootstrapped");
    const licensing = report.packs.find((p) => p.name === "licensing");
    const statusline = report.packs.find((p) => p.name === "statusline");
    expect(licensing?.status.status).toBe("installed");
    expect(statusline?.status.status).toBe("not-installed");
    const manifest = loadPack("licensing").manifest;
    expect(licensing?.modes).toEqual(manifest.modes);
    expect(licensing?.description).toBe(manifest.description);
  });

  it("restricts the report to the named packs", () => {
    const dir = bootstrap();
    const report = inspectPackInstallations(dir, ["statusline"]);
    expect(report.packs.map((p) => p.name)).toEqual(["statusline"]);
  });

  it("honours the ledger: a ledger-listed pack is installed with source ledger", () => {
    const dir = bootstrap();
    write(
      dir,
      ".groundwork/installed-packs.json",
      JSON.stringify({ schemaVersion: 1, packs: [{ name: "statusline" }] }),
    );
    const statusline = inspectPackInstallations(dir, ["statusline"]).packs[0];
    expect(statusline?.status).toMatchObject({
      status: "installed",
      source: "ledger",
    });
  });

  it("surfaces an unreadable settings.json as undetermined notes, not not-installed", () => {
    const dir = bootstrap();
    writeFileSync(join(dir, ".claude/settings.json"), "{ broken");
    const report = inspectPackInstallations(dir, ["statusline"]);
    expect(report.packs[0]?.status.status).toBe("undetermined");
    expect(report.undetermined.length).toBeGreaterThan(0);
  });
});

describe("untested edges of origin, ledger and facts (real fixtures)", () => {
  function inspect(
    dir: string,
    packName: string,
  ): { facts: PackInstallFacts; undetermined: string[] } {
    const undetermined: string[] = [];
    const facts = collectPackInstallFacts(
      dir,
      loadPack(packName),
      TOKENS,
      BOOTSTRAPPED,
      undetermined,
    );
    return { facts, undetermined };
  }

  function editJson(
    dir: string,
    rel: string,
    edit: (value: Record<string, unknown>) => void,
  ): void {
    const full = join(dir, rel);
    const value = JSON.parse(readFileSync(full, "utf8")) as Record<
      string,
      unknown
    >;
    edit(value);
    writeFileSync(full, JSON.stringify(value, null, 2));
  }

  describe.skipIf(chmodIneffective)(
    "an lstat failure that is not absence",
    () => {
      afterEach(() => {
        chmodSync(join(root, ".groundwork"), 0o755);
      });

      it("records the errno in origin evidence instead of reading it as missing or throwing", () => {
        write(root, ".groundwork/inventory.json", VALID_INVENTORY);
        chmodSync(join(root, ".groundwork"), 0o000);
        const origin = classifyProjectOrigin(root);
        expect(origin.kind).not.toBe("adopted");
        const evidence = origin.evidence.join("\n");
        expect(evidence).toMatch(/could not be checked \(EACCES\)/);
        expect(evidence).not.toMatch(/inventory\.json is missing/);
      });

      it("ignores an uncheckable ledger with a note rather than treating it as an empty ledger", () => {
        write(root, ".groundwork/installed-packs.json", "{}");
        chmodSync(join(root, ".groundwork"), 0o000);
        const ledger = readInstalledPacksLedger(root);
        expect(ledger.names).toEqual([]);
        expect(ledger.undetermined.join("\n")).toMatch(/EACCES/);
      });
    },
  );

  it("does not follow a symlinked .groundwork directory", () => {
    write(root, "elsewhere/inventory.json", VALID_INVENTORY);
    symlinkSync(join(root, "elsewhere"), join(root, ".groundwork"));
    const origin = classifyProjectOrigin(root);
    expect(origin.kind).not.toBe("adopted");
    expect(origin.evidence.join("\n")).toMatch(/\.groundwork is a symlink/);
  });

  it("does not treat a regular file named .groundwork as an adopt directory", () => {
    write(root, ".groundwork", VALID_INVENTORY);
    const origin = classifyProjectOrigin(root);
    expect(origin.kind).toBe("unknown");
    expect(origin.evidence.join("\n")).toMatch(/\.groundwork/);
  });

  it("treats a ledger under a regular file named .groundwork as absent (ENOTDIR): no throw, no names, no notes", () => {
    write(root, ".groundwork", "i am a file");
    expect(readInstalledPacksLedger(root)).toEqual({
      names: [],
      entries: [],
      undetermined: [],
    });
  });

  it("ignores a ledger without a packs array, with a note", () => {
    write(root, ".groundwork/installed-packs.json", '{"schemaVersion":1}');
    const ledger = readInstalledPacksLedger(root);
    expect(ledger.names).toEqual([]);
    expect(ledger.undetermined).toHaveLength(1);
    expect(ledger.undetermined[0]).toMatch(/no packs array/);
  });

  it("ignores a ledger whose packs is not an array, with a note", () => {
    write(
      root,
      ".groundwork/installed-packs.json",
      '{"schemaVersion":1,"packs":{"quality":true}}',
    );
    const ledger = readInstalledPacksLedger(root);
    expect(ledger.names).toEqual([]);
    expect(ledger.undetermined[0]).toMatch(/no packs array/);
  });

  describe("package.json scripts wiring (publishing)", () => {
    it("is complete when scripts and the verify step are merged in", () => {
      const dir = bootstrap(["publishing"]);
      expect(inspect(dir, "publishing").facts.wiring).toBe("complete");
    });

    it("counts a colliding script as not merged while the other script still counts: partial even with the verify step gone", () => {
      const dir = bootstrap(["publishing"]);
      editJson(dir, "package.json", (pkg) => {
        (pkg["scripts"] as Record<string, string>)["changeset"] = "my-own";
      });
      expect(inspect(dir, "publishing").facts.wiring).toBe("partial");
      writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[]\n");
      expect(inspect(dir, "publishing").facts.wiring).toBe("partial");
    });

    it("is absent once both scripts collide and the verify steps are gone", () => {
      const dir = bootstrap(["publishing"]);
      editJson(dir, "package.json", (pkg) => {
        const scripts = pkg["scripts"] as Record<string, string>;
        scripts["changeset"] = "my-own";
        scripts["version:packages"] = "my-own-too";
      });
      writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[]\n");
      expect(inspect(dir, "publishing").facts.wiring).toBe("absent");
    });

    it("is unknown with a package.json note when scripts is a string, without throwing", () => {
      const dir = bootstrap(["publishing"]);
      editJson(dir, "package.json", (pkg) => {
        pkg["scripts"] = "nope";
      });
      const { facts, undetermined } = inspect(dir, "publishing");
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.join("\n")).toMatch(/package\.json/);
      expect(
        classifyPackInstallation(facts, [], "publishing", undetermined).status,
      ).not.toBe("not-installed");
    });

    it("is unknown with a note when package.json is not an object", () => {
      const dir = bootstrap(["publishing"]);
      writeFileSync(join(dir, "package.json"), "[]");
      const { facts, undetermined } = inspect(dir, "publishing");
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.join("\n")).toMatch(
        /package\.json is not a JSON object/,
      );
      expect(
        classifyPackInstallation(facts, [], "publishing", undetermined).status,
      ).not.toBe("not-installed");
    });
  });

  it("is unknown with a note when settings.json is not an object", () => {
    const dir = bootstrap(["harness-extras"]);
    writeFileSync(join(dir, ".claude/settings.json"), "[]");
    const { facts, undetermined } = inspect(dir, "harness-extras");
    expect(facts.wiring).toBe("unknown");
    expect(undetermined.join("\n")).toMatch(
      /settings\.json is not a JSON object/,
    );
  });

  it("is unknown with a note when verify-steps.packs.json is not an array", () => {
    const dir = bootstrap(["licensing"]);
    writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "{}");
    const { facts, undetermined } = inspect(dir, "licensing");
    expect(facts.wiring).toBe("unknown");
    expect(undetermined.join("\n")).toMatch(/is not a JSON array/);
  });

  it("reports a token-bearing pack file replaced by a symlink as modified, never matched through the link", () => {
    // Inspected under other token values, so the content differs from the
    // template and only the symlink guard keeps it from matching as present.
    const dir = bootstrap(["licensing"]);
    const file = join(dir, "REUSE.toml");
    write(root, "elsewhere/REUSE.toml", readFileSync(file, "utf8"));
    unlinkSync(file);
    symlinkSync(join(root, "elsewhere/REUSE.toml"), file);
    const undetermined: string[] = [];
    const { files } = collectPackInstallFacts(
      dir,
      loadPack("licensing"),
      { PROJECT_NAME: "other", YEAR: "1999" },
      BOOTSTRAPPED,
      undetermined,
    );
    expect(files.modified).toContain("REUSE.toml");
    expect(files.present).not.toContain("REUSE.toml");
  });

  it("reports a key-level JSON pack file with a changed key as modified", () => {
    const dir = bootstrap(["publishing"]);
    const rel = ".changeset/config.json";
    expect(inspect(dir, "publishing").facts.files.present).toContain(rel);
    editJson(dir, rel, (config) => {
      config["changelog"] = ["somewhere-else", {}];
    });
    const { facts } = inspect(dir, "publishing");
    expect(facts.files.modified).toContain(rel);
    expect(facts.files.present).not.toContain(rel);
  });

  it("reports a key-level package.json pack file with a changed key as modified, and an untouched one as present", () => {
    const dir = bootstrap(["publishing"]);
    const rel = "tools/release/package.json";
    expect(inspect(dir, "publishing").facts.files.present).toContain(rel);
    editJson(dir, rel, (pkg) => {
      pkg["description"] = "changed by the project";
    });
    const { facts } = inspect(dir, "publishing");
    expect(facts.files.modified).toContain(rel);
    expect(facts.files.present).not.toContain(rel);
  });

  describe("hooks wiring (harness-extras)", () => {
    it("is complete, and the pack installed, after a real install", () => {
      const dir = bootstrap(["harness-extras"]);
      const { facts, undetermined } = inspect(dir, "harness-extras");
      expect(facts.wiring).toBe("complete");
      expect(
        classifyPackInstallation(facts, [], "harness-extras", undetermined)
          .status,
      ).toBe("installed");
    });

    function settingsHooks(settings: Record<string, unknown>): {
      PreToolUse: unknown[];
    } {
      return settings["hooks"] as { PreToolUse: unknown[] };
    }

    it("is absent, with no note, when settings.json has no hooks key at all", () => {
      const dir = bootstrap(["harness-extras"]);
      editJson(dir, ".claude/settings.json", (settings) => {
        Reflect.deleteProperty(settings, "hooks");
      });
      const { facts, undetermined } = inspect(dir, "harness-extras");
      expect(facts.wiring).toBe("absent");
      expect(undetermined).toEqual([]);
    });

    it.each([
      ["a hooks value that is not an object", (): unknown => "nope"],
      [
        "an event value that is not an array",
        (): unknown => ({ PreToolUse: "nope" }),
      ],
      [
        "an entry whose hooks is the string nope",
        (): unknown => ({
          PreToolUse: [{ matcher: "Bash", hooks: "nope" }],
        }),
      ],
    ])("is unknown with a note when settings.json has %s", (_label, make) => {
      const dir = bootstrap(["harness-extras"]);
      editJson(dir, ".claude/settings.json", (settings) => {
        settings["hooks"] = make();
      });
      const { facts, undetermined } = inspect(dir, "harness-extras");
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.length).toBeGreaterThan(0);
    });

    it("is partial, and the pack partial, once one hook event is removed from settings.json", () => {
      const dir = bootstrap(["harness-extras"]);
      editJson(dir, ".claude/settings.json", (settings) => {
        const hooks = settings["hooks"] as Record<string, unknown>;
        Reflect.deleteProperty(hooks, "PreCompact");
      });
      const { facts, undetermined } = inspect(dir, "harness-extras");
      expect(facts.wiring).toBe("partial");
      expect(
        classifyPackInstallation(facts, [], "harness-extras", undetermined)
          .status,
      ).toBe("partial");
    });

    it("is partial once one command is removed from a surviving hook entry", () => {
      const dir = bootstrap(["harness-extras"]);
      editJson(dir, ".claude/settings.json", (settings) => {
        for (const entry of settingsHooks(settings).PreToolUse as {
          hooks: { command: string }[];
        }[]) {
          entry.hooks = entry.hooks.filter(
            (hook) => !hook.command.includes("guard-shell-portability"),
          );
        }
      });
      expect(inspect(dir, "harness-extras").facts.wiring).toBe("partial");
    });

    it("treats a pure collision (same command, different config) as that item not present, with no note", () => {
      const dir = bootstrap(["harness-extras"]);
      editJson(dir, ".claude/settings.json", (settings) => {
        for (const entry of settingsHooks(settings).PreToolUse as {
          hooks: { command: string; timeout: number }[];
        }[]) {
          for (const hook of entry.hooks) {
            if (hook.command.includes("guard-shell-portability")) {
              hook.timeout = 99;
            }
          }
        }
      });
      const { facts, undetermined } = inspect(dir, "harness-extras");
      expect(facts.wiring).toBe("partial");
      expect(undetermined).toEqual([]);
    });

    it.each([
      ["a null entry", (own: unknown[]) => [null, ...own]],
      [
        "an entry whose hooks is not an array",
        (own: unknown[]) => [{ matcher: "Bash", hooks: "nope" }, ...own],
      ],
    ])(
      "is unknown with a note, never absent, when PreToolUse holds %s before the pack's own entry",
      (_label, corrupt) => {
        const dir = bootstrap(["harness-extras"]);
        editJson(dir, ".claude/settings.json", (settings) => {
          const hooks = settingsHooks(settings);
          hooks.PreToolUse = corrupt(hooks.PreToolUse);
        });
        const { facts, undetermined } = inspect(dir, "harness-extras");
        expect(facts.wiring).toBe("unknown");
        expect(undetermined.join("\n")).toMatch(/settings\.json/);
        expect(
          classifyPackInstallation(facts, [], "harness-extras", undetermined)
            .status,
        ).toBe("undetermined");
      },
    );

    it("is unknown with a note, and the pack never not-installed, when PreToolUse is only [null]", () => {
      const dir = bootstrap();
      editJson(dir, ".claude/settings.json", (settings) => {
        settings["hooks"] = { PreToolUse: [null] };
      });
      const { facts, undetermined } = inspect(dir, "harness-extras");
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.join("\n")).toMatch(/settings\.json/);
      expect(
        classifyPackInstallation(facts, [], "harness-extras", undetermined)
          .status,
      ).not.toBe("not-installed");
    });
  });
  describe("per-item wiring (scripts, verify steps, top-level keys)", () => {
    it("is partial when one of two package scripts is present and the verify step is gone", () => {
      const dir = bootstrap(["publishing"]);
      editJson(dir, "package.json", (pkg) => {
        Reflect.deleteProperty(
          pkg["scripts"] as Record<string, string>,
          "version:packages",
        );
      });
      writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[]\n");
      expect(inspect(dir, "publishing").facts.wiring).toBe("partial");
    });

    it("is partial when one of two verify steps is present", () => {
      const dir = bootstrap(["licensing"]);
      const base = loadPack("licensing");
      const twoSteps: Pack = {
        ...base,
        manifest: {
          ...base.manifest,
          wiring: {
            ...base.manifest.wiring,
            verifySteps: [
              ...base.manifest.wiring.verifySteps,
              {
                id: "second-gate",
                group: "lint",
                name: "Second gate",
                cmd: ["node", "second.mjs"],
              },
            ],
          },
        },
      };
      const undetermined: string[] = [];
      const facts = collectPackInstallFacts(
        dir,
        twoSteps,
        TOKENS,
        BOOTSTRAPPED,
        undetermined,
      );
      expect(facts.wiring).toBe("partial");
      expect(undetermined).toEqual([]);
    });

    it("treats a colliding verify step as absent with no note", () => {
      const dir = bootstrap();
      const real = loadPack("licensing").manifest.wiring.verifySteps[0];
      writeFileSync(
        join(dir, "bin/lib/verify-steps.packs.json"),
        JSON.stringify([{ ...real, cmd: ["something", "else"] }]),
      );
      const { facts, undetermined } = inspect(dir, "licensing");
      expect(facts.wiring).toBe("absent");
      expect(undetermined).toEqual([]);
    });

    it("treats a colliding statusLine as absent with no note", () => {
      const dir = bootstrap();
      editJson(dir, ".claude/settings.json", (settings) => {
        settings["statusLine"] = { type: "command", command: "mine.sh" };
      });
      const { facts, undetermined } = inspect(dir, "statusline");
      expect(facts.wiring).toBe("absent");
      expect(undetermined).toEqual([]);
    });

    it("is unknown with a note, never absent, when verify-steps.packs.json is [null]", () => {
      const dir = bootstrap();
      writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[null]");
      const { facts, undetermined } = inspect(dir, "licensing");
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.join("\n")).toMatch(/verify-steps\.packs\.json/);
      expect(
        classifyPackInstallation(facts, [], "licensing", undetermined).status,
      ).toBe("undetermined");
    });

    it("reports files present but wiring unknown as undetermined, not partial", () => {
      const dir = bootstrap(["publishing"]);
      writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "{ broken");
      const { facts, undetermined } = inspect(dir, "publishing");
      expect(facts.files.present.length).toBeGreaterThan(0);
      expect(facts.files.absent).toEqual([]);
      expect(
        classifyPackInstallation(facts, [], "publishing", undetermined).status,
      ).toBe("undetermined");
    });
  });

  describe("token-variant matching reads", () => {
    it("notes a token-bearing pack file replaced by a symlink and reports it modified", () => {
      const dir = bootstrap(["licensing"]);
      const file = join(dir, "REUSE.toml");
      write(root, "elsewhere/REUSE.toml", readFileSync(file, "utf8"));
      unlinkSync(file);
      symlinkSync(join(root, "elsewhere/REUSE.toml"), file);
      const undetermined: string[] = [];
      const { files } = collectPackInstallFacts(
        dir,
        loadPack("licensing"),
        { PROJECT_NAME: "other", YEAR: "1999" },
        BOOTSTRAPPED,
        undetermined,
      );
      expect(files.modified).toContain("REUSE.toml");
      expect(undetermined.join("\n")).toMatch(/REUSE\.toml/);
    });

    describe.skipIf(chmodIneffective)("an unreadable project file", () => {
      afterEach(() => {
        chmodSync(join(root, "project/REUSE.toml"), 0o644);
      });

      it("is reported modified with a note naming the path and errno", () => {
        const dir = bootstrap(["licensing"]);
        chmodSync(join(dir, "REUSE.toml"), 0o000);
        const undetermined: string[] = [];
        const { files } = collectPackInstallFacts(
          dir,
          loadPack("licensing"),
          { PROJECT_NAME: "other", YEAR: "1999" },
          BOOTSTRAPPED,
          undetermined,
        );
        expect(files.modified).toContain("REUSE.toml");
        expect(undetermined.join("\n")).toMatch(/REUSE\.toml.*EACCES/);
      });
    });
  });
});

describe("origin notes in inspectPackInstallations", () => {
  // statusline's files live under .claude/ and its wiring is not judged when
  // the origin is not bootstrapped, so a disturbed marker leaves it wholly
  // absent: only the origin note can keep it from not-installed.
  it("baseline: an untouched bootstrapped project reports statusline not-installed with no notes", () => {
    const dir = bootstrap();
    const report = inspectPackInstallations(dir, ["statusline"]);
    expect(report.packs[0]?.status.status).toBe("not-installed");
    expect(report.undetermined).toEqual([]);
  });

  it("notes a symlinked bootstrap marker and reports a wholly absent pack undetermined", () => {
    const dir = bootstrap();
    const marker = join(dir, "bin/verify.mjs");
    write(root, "elsewhere/verify.mjs", readFileSync(marker, "utf8"));
    unlinkSync(marker);
    symlinkSync(join(root, "elsewhere/verify.mjs"), marker);
    const report = inspectPackInstallations(dir, ["statusline"]);
    expect(report.undetermined.join("\n")).toMatch(/bin\/verify\.mjs/);
    expect(report.packs[0]?.status.status).toBe("undetermined");
  });

  it("reports a regular file named .groundwork as not a directory", () => {
    write(root, ".groundwork", VALID_INVENTORY);
    const origin = classifyProjectOrigin(root);
    expect(origin.evidence.join("\n")).toMatch(
      /\.groundwork is not a directory/,
    );
  });

  it("notes a symlinked .groundwork and reports a wholly absent pack undetermined", () => {
    const dir = bootstrap();
    write(root, "elsewhere/inventory.json", VALID_INVENTORY);
    symlinkSync(join(root, "elsewhere"), join(dir, ".groundwork"));
    const report = inspectPackInstallations(dir, ["statusline"]);
    expect(report.undetermined.join("\n")).toMatch(/\.groundwork/);
    expect(report.packs[0]?.status.status).toBe("undetermined");
  });

  describe.skipIf(chmodIneffective)(
    "an lstat/readdir failure that is not absence",
    () => {
      afterEach(() => {
        for (const rel of [
          "project/bin",
          "project/.groundwork",
          "project/.groundwork/inventory.json",
        ]) {
          try {
            chmodSync(join(root, rel), 0o755);
          } catch {
            // That directory was never created in this scenario.
          }
        }
      });

      it("notes an unreadable bootstrap marker (EACCES) and reports a wholly absent pack undetermined", () => {
        const dir = bootstrap();
        chmodSync(join(dir, "bin"), 0o000);
        const report = inspectPackInstallations(dir, ["statusline"]);
        expect(report.undetermined.join("\n")).toMatch(/EACCES/);
        expect(report.packs[0]?.status.status).toBe("undetermined");
      });

      it("notes an unreadable inventory.json and reports a wholly absent pack undetermined", () => {
        const dir = bootstrap();
        write(dir, ".groundwork/inventory.json", VALID_INVENTORY);
        chmodSync(join(dir, ".groundwork"), 0o000);
        const report = inspectPackInstallations(dir, ["statusline"]);
        expect(report.undetermined.join("\n")).toMatch(/EACCES/);
        expect(report.packs[0]?.status.status).toBe("undetermined");
      });

      it("notes an unreadable inventory.json file, does not claim adopted, and reports a wholly absent pack undetermined", () => {
        const dir = bootstrap();
        write(dir, ".groundwork/inventory.json", VALID_INVENTORY);
        chmodSync(join(dir, ".groundwork/inventory.json"), 0o000);
        const report = inspectPackInstallations(dir, ["statusline"]);
        expect(report.origin.kind).not.toBe("adopted");
        expect(report.undetermined.join("\n")).toMatch(
          /inventory\.json could not be read \(EACCES\)/,
        );
        expect(report.packs[0]?.status.status).toBe("undetermined");
      });

      it("notes an unlistable .groundwork directory and reports a wholly absent pack undetermined", () => {
        const dir = bootstrap();
        write(dir, ".groundwork/inventory.json", "{ not json");
        chmodSync(join(dir, ".groundwork"), 0o111);
        const report = inspectPackInstallations(dir, ["statusline"]);
        expect(report.undetermined.join("\n")).toMatch(
          /\.groundwork.*EACCES|EACCES.*\.groundwork/,
        );
        expect(report.packs[0]?.status.status).toBe("undetermined");
      });
    },
  );

  it("reports an adopted project that owns its own files at a pack's paths as partial, not installed", () => {
    write(root, ".groundwork/inventory.json", VALID_INVENTORY);
    write(root, "REUSE.toml", "version = 9\n# my own annotations\n");
    write(root, "bin/check-license-headers.mjs", "// my own gate\n");
    const report = inspectPackInstallations(root, ["licensing"]);
    expect(report.origin.kind).toBe("adopted");
    const verdict = report.packs[0]?.status;
    expect(verdict?.files.present).toEqual([]);
    expect(verdict?.files.modified.length).toBeGreaterThan(0);
    expect(verdict?.wiring).toBe("not-applicable");
    expect(verdict?.status).toBe("partial");
  });
});

describe("no reads through a symlinked ancestor directory", () => {
  /** Moves `rel` (a directory of the project) out and links it back in. */
  function relocateDir(dir: string, rel: string): void {
    const outside = join(root, "outside", rel);
    mkdirSync(join(outside, ".."), { recursive: true });
    renameSync(join(dir, rel), outside);
    symlinkSync(outside, join(dir, rel));
  }

  it("never reports a pack installed (ledger) from a ledger reached through a symlinked .groundwork", () => {
    const dir = bootstrap();
    write(
      root,
      "elsewhere/installed-packs.json",
      JSON.stringify({ schemaVersion: 1, packs: [{ name: "statusline" }] }),
    );
    symlinkSync(join(root, "elsewhere"), join(dir, ".groundwork"));
    const report = inspectPackInstallations(dir, ["statusline"]);
    const verdict = report.packs[0]?.status;
    expect(verdict?.status).not.toBe("installed");
    expect(verdict?.source).not.toBe("ledger");
    expect(report.undetermined.length).toBeGreaterThan(0);
    // The pack has no files and no wiring, so only the note can keep it
    // from not-installed.
    expect(verdict?.status).toBe("undetermined");
  });

  it("readInstalledPacksLedger skips a ledger behind a symlinked .groundwork whole, with a note", () => {
    write(
      root,
      "elsewhere/installed-packs.json",
      JSON.stringify({ schemaVersion: 1, packs: [{ name: "statusline" }] }),
    );
    symlinkSync(join(root, "elsewhere"), join(root, ".groundwork"));
    const ledger = readInstalledPacksLedger(root);
    expect(ledger.names).toEqual([]);
    expect(ledger.undetermined.join("\n")).toMatch(/symlinked directory/);
  });

  it("does not count a symlinked .claude/ toward bootstrapped, and notes it", () => {
    const dir = bootstrap();
    relocateDir(dir, ".claude");
    const report = inspectPackInstallations(dir, ["statusline"]);
    expect(report.origin.kind).not.toBe("bootstrapped");
    expect(report.undetermined.join("\n")).toMatch(/\.claude/);
    expect(report.packs[0]?.status.status).toBe("undetermined");
  });

  it("never judges wiring complete when settings.json is reached through a symlinked .claude/", () => {
    const dir = bootstrap(["harness-extras"]);
    relocateDir(dir, ".claude");
    const undetermined: string[] = [];
    const facts = collectPackInstallFacts(
      dir,
      loadPack("harness-extras"),
      TOKENS,
      BOOTSTRAPPED,
      undetermined,
    );
    expect(facts.wiring).toBe("unknown");
    expect(undetermined.join("\n")).toMatch(/symlinked directory/);
  });

  it.each(["bin", "bin/lib"])(
    "does not count markers behind a symlinked %s/ toward bootstrapped, and notes it",
    (rel) => {
      const dir = bootstrap();
      relocateDir(dir, rel);
      const report = inspectPackInstallations(dir, ["statusline"]);
      expect(report.origin.kind).not.toBe("bootstrapped");
      expect(report.undetermined.join("\n")).toMatch(/symlinked directory/);
      expect(report.packs[0]?.status.status).toBe("undetermined");
    },
  );

  it.each(["bin", "bin/lib"])(
    "never judges verify-step wiring complete through a symlinked %s/",
    (rel) => {
      const dir = bootstrap(["licensing"]);
      relocateDir(dir, rel);
      const undetermined: string[] = [];
      const facts = collectPackInstallFacts(
        dir,
        loadPack("licensing"),
        TOKENS,
        BOOTSTRAPPED,
        undetermined,
      );
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.join("\n")).toMatch(/symlinked directory/);
    },
  );
});

describe("malformed wiring shapes are unknown, never absent", () => {
  function inspect(
    dir: string,
    packName: string,
  ): { facts: PackInstallFacts; undetermined: string[] } {
    const undetermined: string[] = [];
    const facts = collectPackInstallFacts(
      dir,
      loadPack(packName),
      TOKENS,
      BOOTSTRAPPED,
      undetermined,
    );
    return { facts, undetermined };
  }

  function setScripts(dir: string, edit: (scripts: unknown) => unknown): void {
    const full = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(full, "utf8")) as Record<
      string,
      unknown
    >;
    pkg["scripts"] = edit(pkg["scripts"]);
    writeFileSync(full, JSON.stringify(pkg, null, 2));
  }

  it.each([
    ["an array", (): unknown => []],
    ["a number", (): unknown => 7],
    [
      "a record with a non-string script value",
      (s: unknown): unknown => ({
        ...(s as Record<string, unknown>),
        changeset: 5,
      }),
    ],
  ])("package.json scripts that is %s => unknown with a note", (_l, make) => {
    const dir = bootstrap(["publishing"]);
    setScripts(dir, make);
    const { facts, undetermined } = inspect(dir, "publishing");
    expect(facts.wiring).toBe("unknown");
    expect(undetermined.join("\n")).toMatch(/package\.json/);
    expect(
      classifyPackInstallation(facts, [], "publishing", undetermined).status,
    ).not.toBe("not-installed");
  });

  it.each([["[1]"], ["[{}]"]])(
    "verify-steps.packs.json = %s => unknown with a note",
    (content) => {
      const dir = bootstrap(["licensing"]);
      writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), content);
      const { facts, undetermined } = inspect(dir, "licensing");
      expect(facts.wiring).toBe("unknown");
      expect(undetermined.join("\n")).toMatch(/verify-steps\.packs\.json/);
      expect(
        classifyPackInstallation(facts, [], "licensing", undetermined).status,
      ).not.toBe("not-installed");
    },
  );

  it("a missing scripts key is plain absent, with no note", () => {
    const dir = bootstrap(["publishing"]);
    // JSON.stringify drops an undefined value, so the key is truly missing.
    setScripts(dir, () => undefined);
    writeFileSync(join(dir, "bin/lib/verify-steps.packs.json"), "[]\n");
    const { facts, undetermined } = inspect(dir, "publishing");
    expect(facts.wiring).toBe("absent");
    expect(undetermined).toEqual([]);
  });
});

describe("note path style", () => {
  it("uses paths relative to the target dir, never an absolute tmp path, in every note and evidence line", () => {
    const dir = bootstrap(["licensing"]);
    // Several simultaneous problems: a symlinked marker, a symlinked
    // token-bearing pack file, a malformed ledger and a broken settings.json.
    const marker = join(dir, "bin/verify.mjs");
    write(root, "elsewhere/verify.mjs", readFileSync(marker, "utf8"));
    unlinkSync(marker);
    symlinkSync(join(root, "elsewhere/verify.mjs"), marker);
    const reuse = join(dir, "REUSE.toml");
    write(root, "elsewhere/REUSE.toml", readFileSync(reuse, "utf8"));
    unlinkSync(reuse);
    symlinkSync(join(root, "elsewhere/REUSE.toml"), reuse);
    write(dir, ".groundwork/installed-packs.json", '{"schemaVersion":1}');
    writeFileSync(join(dir, ".claude/settings.json"), "{ broken");
    const report = inspectPackInstallations(dir);
    expect(report.undetermined.length).toBeGreaterThan(0);
    const all = [...report.undetermined, ...report.origin.evidence];
    for (const line of all) {
      expect(line).not.toContain(root);
    }
    expect(report.undetermined.join("\n")).toMatch(/bin\/verify\.mjs/);
  });

  describe.skipIf(chmodIneffective)("an unreadable .groundwork", () => {
    afterEach(() => {
      chmodSync(join(root, "project/.groundwork"), 0o755);
    });

    it("states the uncheckable inventory.json sentence once across evidence and notes", () => {
      const dir = bootstrap();
      write(dir, ".groundwork/inventory.json", VALID_INVENTORY);
      chmodSync(join(dir, ".groundwork"), 0o000);
      const report = inspectPackInstallations(dir, ["statusline"]);
      const sentences = [
        ...report.origin.evidence,
        ...report.undetermined,
      ].filter((line) => /inventory\.json.*EACCES/.test(line));
      expect(sentences).toHaveLength(1);
    });
  });
});

describe("classifyPackInstallation: the outdated flag", () => {
  const f: PackInstallFacts = {
    files: { present: ["a"], absent: [], modified: [] },
    wiring: "complete",
  };

  it("reports a ledger-listed pack as outdated from the ledger when the flag is set, keeping the facts", () => {
    expect(classifyPackInstallation(f, ["p"], "p", [], true)).toEqual({
      status: "outdated",
      source: "ledger",
      files: f.files,
      wiring: "complete",
    });
  });

  it("still reports a ledger-listed pack as installed without the flag, and with it false", () => {
    expect(classifyPackInstallation(f, ["p"], "p", []).status).toBe(
      "installed",
    );
    expect(classifyPackInstallation(f, ["p"], "p", [], false).status).toBe(
      "installed",
    );
  });

  it("never reports a detected (non-ledger) pack as outdated, whatever the flag", () => {
    const result = classifyPackInstallation(f, [], "p", [], true);
    expect(result).toMatchObject({ status: "installed", source: "detected" });
    const other = classifyPackInstallation(f, ["other"], "p", [], true);
    expect(other).toMatchObject({ status: "installed", source: "detected" });
  });
});

describe("PACK_STATUS_LABELS", () => {
  it("labels outdated as outdated and keeps the other labels", () => {
    expect(PACK_STATUS_LABELS).toEqual({
      installed: "installed",
      partial: "partial",
      "not-installed": "not installed",
      undetermined: "undetermined",
      outdated: "outdated",
    });
  });
});

describe("isPackOutdated", () => {
  const MANIFEST = "1".repeat(64);
  const F_A = "a".repeat(64);
  const F_B = "b".repeat(64);
  const F_C = "c".repeat(64);
  const current = {
    manifestSha256: MANIFEST,
    files: { "x.txt": F_A, "y.txt": F_B },
  };
  const history = (
    manifest: string,
    files: Record<string, string>,
  ): TemplateHistory => ({
    schemaVersion: 1,
    versions: {
      "1.4.0": { core: {}, packs: { quality: { manifest, files } } },
    },
    blobs: {},
  });
  const matching = history(MANIFEST, { "x.txt": F_A, "y.txt": F_B });
  const entry = (extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
    name: "quality",
    cliVersion: "1.4.0",
    ...extra,
  });
  const check = (
    e: LedgerEntry | undefined,
    h: TemplateHistory | undefined,
    running = "1.5.0",
    cur = current,
  ): boolean => isPackOutdated(e, cur, h, running);

  it("is false for a missing ledger entry", () => {
    expect(check(undefined, matching)).toBe(false);
  });

  it.each([
    ["equal to the running version", "1.5.0"],
    ["newer than the running version (a downgrade)", "1.6.0"],
    ["newer in major", "2.0.0"],
    ["newer in patch", "1.5.1"],
  ])(
    "is false when the ledger version is %s, even with a differing manifest",
    (_l, cliVersion) => {
      expect(
        check(entry({ cliVersion, manifestSha256: "0".repeat(64) }), undefined),
      ).toBe(false);
    },
  );

  it.each([["1.5.0-rc.1"], ["next"], ["unknown"], [""], ["1.4"], ["v1.4.0"]])(
    "is false when the ledger version %j is not a plain x.y.z, even with a differing manifest",
    (cliVersion) => {
      expect(
        check(entry({ cliVersion, manifestSha256: "0".repeat(64) }), undefined),
      ).toBe(false);
    },
  );

  it("is false when the ledger records no version", () => {
    expect(
      check({ name: "quality", manifestSha256: "0".repeat(64) }, undefined),
    ).toBe(false);
  });

  it("compares versions numerically, not as text (1.10.0 is newer than 1.9.0)", () => {
    const stale = entry({
      cliVersion: "1.10.0",
      manifestSha256: "0".repeat(64),
    });
    expect(check(stale, undefined, "1.9.0")).toBe(false);
    const older = entry({
      cliVersion: "1.9.0",
      manifestSha256: "0".repeat(64),
    });
    expect(check(older, undefined, "1.10.0")).toBe(true);
  });

  it("is true when the recorded manifest hash differs from the current one", () => {
    expect(check(entry({ manifestSha256: "0".repeat(64) }), undefined)).toBe(
      true,
    );
  });

  it("is false when the recorded manifest hash equals the current one and there is no history", () => {
    expect(check(entry({ manifestSha256: MANIFEST }), undefined)).toBe(false);
  });

  it("is false when everything recorded matches", () => {
    expect(check(entry({ manifestSha256: MANIFEST }), matching)).toBe(false);
  });

  it("is true when a current file's hash differs from the history's", () => {
    const h = history(MANIFEST, { "x.txt": F_C, "y.txt": F_B });
    expect(check(entry({ manifestSha256: MANIFEST }), h)).toBe(true);
  });

  it("is true when the current pack has a file the history's lacks", () => {
    const h = history(MANIFEST, { "x.txt": F_A });
    expect(check(entry({ manifestSha256: MANIFEST }), h)).toBe(true);
  });

  it("is true when the history's pack has a file the current one lacks", () => {
    const h = history(MANIFEST, { "x.txt": F_A, "y.txt": F_B, "z.txt": F_C });
    expect(check(entry({ manifestSha256: MANIFEST }), h)).toBe(true);
  });

  it("is true when the history's manifest hash differs from the current one", () => {
    // The manifest blob is present, so its canonical form's hash is compared.
    const blobText = '{"name":"quality","version":"0"}\n';
    const blobKey = createHash("sha256").update(blobText).digest("hex");
    const h: TemplateHistory = {
      ...history(blobKey, { "x.txt": F_A, "y.txt": F_B }),
      blobs: { [blobKey]: blobText },
    };
    expect(check(entry({ manifestSha256: MANIFEST }), h)).toBe(true);
  });

  it("decides by the history alone when the ledger has no manifestSha256", () => {
    expect(check(entry(), matching)).toBe(false);
    expect(
      check(entry(), history(MANIFEST, { "x.txt": F_C, "y.txt": F_B })),
    ).toBe(true);
  });

  it("is false when there is no manifestSha256 and no history", () => {
    expect(check(entry(), undefined)).toBe(false);
  });

  it("is false when the history lacks the ledger's version or the pack, and the manifest hash matches", () => {
    const e = entry({ cliVersion: "1.3.0", manifestSha256: MANIFEST });
    expect(check(e, matching)).toBe(false);
    const other: TemplateHistory = {
      schemaVersion: 1,
      versions: { "1.4.0": { core: {}, packs: {} } },
      blobs: {},
    };
    expect(check(entry({ manifestSha256: MANIFEST }), other)).toBe(false);
  });

  it("still flags a manifest-hash difference when the history lacks the version", () => {
    const e = entry({ cliVersion: "1.3.0", manifestSha256: "0".repeat(64) });
    expect(check(e, matching)).toBe(true);
  });
});

describe("inspectPackInstallations: outdated ledger entries (real packs)", () => {
  const LEDGER = ".groundwork/installed-packs.json";
  const manifestHash = (name: string): string =>
    createHash("sha256")
      .update(JSON.stringify(loadPack(name).manifest, null, 2) + "\n")
      .digest("hex");
  const ledgerOf = (entry: Record<string, unknown>): string =>
    JSON.stringify({ schemaVersion: 1, packs: [entry] });

  it("reports a ledger pack outdated when its recorded manifest hash differs and its version is older", () => {
    const dir = bootstrap();
    write(
      dir,
      LEDGER,
      ledgerOf({
        name: "statusline",
        cliVersion: "0.0.1",
        manifestSha256: "0".repeat(64),
      }),
    );
    const [pack] = inspectPackInstallations(dir, ["statusline"]).packs;
    expect(pack?.status).toMatchObject({
      status: "outdated",
      source: "ledger",
    });
  });

  it("reports installed when the recorded manifest hash is the one the staging would write", () => {
    const dir = bootstrap();
    write(
      dir,
      LEDGER,
      ledgerOf({
        name: "statusline",
        cliVersion: "0.0.1",
        manifestSha256: manifestHash("statusline"),
      }),
    );
    const [pack] = inspectPackInstallations(dir, ["statusline"]).packs;
    expect(pack?.status.status).toBe("installed");
  });

  it("never reports outdated for a ledger version equal to the running version", () => {
    const dir = bootstrap();
    write(
      dir,
      LEDGER,
      ledgerOf({
        name: "statusline",
        cliVersion: resolveCliVersion(),
        manifestSha256: "0".repeat(64),
      }),
    );
    const [pack] = inspectPackInstallations(dir, ["statusline"]).packs;
    expect(pack?.status.status).toBe("installed");
  });

  it("reports an entry without version or hash as installed, as before", () => {
    const dir = bootstrap();
    write(dir, LEDGER, ledgerOf({ name: "statusline" }));
    const [pack] = inspectPackInstallations(dir, ["statusline"]).packs;
    expect(pack?.status.status).toBe("installed");
  });
});

/** The files of a real pack as the running checkout ships them: project path to sha256. */
function realPackFiles(name: string): Record<string, string> {
  const filesDir = loadPack(name).filesDir;
  const out: Record<string, string> = {};
  for (const entry of readdirSync(filesDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = full
      .slice(filesDir.length + 1)
      .split("\\")
      .join("/");
    out[restoreDotfilePath(rel)] = createHash("sha256")
      .update(readFileSync(full))
      .digest("hex");
  }
  return out;
}

describe("isPackOutdated: a missing manifest blob", () => {
  const MANIFEST = "1".repeat(64);
  const OTHER = "2".repeat(64);
  const F_A = "a".repeat(64);
  const files = { "x.txt": F_A };
  const historyWithoutBlob: TemplateHistory = {
    schemaVersion: 1,
    versions: {
      "1.4.0": { core: {}, packs: { quality: { manifest: OTHER, files } } },
    },
    blobs: {},
  };
  const entry: LedgerEntry = { name: "quality", cliVersion: "1.4.0" };

  it("gives no verdict from the manifest comparison (not outdated when the files agree)", () => {
    expect(
      isPackOutdated(
        entry,
        { manifestSha256: MANIFEST, files },
        historyWithoutBlob,
        "1.5.0",
      ),
    ).toBe(false);
  });

  it("still applies the file-hash comparison", () => {
    expect(
      isPackOutdated(
        entry,
        { manifestSha256: MANIFEST, files: { "x.txt": "b".repeat(64) } },
        historyWithoutBlob,
        "1.5.0",
      ),
    ).toBe(true);
  });
});

describe("readInstalledPacksLedger: manifestSha256 trust boundary", () => {
  const LEDGER = ".groundwork/installed-packs.json";
  const GOOD = "ab".repeat(32);

  it.each([
    ["uppercase hex", GOOD.toUpperCase()],
    ["the staging placeholder", "<sha256 of pack.json.staged>"],
    ["truncated", GOOD.slice(0, 63)],
    ["too long", `${GOOD}0`],
    ["a number", 5],
    ["null", null],
  ])("drops %s but keeps the entry and its name", (_label, bad) => {
    write(
      root,
      LEDGER,
      JSON.stringify({
        schemaVersion: 1,
        packs: [{ name: "quality", cliVersion: "1.4.0", manifestSha256: bad }],
      }),
    );
    expect(readInstalledPacksLedger(root)).toEqual({
      names: ["quality"],
      entries: [{ name: "quality", cliVersion: "1.4.0" }],
      undetermined: [],
    });
  });

  it("keeps a lowercase 64-hex hash", () => {
    write(
      root,
      LEDGER,
      JSON.stringify({
        schemaVersion: 1,
        packs: [{ name: "quality", manifestSha256: GOOD }],
      }),
    );
    expect(readInstalledPacksLedger(root).entries).toEqual([
      { name: "quality", manifestSha256: GOOD },
    ]);
  });
});

describe("inspectPackInstallations: injected history and running version", () => {
  const LEDGER = ".groundwork/installed-packs.json";
  const EMPTY: TemplateHistory = { schemaVersion: 1, versions: {}, blobs: {} };
  const manifestHash = (name: string): string =>
    createHash("sha256")
      .update(JSON.stringify(loadPack(name).manifest, null, 2) + "\n")
      .digest("hex");
  const ledgerOf = (...entries: Record<string, unknown>[]): string =>
    JSON.stringify({ schemaVersion: 1, packs: entries });
  const sha = (text: string): string =>
    createHash("sha256").update(text).digest("hex");
  const currentFiles = realPackFiles;
  const notesFor = (notes: readonly string[], ...needles: string[]): string[] =>
    notes.filter((note) => needles.every((needle) => note.includes(needle)));

  it("reports the injected note in undetermined and keeps the verdict installed", () => {
    const dir = bootstrap();
    write(dir, LEDGER, ledgerOf({ name: "statusline", cliVersion: "1.0.0" }));
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { note: "HISTORY-GONE-NOTE" },
      runningVersion: "1.5.0",
    });
    expect(report.undetermined).toContain("HISTORY-GONE-NOTE");
    expect(report.packs[0]?.status.status).toBe("installed");
  });

  it("reports outdated from an injected history recording an older version whose files differ", () => {
    const dir = bootstrap();
    write(dir, LEDGER, ledgerOf({ name: "statusline", cliVersion: "1.2.3" }));
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.2.3": {
          core: {},
          packs: {
            statusline: {
              manifest: manifestHash("statusline"),
              files: { "no-such-file.txt": "a".repeat(64) },
            },
          },
        },
      },
      blobs: {},
    };
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { history },
      runningVersion: "1.5.0",
    });
    expect(report.packs[0]?.status.status).toBe("outdated");
  });

  it("drops a malformed ledger manifestSha256 instead of calling the pack outdated", () => {
    const dir = bootstrap();
    write(
      dir,
      LEDGER,
      ledgerOf({
        name: "statusline",
        cliVersion: "1.0.0",
        manifestSha256: "<sha256 of pack.json.staged>",
      }),
    );
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { history: EMPTY },
      runningVersion: "1.5.0",
    });
    expect(report.packs[0]?.status.status).toBe("installed");
  });

  it("notes a ledger cliVersion that is not a plain x.y.z, naming the pack and version", () => {
    const dir = bootstrap();
    write(
      dir,
      LEDGER,
      ledgerOf({ name: "statusline", cliVersion: "1.0.0-rc.8" }),
    );
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { history: EMPTY },
      runningVersion: "1.5.0",
    });
    expect(
      notesFor(report.undetermined, "statusline", "1.0.0-rc.8"),
    ).toHaveLength(1);
    expect(report.packs[0]?.status.status).toBe("installed");
  });

  it("notes a ledger cliVersion the loaded history does not record", () => {
    const dir = bootstrap();
    write(dir, LEDGER, ledgerOf({ name: "statusline", cliVersion: "1.2.3" }));
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { history: EMPTY },
      runningVersion: "1.5.0",
    });
    expect(notesFor(report.undetermined, "statusline", "1.2.3")).toHaveLength(
      1,
    );
    expect(report.packs[0]?.status.status).toBe("installed");
  });

  it("emits one note, not one per pack, when the running version is unknown", () => {
    const dir = bootstrap();
    write(
      dir,
      LEDGER,
      ledgerOf(
        { name: "statusline", cliVersion: "1.2.3" },
        { name: "quality", cliVersion: "1.2.3" },
      ),
    );
    const report = inspectPackInstallations(dir, ["statusline", "quality"], {
      history: { history: EMPTY },
      runningVersion: "unknown",
    });
    expect(notesFor(report.undetermined, "unknown")).toHaveLength(1);
  });

  it.each([
    ["equal to", "1.5.0"],
    ["newer than", "1.6.0"],
  ])(
    "adds no note when the ledger version is %s the running version",
    (_label, cliVersion) => {
      const dir = bootstrap();
      write(dir, LEDGER, ledgerOf({ name: "statusline", cliVersion }));
      const report = inspectPackInstallations(dir, ["statusline"], {
        history: { history: EMPTY },
        runningVersion: "1.5.0",
      });
      expect(notesFor(report.undetermined, "statusline")).toEqual([]);
      expect(notesFor(report.undetermined, cliVersion)).toEqual([]);
    },
  );

  it("adds no note for a pack without a ledger entry, even with an unknown running version", () => {
    const dir = bootstrap();
    write(dir, LEDGER, ledgerOf({ name: "quality", cliVersion: "1.0.0-rc.8" }));
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { history: EMPTY },
      runningVersion: "unknown",
    });
    expect(notesFor(report.undetermined, "statusline")).toEqual([]);
  });

  it("notes an unparsable stored manifest blob, naming the pack, and is not outdated", () => {
    const dir = bootstrap();
    write(dir, LEDGER, ledgerOf({ name: "statusline", cliVersion: "1.2.3" }));
    const blob = "this is not json";
    const history: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.2.3": {
          core: {},
          packs: {
            statusline: {
              manifest: sha(blob),
              files: currentFiles("statusline"),
            },
          },
        },
      },
      blobs: { [sha(blob)]: blob },
    };
    const report = inspectPackInstallations(dir, ["statusline"], {
      history: { history },
      runningVersion: "1.5.0",
    });
    expect(notesFor(report.undetermined, "statusline")).not.toEqual([]);
    expect(report.packs[0]?.status.status).toBe("installed");
  });
});

describe("inspectPackInstallations: the real committed history", () => {
  const LEDGER = ".groundwork/installed-packs.json";
  const sha = (data: string | Buffer): string =>
    createHash("sha256").update(data).digest("hex");

  it("reports every pack unchanged since the newest recorded release as installed, never outdated", () => {
    const loaded = loadTemplateHistory();
    if (!("history" in loaded)) throw new Error(loaded.note);
    const { history } = loaded;
    const newest = Object.keys(history.versions).sort((a, b) => {
      const left = a.split(".").map(Number);
      const right = b.split(".").map(Number);
      return (
        (left[0] ?? 0) - (right[0] ?? 0) ||
        (left[1] ?? 0) - (right[1] ?? 0) ||
        (left[2] ?? 0) - (right[2] ?? 0)
      );
    })[Object.keys(history.versions).length - 1] as string;
    const [major, minor, patch] = newest.split(".").map(Number);
    const running = `${String(major)}.${String(minor)}.${String((patch ?? 0) + 1)}`;

    const unchanged = listPackNames().filter((name) => {
      const recorded = history.versions[newest]?.packs[name];
      if (recorded === undefined) return false;
      const blob = history.blobs[recorded.manifest];
      if (blob === undefined) return false;
      const manifest = sha(`${JSON.stringify(JSON.parse(blob), null, 2)}\n`);
      const current = sha(
        `${JSON.stringify(loadPack(name).manifest, null, 2)}\n`,
      );
      if (manifest !== current) return false;
      const files = realPackFiles(name);
      return (
        JSON.stringify(Object.entries(files).sort()) ===
        JSON.stringify(Object.entries(recorded.files).sort())
      );
    });
    expect(unchanged.length).toBeGreaterThan(0);

    for (const name of unchanged) {
      const dir = join(root, `project-${name}`);
      write(
        dir,
        LEDGER,
        JSON.stringify({
          schemaVersion: 1,
          packs: [{ name, cliVersion: newest }],
        }),
      );
      const report = inspectPackInstallations(dir, [name], {
        history: loaded,
        runningVersion: running,
      });
      expect(report.packs[0]?.status.status, name).toBe("installed");
    }
  });
});

describe("classifyProjectOrigin with the fresh-mode record", () => {
  it("keeps a bootstrapped project bootstrapped when .groundwork/ holds only the lock, base/ and the ledger", () => {
    const dir = bootstrap(["quality"]);
    write(dir, ".groundwork/groundwork.lock.json", "{}\n");
    write(dir, ".groundwork/base/package.json.base", "{}\n");
    write(dir, ".groundwork/installed-packs.json", "{}\n");
    const origin = classifyProjectOrigin(dir);
    expect(origin.kind).toBe("bootstrapped");
    expect(origin.evidence.length).toBeGreaterThan(0);
  });
});
