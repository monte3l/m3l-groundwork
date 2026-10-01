// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
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
} from "../src/packs.js";
import type { PackManifest } from "../src/packs.js";
import { stagePacks } from "../src/pack-stage.js";
import { walkBounded } from "../src/survey/fs-walk.js";
import { countPackBudget } from "../src/caps.js";

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

/**
 * Writes `pack.json` from exactly the given raw object, with no defaults
 * injected -- unlike {@link writeManifest} (typed `Partial<PackManifest>`,
 * always spread over a fully valid base), this lets a test construct a
 * manifest missing an entire required key (e.g. `wiring` missing one or
 * more of its own required sub-keys) that `Partial<PackManifest>` can't
 * express. Also creates the pack's empty `files/` directory, matching
 * `writeManifest`'s side effect.
 */
function writeRawManifest(
  packsRoot: string,
  name: string,
  overrides: Record<string, unknown>,
): void {
  const packDir = join(packsRoot, name);
  mkdirSync(join(packDir, "files"), { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(overrides));
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

  it("throws when the manifest's own name field contains a path-traversal segment, even though the directory name (the call argument) is safe", () => {
    // packDir is built from the CALL argument ("safe-dir"), not from
    // manifest.name -- so this manifest loads successfully today with no
    // validation at all of the internal name field, even though that field
    // is later used to build a filesystem path in pack-stage.ts's
    // stagePacks (which re-validates it independently via
    // assertSingleSegmentName).
    writeManifest(packsRoot, "safe-dir", { name: "../escape" });
    expect(() => loadPack("safe-dir", packsRoot)).toThrow(/pack name/i);
  });

  it("throws when the manifest's own name field doesn't match the directory it was loaded from", () => {
    // packDir is resolved from the CALL argument ("real-dir"). manifest.name
    // ("different-name") is shape-valid (passes PACK_NAME_PATTERN) but never
    // cross-checked against the directory it lives in -- so two pack
    // directories could declare the same internal name while living at
    // different paths, and pack-stage.ts's stagePacks/installPack key their
    // staging path and rmSync cleanup on manifest.name alone. This must be a DIFFERENT
    // failure than the shape-only check above (which fires on a malformed
    // name, not a mismatched one), so assert on both names appearing in the
    // message rather than just /pack name/i.
    writeManifest(packsRoot, "real-dir", { name: "different-name" });
    expect(() => loadPack("real-dir", packsRoot)).toThrow(/name/i);
    expect(() => loadPack("real-dir", packsRoot)).toThrow(
      /real-dir.*different-name|different-name.*real-dir/,
    );
  });

  it("throws when pack.json's budget is missing a required CapCounts key", () => {
    // Written as a raw object literal (not through writeManifest/PackManifest)
    // specifically to omit the `scripts` key entirely -- a malformed budget
    // shape that would otherwise silently propagate into report.ts's
    // sumPackBudgets arithmetic as `undefined`, poisoning the sum to NaN.
    const packDir = join(packsRoot, "budget-missing-key");
    mkdirSync(join(packDir, "files"), { recursive: true });
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "budget-missing-key",
        description: "a test pack with an incomplete budget",
        modes: ["fresh", "adopt"],
        budget: { agents: 1, skills: 0, hooks: 0, workflows: 0 },
        wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      }),
    );
    expect(() => loadPack("budget-missing-key", packsRoot)).toThrow(/budget/i);
  });

  test.each([
    [
      "a negative number",
      { agents: 1, skills: 0, hooks: 0, workflows: 0, scripts: -1 },
    ],
    [
      "a non-numeric value",
      { agents: 1, skills: 0, hooks: 0, workflows: 0, scripts: "zero" },
    ],
  ])(
    "throws when pack.json's budget has %s for a CapCounts field",
    (_label, budget) => {
      const dirName = `budget-invalid-${String(_label).replace(/\s+/g, "-")}`;
      const packDir = join(packsRoot, dirName);
      mkdirSync(join(packDir, "files"), { recursive: true });
      writeFileSync(
        join(packDir, "pack.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: dirName,
          description: "a test pack with an invalid budget field",
          modes: ["fresh", "adopt"],
          budget,
          wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
        }),
      );
      expect(() => loadPack(dirName, packsRoot)).toThrow(/budget/i);
    },
  );

  it("throws when pack.json has no modes array at all", () => {
    const packDir = join(packsRoot, "no-modes");
    mkdirSync(join(packDir, "files"), { recursive: true });
    // Written as a raw object literal (not through writeManifest/PackManifest)
    // specifically to omit the `modes` key entirely, rather than setting it
    // to undefined against a typed field.
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "no-modes",
        description: "a test pack with no modes key",
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      }),
    );
    expect(() => loadPack("no-modes", packsRoot)).toThrow(/modes/i);
  });
});

describe("loadPack hardened validation", () => {
  let packsRoot: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-hardening-root-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
  });

  it("throws naming the bad value when modes contains something other than fresh/adopt", () => {
    writeManifest(packsRoot, "typo-mode", { modes: ["fresh", "adpot"] });
    expect(() => loadPack("typo-mode", packsRoot)).toThrow(/adpot/);
  });

  it("throws when wiring.settings is present but not an object", () => {
    const packDir = join(packsRoot, "settings-not-object");
    mkdirSync(join(packDir, "files"), { recursive: true });
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "settings-not-object",
        description: "a test pack",
        modes: ["fresh", "adopt"],
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        wiring: { settings: "nope", packageScripts: {}, verifySteps: [] },
      }),
    );
    expect(() => loadPack("settings-not-object", packsRoot)).toThrow(
      /wiring\.settings/,
    );
  });

  it("throws when wiring.packageScripts is present but not an object", () => {
    const packDir = join(packsRoot, "scripts-not-object");
    mkdirSync(join(packDir, "files"), { recursive: true });
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "scripts-not-object",
        description: "a test pack",
        modes: ["fresh", "adopt"],
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        wiring: { settings: {}, packageScripts: ["nope"], verifySteps: [] },
      }),
    );
    expect(() => loadPack("scripts-not-object", packsRoot)).toThrow(
      /wiring\.packageScripts/,
    );
  });

  it("throws when wiring.verifySteps is present but not an array", () => {
    const packDir = join(packsRoot, "steps-not-array");
    mkdirSync(join(packDir, "files"), { recursive: true });
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "steps-not-array",
        description: "a test pack",
        modes: ["fresh", "adopt"],
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        wiring: { settings: {}, packageScripts: {}, verifySteps: {} },
      }),
    );
    expect(() => loadPack("steps-not-array", packsRoot)).toThrow(
      /wiring\.verifySteps/,
    );
  });

  it("throws naming the bad group when a verifySteps[] entry's group isn't format/lint/typecheck/build/test", () => {
    const packDir = join(packsRoot, "bad-group");
    mkdirSync(join(packDir, "files"), { recursive: true });
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "bad-group",
        description: "a test pack",
        modes: ["fresh", "adopt"],
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        wiring: {
          settings: {},
          packageScripts: {},
          verifySteps: [
            {
              id: "x",
              group: "verify-everything",
              name: "X",
              cmd: ["node", "x.mjs"],
            },
          ],
        },
      }),
    );
    expect(() => loadPack("bad-group", packsRoot)).toThrow(/verify-everything/);
  });

  it("loads successfully when modes, wiring.settings, wiring.packageScripts and wiring.verifySteps are all well-formed", () => {
    writeManifest(packsRoot, "well-formed", {
      modes: ["fresh", "adopt"],
      wiring: {
        settings: {},
        packageScripts: { build: "tsc" },
        verifySteps: [
          { id: "y", group: "build", name: "Y", cmd: ["node", "y.mjs"] },
        ],
      },
    });
    const pack = loadPack("well-formed", packsRoot);
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.wiring.packageScripts).toEqual({ build: "tsc" });
    expect(pack.manifest.wiring.verifySteps).toEqual([
      { id: "y", group: "build", name: "Y", cmd: ["node", "y.mjs"] },
    ]);
  });
});

describe("loadPack hardened validation -- missing wiring keys", () => {
  let packsRoot: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-missing-wiring-root-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
  });

  test.each([
    [
      "settings, packageScripts and verifySteps all missing",
      {},
      /wiring\.settings/,
    ],
    [
      "packageScripts and verifySteps missing",
      { settings: {} },
      /wiring\.packageScripts/,
    ],
    [
      "verifySteps missing",
      { settings: {}, packageScripts: {} },
      /wiring\.verifySteps/,
    ],
  ] satisfies Array<[string, Record<string, unknown>, RegExp]>)(
    "throws naming the missing key when wiring is missing: %s",
    (label, wiringOverride, expectedKey) => {
      const dirName = `missing-wiring-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      writeRawManifest(packsRoot, dirName, {
        schemaVersion: 1,
        name: dirName,
        description: "a test pack with an incomplete wiring block",
        modes: ["fresh", "adopt"],
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        wiring: wiringOverride,
      });
      expect(() => loadPack(dirName, packsRoot)).toThrow(expectedKey);
    },
  );
});

describe("loadPack hardened validation -- malformed verifySteps entries", () => {
  let packsRoot: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-bad-steps-root-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
  });

  function writeStepsManifest(name: string, verifySteps: unknown[]): void {
    writeRawManifest(packsRoot, name, {
      schemaVersion: 1,
      name,
      description: "a test pack with a malformed verifySteps entry",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      wiring: {
        settings: {},
        packageScripts: {},
        verifySteps,
      },
    });
  }

  it("throws naming the entry's index when cmd is not an array and id/name are absent", () => {
    writeStepsManifest("step-missing-fields", [
      { group: "lint", cmd: "node x.mjs" },
    ]);
    expect(() => loadPack("step-missing-fields", packsRoot)).toThrow(
      /verifySteps\[0\]/,
    );
  });

  it("throws naming the entry's index when id and name are present but not strings", () => {
    writeStepsManifest("step-non-string-fields", [
      { id: 123, group: "lint", name: 456, cmd: ["node", "x.mjs"] },
    ]);
    expect(() => loadPack("step-non-string-fields", packsRoot)).toThrow(
      /verifySteps\[0\]/,
    );
  });

  it("throws naming the entry's index when cmd is an empty array", () => {
    writeStepsManifest("step-empty-cmd", [
      { id: "x", group: "lint", name: "X", cmd: [] },
    ]);
    expect(() => loadPack("step-empty-cmd", packsRoot)).toThrow(
      /verifySteps\[0\]/,
    );
  });

  it("throws naming the entry's index when cmd contains a non-string element", () => {
    writeStepsManifest("step-non-string-cmd-element", [
      { id: "x", group: "lint", name: "X", cmd: ["node", 123] },
    ]);
    expect(() => loadPack("step-non-string-cmd-element", packsRoot)).toThrow(
      /verifySteps\[0\]/,
    );
  });

  it("names the second entry's index (1), not the first, when only the second entry is malformed", () => {
    writeStepsManifest("step-second-entry-bad", [
      { id: "ok", group: "lint", name: "OK", cmd: ["node", "ok.mjs"] },
      { group: "lint", cmd: "node x.mjs" },
    ]);
    expect(() => loadPack("step-second-entry-bad", packsRoot)).toThrow(
      /verifySteps\[1\]/,
    );
  });

  test.each([
    ["a bare string", ["not-an-object"]],
    ["null", [null]],
  ] satisfies Array<[string, unknown[]]>)(
    "throws naming the entry itself as not an object when a verifySteps[] entry is %s",
    (_label, verifySteps) => {
      writeStepsManifest("step-not-an-object", verifySteps);
      expect(() => loadPack("step-not-an-object", packsRoot)).toThrow(
        /verifySteps\[0\].*must be an object/i,
      );
    },
  );
});

describe("loadPack hardened validation -- non-object pack.json", () => {
  let packsRoot: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-non-object-manifest-root-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
  });

  it("throws a named error rather than an unrelated TypeError when pack.json parses to a non-object JSON value", () => {
    const packDir = join(packsRoot, "null-manifest");
    mkdirSync(join(packDir, "files"), { recursive: true });
    writeFileSync(join(packDir, "pack.json"), "null");
    expect(() => loadPack("null-manifest", packsRoot)).toThrow(
      /pack\.json must be an object/,
    );
  });
});

describe("loadPack wiring-key prototype guard (#97)", () => {
  let packsRoot: string;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-wiring-keys-root-"));
  });

  afterEach(() => {
    rmSync(packsRoot, { recursive: true, force: true });
  });

  /**
   * Builds an object whose OWN key is literally `key`, via JSON.parse rather
   * than object-literal syntax -- same rationale as merge-json.test.ts's own
   * identically-named helper: `{ __proto__: value }` and
   * `obj["__proto__"] = value` both invoke the Annex B exotic setter instead
   * of creating a data property, which would make a test built on either
   * form vacuous (the manifest reader would never see the key as an own
   * key at all). JSON.parse -- like the real pack.json text loadPack reads
   * -- creates a genuine own, enumerable data property even when named
   * "__proto__".
   */
  function buildOwnKeyFragment<T>(key: string, value: T): Record<string, T> {
    return JSON.parse(`{"${key}":${JSON.stringify(value)}}`) as Record<
      string,
      T
    >;
  }

  const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"] as const;
  const WIRING_FIELDS = [
    "settings",
    "settingsTopLevel",
    "packageScripts",
  ] as const;

  /** Builds the one fragment-shaped value each wiring field actually holds: an array of hook entries for `settings`, a single settings value for `settingsTopLevel`, a command string for `packageScripts`. */
  function fragmentFor(field: string, key: string): Record<string, unknown> {
    if (field === "settings") {
      return buildOwnKeyFragment(key, [
        { hooks: [{ type: "command", command: "node malicious.mjs" }] },
      ]);
    }
    if (field === "settingsTopLevel") {
      return buildOwnKeyFragment(key, {
        type: "command",
        command: "node malicious.mjs",
      });
    }
    return buildOwnKeyFragment(key, "node malicious.mjs");
  }

  test.each(
    WIRING_FIELDS.flatMap((field) =>
      DANGEROUS_KEYS.map((key) => [field, key] as [string, string]),
    ),
  )('throws naming the pack, "wiring.%s" and the key "%s"', (field, key) => {
    // PACK_NAME_PATTERN requires a bare lowercase identifier -- lowercase
    // the field segment (e.g. "settingsTopLevel" -> "settingstoplevel") so
    // this fixture fails on the wiring-key guard under test, never on the
    // unrelated pack-name-shape check that runs earlier in loadPack.
    const dirName = `proto-${field.toLowerCase()}-${key.replace(/[^a-z]/gi, "")}`;
    writeRawManifest(packsRoot, dirName, {
      schemaVersion: 1,
      name: dirName,
      description: "a test pack with a prototype-sensitive wiring key",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      wiring: {
        settings: {},
        packageScripts: {},
        verifySteps: [],
        [field]: fragmentFor(field, key),
      },
    });

    let thrown: unknown;
    try {
      loadPack(dirName, packsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // The full exact message, not a substring: `dirName` and `key` share
    // characters ("proto-settings-constructor" already contains
    // "constructor"), so toContain(key) would pass even if the thrown
    // message named the WRONG key -- and "wiring.settings" is itself a
    // substring of "wiring.settingsTopLevel", so toContain("wiring.settings")
    // would pass even if the implementation always reported
    // "settingsTopLevel" regardless of which field was actually checked.
    // Pinning the whole string is what makes field and key independently
    // load-bearing.
    expect((thrown as Error).message).toBe(
      `pack "${dirName}": pack.json's wiring.${field} must not use the prototype-sensitive key ${JSON.stringify(key)}`,
    );
  });

  it("still loads a valid pack whose wiring has no prototype-sensitive keys, with settingsTopLevel present", () => {
    writeManifest(packsRoot, "control-with-top-level", {
      wiring: {
        settings: {},
        settingsTopLevel: {
          statusLine: { type: "command", command: "s.mjs" },
        },
        packageScripts: { build: "tsc" },
        verifySteps: [],
      },
    });
    expect(() => loadPack("control-with-top-level", packsRoot)).not.toThrow();
  });

  it("still loads a valid pack whose wiring omits settingsTopLevel entirely", () => {
    writeManifest(packsRoot, "control-no-top-level");
    const pack = loadPack("control-no-top-level", packsRoot);
    expect(pack.manifest.wiring.settingsTopLevel).toBeUndefined();
  });

  it("does not reject a prototype-sensitive name that appears only as a nested VALUE, never as an own key of settings/settingsTopLevel/packageScripts themselves", () => {
    writeRawManifest(packsRoot, "proto-value-not-key", {
      schemaVersion: 1,
      name: "proto-value-not-key",
      description: "a test pack with a prototype-sensitive name in a VALUE",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      wiring: {
        settings: {
          // The event NAME ("PreToolUse") is the only key loadPack's guard
          // enumerates here -- it is safe. The nested "meta" field's own
          // key "__proto__" is a hook entry's VALUE, never read as a key.
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "node x.mjs",
                  meta: buildOwnKeyFragment("__proto__", "nested-value"),
                },
              ],
            },
          ],
        },
        settingsTopLevel: {
          // Likewise "statusLine" is the only top-level key enumerated;
          // "constructor" here is nested inside its VALUE.
          statusLine: {
            type: "command",
            command: "s.mjs",
            meta: buildOwnKeyFragment("constructor", "nested-value"),
          },
        },
        // The script's NAME is "build" (safe); its VALUE merely contains the
        // dangerous names as ordinary text, never as a key.
        packageScripts: { build: "echo __proto__ constructor prototype" },
        verifySteps: [],
      },
    });

    expect(() => loadPack("proto-value-not-key", packsRoot)).not.toThrow();
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
  it("loads cleanly from the real templates/packs directory, no longer wires any verify step after the quality-pack split, and keeps the folded-in statusline top-level keys", () => {
    const names = listPackNames();
    expect(names).toContain("harness-extras");
    const pack = loadPack("harness-extras");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(existsSync(pack.filesDir)).toBe(true);
    // packsRootDir()'s default resolves to the real templates/packs tree.
    expect(pack.filesDir.startsWith(realPacksRoot)).toBe(true);

    expect(pack.manifest.budget).toEqual({
      agents: 0,
      skills: 0,
      hooks: 6,
      workflows: 0,
      scripts: 0,
    });
    expect(pack.manifest.requires?.paths).toEqual(["bin/lib/agent-roster.mjs"]);

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
    // The file-budget gate and its bin/lib/report.mjs requirement moved to
    // the new quality pack -- harness-extras wires no verify step at all.
    expect(pack.manifest.wiring.verifySteps).toEqual([]);
  });

  it("no longer ships the type-design-analyzer agent or the file-budget gate -- both moved to the quality pack", () => {
    const pack = loadPack("harness-extras");
    expect(
      existsSync(
        join(pack.filesDir, ".claude", "agents", "type-design-analyzer.md"),
      ),
    ).toBe(false);
    expect(
      existsSync(join(pack.filesDir, "bin", "check-file-budget.mjs")),
    ).toBe(false);
    expect(
      existsSync(join(pack.filesDir, "bin", "file-budget-baseline.json")),
    ).toBe(false);
  });

  it("installs alone: settings.json gains $schema, hooks (all three events) and both statusline top-level keys, with no agent and no gate wired", () => {
    const targetDir = mkdtempSync(
      join(tmpdir(), "packs-harness-extras-alone-"),
    );
    try {
      mkdirSync(join(targetDir, ".claude"), { recursive: true });
      mkdirSync(join(targetDir, "bin", "lib"), { recursive: true });
      writeFileSync(join(targetDir, "bin", "lib", "agent-roster.mjs"), "");
      writeFileSync(
        join(targetDir, ".claude", "settings.json"),
        JSON.stringify({ $schema: "s", hooks: {} }),
      );
      installPack(loadPack("harness-extras"), targetDir, {});
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
      expect(existsSync(join(targetDir, ".claude", "agents"))).toBe(false);
      expect(
        existsSync(join(targetDir, "bin", "lib", "verify-steps.packs.json")),
      ).toBe(false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("the real quality pack", () => {
  it("loads cleanly, is fresh+adopt capable, requires bin/lib/report.mjs, and wires exactly the file-budget verify step in the build group", () => {
    expect(listPackNames()).toContain("quality");
    const pack = loadPack("quality");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.requires?.paths).toEqual(["bin/lib/report.mjs"]);
    expect(pack.manifest.wiring.settings).toEqual({});
    expect(pack.manifest.wiring.settingsTopLevel).toBeUndefined();
    expect(pack.manifest.wiring.packageScripts).toEqual({});
    const steps = pack.manifest.wiring.verifySteps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      id: "file-budget",
      group: "build",
      name: "Check file budget",
      cmd: ["node", "bin/check-file-budget.mjs"],
    });
    expect(existsSync(pack.filesDir)).toBe(true);
    expect(pack.filesDir.startsWith(realPacksRoot)).toBe(true);
  });

  it("declares a budget matching its own files/ tree -- the same counting helper caps.test.ts's generic 'every templates/packs/*' check uses", () => {
    const pack = loadPack("quality");
    const actual = countPackBudget(
      pack.filesDir,
      pack.manifest.wiring.packageScripts,
    );
    expect(pack.manifest.budget).toEqual(actual);
    expect(pack.manifest.budget).toEqual({
      agents: 1,
      skills: 0,
      hooks: 0,
      workflows: 0,
      scripts: 0,
    });
  });

  it("ships the type-design-analyzer agent, the file-budget gate script and its baseline JSON, moved verbatim from harness-extras", () => {
    const pack = loadPack("quality");
    for (const relPath of [
      join(".claude", "agents", "type-design-analyzer.md"),
      join("bin", "check-file-budget.mjs"),
      join("bin", "file-budget-baseline.json"),
    ]) {
      expect(existsSync(join(pack.filesDir, relPath))).toBe(true);
    }
  });

  it("throws when bin/lib/report.mjs is missing from the target", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-quality-missing-"));
    try {
      expect(() => installPack(loadPack("quality"), targetDir, {})).toThrow(
        /requires "bin\/lib\/report\.mjs"/,
      );
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("installs alone: the agent and gate script land on disk, and the file-budget step merges into bin/lib/verify-steps.packs.json", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-quality-alone-"));
    try {
      mkdirSync(join(targetDir, "bin", "lib"), { recursive: true });
      writeFileSync(join(targetDir, "bin", "lib", "report.mjs"), "");

      installPack(loadPack("quality"), targetDir, {});

      expect(
        existsSync(
          join(targetDir, ".claude", "agents", "type-design-analyzer.md"),
        ),
      ).toBe(true);
      expect(existsSync(join(targetDir, "bin", "check-file-budget.mjs"))).toBe(
        true,
      );
      expect(
        existsSync(join(targetDir, "bin", "file-budget-baseline.json")),
      ).toBe(true);

      const stepsPath = join(
        targetDir,
        "bin",
        "lib",
        "verify-steps.packs.json",
      );
      expect(existsSync(stepsPath)).toBe(true);
      const steps = JSON.parse(readFileSync(stepsPath, "utf8")) as Array<{
        id: string;
      }>;
      expect(steps.map((step) => step.id)).toEqual(["file-budget"]);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("adopt mode stages pack.json and the files/ tree unmodified, each under an inert .staged name, under .groundwork/packs/quality/", () => {
    const groundworkDir = mkdtempSync(join(tmpdir(), "packs-quality-stage-"));
    try {
      const pack = loadPack("quality");
      const [staged] = stagePacks([pack], groundworkDir, {});

      expect(staged?.name).toBe("quality");
      expect(staged?.dir).toBe(".groundwork/packs/quality");
      expect(
        existsSync(join(groundworkDir, "packs", "quality", "pack.json.staged")),
      ).toBe(true);
      expect(
        existsSync(join(groundworkDir, "packs", "quality", "pack.json")),
      ).toBe(false);
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "quality",
            "files",
            ".claude",
            "agents",
            "type-design-analyzer.md.staged",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "quality",
            "files",
            "bin",
            "check-file-budget.mjs.staged",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});

describe("the real github pack", () => {
  it("loads cleanly and declares an empty wiring surface -- pure file drop, no hooks/settings/scripts/gate", () => {
    expect(listPackNames()).toContain("github");
    const pack = loadPack("github");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.wiring.settings).toEqual({});
    expect(pack.manifest.wiring.packageScripts).toEqual({});
    expect(pack.manifest.wiring.verifySteps).toEqual([]);
    expect(pack.manifest.wiring.settingsTopLevel).toBeUndefined();
    expect(existsSync(pack.filesDir)).toBe(true);
  });
});

describe("the real publishing pack", () => {
  it("loads cleanly, is fresh-mode only, and wires two package scripts and two verify steps across the lint/build groups", () => {
    expect(listPackNames()).toContain("publishing");
    const pack = loadPack("publishing");
    expect(pack.manifest.modes).toEqual(["fresh"]);
    expect(pack.manifest.wiring.settings).toEqual({});
    expect(pack.manifest.wiring.settingsTopLevel).toBeUndefined();
    expect(Object.keys(pack.manifest.wiring.packageScripts).sort()).toEqual([
      "changeset",
      "version:packages",
    ]);
    expect(pack.manifest.budget.scripts).toBe(2);
    // The supply-chain half (gitleaks/scorecard) has been carved out into
    // its own pack -- publishing keeps only release.yml, one CI workflow.
    expect(pack.manifest.budget.workflows).toBe(1);

    const steps = pack.manifest.wiring.verifySteps;
    expect(steps.map((step) => step.id).sort()).toEqual([
      "dts-deps",
      "license-headers",
    ]);
    const byId = new Map(steps.map((step) => [step.id, step]));
    expect(byId.get("license-headers")?.group).toBe("lint");
    expect(byId.get("dts-deps")?.group).toBe("build");

    expect(existsSync(pack.filesDir)).toBe(true);
  });

  it("no longer ships the supply-chain half -- gitleaks.yml, scorecard.yml and .gitleaks.toml moved to the supply-chain pack", () => {
    const pack = loadPack("publishing");
    expect(
      existsSync(join(pack.filesDir, ".github", "workflows", "gitleaks.yml")),
    ).toBe(false);
    expect(
      existsSync(join(pack.filesDir, ".github", "workflows", "scorecard.yml")),
    ).toBe(false);
    expect(existsSync(join(pack.filesDir, ".gitleaks.toml"))).toBe(false);
  });

  it("installs alone: package.json gains both scripts, verify-steps.packs.json gains both steps", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-publishing-alone-"));
    try {
      writeFileSync(
        join(targetDir, "package.json"),
        JSON.stringify({ name: "x", scripts: {} }),
      );
      installPack(loadPack("publishing"), targetDir, {});

      const pkg = JSON.parse(
        readFileSync(join(targetDir, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      expect(Object.keys(pkg.scripts).sort()).toEqual([
        "changeset",
        "version:packages",
      ]);

      const stepsPath = join(
        targetDir,
        "bin",
        "lib",
        "verify-steps.packs.json",
      );
      expect(existsSync(stepsPath)).toBe(true);
      const steps = JSON.parse(readFileSync(stepsPath, "utf8")) as Array<{
        id: string;
      }>;
      expect(steps.map((step) => step.id).sort()).toEqual([
        "dts-deps",
        "license-headers",
      ]);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("the real supply-chain pack", () => {
  it("loads cleanly, is fresh+adopt capable, declares an empty wiring surface and a 0/0/0/2/0 budget matching its own files/ tree", () => {
    expect(listPackNames()).toContain("supply-chain");
    const pack = loadPack("supply-chain");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.requires).toBeUndefined();
    expect(pack.manifest.wiring.settings).toEqual({});
    expect(pack.manifest.wiring.settingsTopLevel).toBeUndefined();
    expect(pack.manifest.wiring.packageScripts).toEqual({});
    expect(pack.manifest.wiring.verifySteps).toEqual([]);
    expect(pack.manifest.budget).toEqual({
      agents: 0,
      skills: 0,
      hooks: 0,
      workflows: 2,
      scripts: 0,
    });
    expect(existsSync(pack.filesDir)).toBe(true);
    expect(pack.filesDir.startsWith(realPacksRoot)).toBe(true);

    // The declared budget must match what the pack's own files/ tree
    // actually contains -- the same counting helper
    // packages/cli/tests/caps.test.ts's generic "every templates/packs/*"
    // check uses.
    const actual = countPackBudget(
      pack.filesDir,
      pack.manifest.wiring.packageScripts,
    );
    expect(pack.manifest.budget).toEqual(actual);
  });

  it("ships both workflows plus .gitleaks.toml, and neither workflow carries a __PROJECT_NAME__ token or an SPDX header (moved verbatim from publishing except the leading header lines, which would stay literal in adopt mode)", () => {
    const pack = loadPack("supply-chain");
    const gitleaksPath = join(
      pack.filesDir,
      ".github",
      "workflows",
      "gitleaks.yml",
    );
    const scorecardPath = join(
      pack.filesDir,
      ".github",
      "workflows",
      "scorecard.yml",
    );
    const gitleaksTomlPath = join(pack.filesDir, ".gitleaks.toml");

    for (const path of [gitleaksPath, scorecardPath, gitleaksTomlPath]) {
      expect(existsSync(path)).toBe(true);
    }

    for (const path of [gitleaksPath, scorecardPath]) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("__PROJECT_NAME__");
      expect(content).not.toMatch(/^# SPDX-FileCopyrightText:/mu);
      expect(content).not.toMatch(/^# SPDX-License-Identifier:/mu);
    }
  });

  it("installs alone: both workflows and .gitleaks.toml land on disk byte-identical to their pack source, and settings.json/verify-steps.packs.json stay untouched -- a pure file drop", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-supply-chain-alone-"));
    try {
      mkdirSync(join(targetDir, ".claude"), { recursive: true });
      writeFileSync(
        join(targetDir, ".claude", "settings.json"),
        JSON.stringify({ hooks: {} }),
      );

      const pack = loadPack("supply-chain");
      installPack(pack, targetDir, {});

      const relPaths = [
        join(".github", "workflows", "gitleaks.yml"),
        join(".github", "workflows", "scorecard.yml"),
        ".gitleaks.toml",
      ];
      for (const relPath of relPaths) {
        const emittedPath = join(targetDir, relPath);
        expect(existsSync(emittedPath)).toBe(true);
        expect(readFileSync(emittedPath, "utf8")).toBe(
          readFileSync(join(pack.filesDir, relPath), "utf8"),
        );
      }

      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(settings).toEqual({ hooks: {} });
      expect(
        existsSync(join(targetDir, "bin", "lib", "verify-steps.packs.json")),
      ).toBe(false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("adopt mode stages pack.json and the files/ tree unmodified, each under an inert .staged name, under .groundwork/packs/supply-chain/", () => {
    const groundworkDir = mkdtempSync(
      join(tmpdir(), "packs-supply-chain-stage-"),
    );
    try {
      const pack = loadPack("supply-chain");
      const [staged] = stagePacks([pack], groundworkDir, {});

      expect(staged?.name).toBe("supply-chain");
      expect(staged?.dir).toBe(".groundwork/packs/supply-chain");
      expect(
        existsSync(
          join(groundworkDir, "packs", "supply-chain", "pack.json.staged"),
        ),
      ).toBe(true);
      expect(
        existsSync(join(groundworkDir, "packs", "supply-chain", "pack.json")),
      ).toBe(false);
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "supply-chain",
            "files",
            ".github",
            "workflows",
            "gitleaks.yml.staged",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "supply-chain",
            "files",
            ".gitleaks.toml.staged",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});

describe("the real worktrees pack", () => {
  it("loads cleanly with modes fresh+adopt, a 0/1/2/0/0 budget, and a requires.paths dependency on bin/lib/protected-paths.mjs", () => {
    expect(listPackNames()).toContain("worktrees");
    const pack = loadPack("worktrees");
    expect(pack.manifest.modes).toEqual(["fresh", "adopt"]);
    expect(pack.manifest.budget).toEqual({
      agents: 0,
      skills: 1,
      hooks: 2,
      workflows: 0,
      scripts: 0,
    });
    expect(pack.manifest.requires?.paths).toContain(
      "bin/lib/protected-paths.mjs",
    );
    expect(existsSync(pack.filesDir)).toBe(true);
    expect(pack.filesDir.startsWith(realPacksRoot)).toBe(true);
  });

  it("installs alone: settings.json gains a SessionStart[startup|resume] entry and a PreToolUse[Write|Edit] entry, and both hooks, the skill and .worktreeinclude land on disk", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-worktrees-alone-"));
    try {
      mkdirSync(join(targetDir, ".claude"), { recursive: true });
      mkdirSync(join(targetDir, "bin", "lib"), { recursive: true });
      writeFileSync(join(targetDir, "bin", "lib", "protected-paths.mjs"), "");
      writeFileSync(
        join(targetDir, ".claude", "settings.json"),
        JSON.stringify({ hooks: {} }),
      );

      installPack(loadPack("worktrees"), targetDir, {});

      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      };
      expect(settings.hooks["SessionStart"]).toHaveLength(1);
      expect(settings.hooks["SessionStart"]?.[0]?.matcher).toBe(
        "startup|resume",
      );
      expect(settings.hooks["PreToolUse"]).toHaveLength(1);
      expect(settings.hooks["PreToolUse"]?.[0]?.matcher).toBe("Write|Edit");

      expect(
        existsSync(
          join(targetDir, ".claude", "hooks", "guard-worktree-only.mjs"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(targetDir, ".claude", "hooks", "ensure-worktree-deps.mjs"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            targetDir,
            ".claude",
            "skills",
            "working-in-worktrees",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(existsSync(join(targetDir, ".worktreeinclude"))).toBe(true);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("co-installs alongside harness-extras without a merge collision: both add a DIFFERENT-matcher SessionStart entry, ending up as two separate array entries", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "packs-worktrees-coinstall-"));
    try {
      mkdirSync(join(targetDir, ".claude"), { recursive: true });
      mkdirSync(join(targetDir, "bin", "lib"), { recursive: true });
      // harness-extras's own requires.paths dependency.
      writeFileSync(join(targetDir, "bin", "lib", "agent-roster.mjs"), "");
      // worktrees's own requires.paths dependency.
      writeFileSync(join(targetDir, "bin", "lib", "protected-paths.mjs"), "");
      writeFileSync(
        join(targetDir, ".claude", "settings.json"),
        JSON.stringify({ $schema: "s", hooks: {} }),
      );

      installPack(loadPack("harness-extras"), targetDir, {});
      installPack(loadPack("worktrees"), targetDir, {});

      const settings = JSON.parse(
        readFileSync(join(targetDir, ".claude", "settings.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      };
      const sessionStart = settings.hooks["SessionStart"] ?? [];
      expect(sessionStart).toHaveLength(2);
      const matchers = sessionStart.map((entry) => entry.matcher).sort();
      expect(matchers).toEqual(["compact|resume|startup", "startup|resume"]);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("ts-advisor retirement", () => {
  // ts-advisor was retired: its recommending-ts-tooling skill merged into
  // templates/core's own baseline typescript-guidance skill as a third
  // mode ("gaps"), so the pack itself must no longer be installable.
  it("no longer appears in listPackNames()", () => {
    expect(listPackNames()).not.toContain("ts-advisor");
  });

  it("loadPack throws, naming ts-advisor as an unknown pack", () => {
    expect(() => loadPack("ts-advisor")).toThrow(/unknown pack "ts-advisor"/);
  });
});

describe("cross-pack and pack/templates-core path collisions", () => {
  it("emits no path collision between any two real packs, nor between a pack and templates/core", () => {
    const owners = new Map<string, string>();
    const coreDir = join(here, "..", "..", "..", "templates", "core");
    for (const entry of walkBounded(coreDir, 30)) {
      if (entry.isDirectory) continue;
      owners.set(entry.relPath, "templates/core");
    }

    const packNames = listPackNames();
    expect(packNames.length).toBeGreaterThan(0);
    for (const name of packNames) {
      const pack = loadPack(name);
      for (const entry of walkBounded(pack.filesDir, 30)) {
        if (entry.isDirectory) continue;
        const owner = owners.get(entry.relPath);
        expect(
          owner,
          `"${entry.relPath}" is emitted by both "${name}" and "${String(owner)}"`,
        ).toBeUndefined();
        owners.set(entry.relPath, name);
      }
    }
  });
});
