// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `stampUpgrade`: records an applied upgrade in `.groundwork/manifest.json`.
 * Plans are hand-built (`plan.json` as `--upgrade` would have staged it) so
 * every class rule is pinned by hand; the project's bytes are the only input
 * besides the plan and the manifest. The stamp writes the manifest and
 * nothing else.
 */
import {
  chmodSync,
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
import { dirname, join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  parseManifest,
  serializeManifest,
  sha256Hex,
} from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import { UpgradeStampError, stampUpgrade } from "../src/upgrade/stamp.js";
import type { StampResult } from "../src/upgrade/stamp.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";

type FileEntry = Manifest["files"][string];

const TOKENS = { PROJECT_NAME: "acme", YEAR: "1999" };
const FROM = "1.0.0";
const TO = "2.0.0";

interface PlanEntryInput {
  path: string;
  class: string;
  recordedSha256?: string;
  nextSha256?: string;
}
interface JsonKeyInput {
  pointer: string;
  class: string;
  recordedSha256?: string;
  nextSha256?: string;
}

const h = (content: string): string => sha256Hex(content);
/** The hash a JSON-key entry carries for a primitive value: sha256 of its JSON text. */
const hv = (value: unknown): string => sha256Hex(JSON.stringify(value));
const emitted = (content: string): FileEntry => ({
  sha256: h(content),
  origin: "emitted",
});
const merged = (content: string): FileEntry => ({
  sha256: h(content),
  origin: "merged",
});

describe("stampUpgrade", () => {
  let project: string;

  const manifestPath = (): string =>
    join(project, ".groundwork", "manifest.json");
  const planPath = (): string =>
    join(project, ".groundwork", "upgrade", "plan.json");

  function writeManifestFile(overrides: Partial<Manifest> = {}): Manifest {
    const manifest: Manifest = {
      schemaVersion: 1,
      cliVersion: FROM,
      tokens: { ...TOKENS },
      packs: [],
      files: {},
      jsonKeys: {},
      ...overrides,
    };
    mkdirSync(join(project, ".groundwork"), { recursive: true });
    writeFileSync(manifestPath(), serializeManifest(manifest));
    return manifest;
  }

  function basePlan(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schemaVersion: 1,
      fromCliVersion: FROM,
      toCliVersion: TO,
      tokens: { ...TOKENS },
      packs: [],
      files: [],
      jsonKeys: {},
      legacy: false,
      staged: [],
      ...overrides,
    };
  }

  function writePlanText(text: string): void {
    mkdirSync(dirname(planPath()), { recursive: true });
    writeFileSync(planPath(), text);
  }

  function writePlan(overrides: Record<string, unknown> = {}): void {
    writePlanText(`${JSON.stringify(basePlan(overrides), null, 2)}\n`);
  }

  const writeProjectFile = (rel: string, content: string): void => {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), content);
  };

  const thrownBy = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const thrownCode = (fn: () => unknown): unknown => {
    const error = thrownBy(fn);
    expect(error).toBeInstanceOf(UpgradeStampError);
    return (error as UpgradeStampError).code;
  };

  const stamp = (): StampResult => stampUpgrade({ targetDir: project });
  const stampedManifest = (): Manifest =>
    parseManifest(readFileSync(manifestPath(), "utf8"));

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "upgrade-stamp-test-"));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  describe("the result", () => {
    it("has the documented shape", () => {
      expectTypeOf<StampResult>().toEqualTypeOf<{
        manifest: Manifest;
        updated: number;
        kept: number;
        dropped: number;
      }>();
    });

    it("moves cliVersion to the plan's toCliVersion, keeps tokens and packs, and writes exactly the returned manifest", () => {
      writeManifestFile({ packs: ["harness-extras", "quality"] });
      writePlan({ packs: ["harness-extras", "quality"] });

      const result = stamp();

      expect(result.manifest.cliVersion).toBe(TO);
      expect(result.manifest.schemaVersion).toBe(1);
      expect(result.manifest.tokens).toEqual(TOKENS);
      expect(result.manifest.packs).toEqual(["harness-extras", "quality"]);
      expect(stampedManifest()).toEqual(result.manifest);
      expect(readFileSync(manifestPath(), "utf8")).toBe(
        serializeManifest(result.manifest),
      );
    });

    it("stamps a plan of only current and local-only entries, moving cliVersion", () => {
      writeManifestFile({
        files: { "a.txt": emitted("a"), "b.txt": emitted("b-old") },
      });
      writeProjectFile("a.txt", "a");
      writeProjectFile("b.txt", "b-mine");
      writePlan({
        files: [
          {
            path: "a.txt",
            class: "current",
            recordedSha256: h("a"),
            nextSha256: h("a"),
          },
          {
            path: "b.txt",
            class: "local-only",
            recordedSha256: h("b-old"),
            nextSha256: h("b-mine"),
          },
        ],
      });

      const result = stamp();

      expect(result.manifest.cliVersion).toBe(TO);
      expect(stampedManifest().cliVersion).toBe(TO);
      expect(stampedManifest().files["a.txt"]).toEqual(emitted("a"));
    });

    it("counts updated, kept and dropped entries from unambiguous scenarios", () => {
      writeManifestFile({
        files: {
          "applied.txt": emitted("v1"),
          "pending.txt": emitted("v1"),
          "mine.txt": emitted("v1"),
          "gone.txt": emitted("v1"),
          "removed.txt": emitted("v1"),
          "local.txt": emitted("v1"),
        },
      });
      writeProjectFile("applied.txt", "v2");
      writeProjectFile("pending.txt", "v1");
      writeProjectFile("mine.txt", "mine");
      writeProjectFile("local.txt", "edited");
      writeProjectFile("new.txt", "fresh");
      writePlan({
        files: [
          {
            path: "applied.txt",
            class: "safe-update",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
          {
            path: "pending.txt",
            class: "safe-update",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
          {
            path: "mine.txt",
            class: "conflict-3way",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
          { path: "gone.txt", class: "gone", recordedSha256: h("v1") },
          { path: "removed.txt", class: "remove", recordedSha256: h("v1") },
          {
            path: "local.txt",
            class: "local-only",
            recordedSha256: h("v1"),
            nextSha256: h("v1"),
          },
          { path: "new.txt", class: "add", nextSha256: h("fresh") },
        ] satisfies PlanEntryInput[],
      });

      const result = stamp();

      // applied, pending (now {v1, merged}: the base invariant), mine (merged)
      // and new.txt (a new entry) are rewritten
      expect(result.updated).toBe(4);
      // only local-only stays as it was
      expect(result.kept).toBe(1);
      expect(result.dropped).toBe(2);
      expect(Object.keys(result.manifest.files).sort()).toEqual([
        "applied.txt",
        "local.txt",
        "mine.txt",
        "new.txt",
        "pending.txt",
      ]);
    });

    it("counts an entry whose origin moves to merged as updated, not kept", () => {
      writeManifestFile({ files: { "o.txt": emitted("v1") } });
      writeProjectFile("o.txt", "mine");
      writePlan({
        files: [
          { path: "o.txt", class: "orphan-edited", recordedSha256: h("v1") },
        ] satisfies PlanEntryInput[],
      });

      const result = stamp();

      expect(result.manifest.files["o.txt"]).toEqual(merged("v1"));
      expect(result.updated).toBe(1);
      expect(result.kept).toBe(0);
      expect(result.dropped).toBe(0);
    });

    it("keeps manifest paths the plan does not mention, unchanged", () => {
      writeManifestFile({
        files: {
          "untouched.txt": merged("whatever"),
          "other.txt": emitted("o"),
        },
        jsonKeys: { "package.json": { "/name": hv("x") } },
      });
      writeProjectFile("untouched.txt", "changed on disk, but not in the plan");
      writePlan();

      const result = stamp();

      expect(result.manifest.files).toEqual({
        "untouched.txt": merged("whatever"),
        "other.txt": emitted("o"),
      });
      expect(result.manifest.jsonKeys).toEqual({
        "package.json": { "/name": hv("x") },
      });
    });
  });

  describe("file entries per class", () => {
    interface Row {
      name: string;
      /** The project file's content, `undefined` when absent. */
      disk?: string;
      old?: FileEntry;
      recorded?: string;
      next?: string;
      /** The expected entry, or `"old"` for the unchanged old entry, or `undefined` for none. */
      expected: FileEntry | "old" | undefined;
    }

    function runRow(cls: string, row: Row): void {
      writeManifestFile({
        files: row.old === undefined ? {} : { "f.txt": row.old },
      });
      if (row.disk !== undefined) writeProjectFile("f.txt", row.disk);
      const entry: PlanEntryInput = { path: "f.txt", class: cls };
      if (row.recorded !== undefined) entry.recordedSha256 = h(row.recorded);
      if (row.next !== undefined) entry.nextSha256 = h(row.next);
      writePlan({ files: [entry] });

      const result = stamp();

      const expected = row.expected === "old" ? row.old : row.expected;
      expect(result.manifest.files["f.txt"]).toEqual(expected);
      expect(Object.hasOwn(result.manifest.files, "f.txt")).toBe(
        expected !== undefined,
      );
      expect(stampedManifest().files["f.txt"]).toEqual(expected);
    }

    describe.each([
      "current",
      "add",
      "safe-update",
      "conflict-2way",
      "conflict-3way",
    ])("%s", (cls) => {
      const rows: Row[] = [
        {
          // One cliVersion: a kept hash that differs from N cannot be rebuilt.
          name: "absent from disk, with an emitted old entry whose hash differs from the new release: keeps the hash, marked merged",
          old: emitted("v1"),
          recorded: "v1",
          next: "v2",
          expected: merged("v1"),
        },
        {
          name: "absent from disk, with a merged old entry: keeps it unchanged",
          old: merged("v1"),
          recorded: "v1",
          next: "v2",
          expected: "old",
        },
        {
          name: "absent from disk, with no old entry: records nothing",
          next: "v2",
          expected: undefined,
        },
        {
          name: "disk equals the new release: records it as emitted",
          disk: "v2",
          old: emitted("v1"),
          recorded: "v1",
          next: "v2",
          expected: emitted("v2"),
        },
        {
          name: "disk equals the new release and nothing was recorded: records it as emitted",
          disk: "v2",
          next: "v2",
          expected: emitted("v2"),
        },
        {
          name: "disk equals the new release but the old entry was merged: becomes emitted",
          disk: "v2",
          old: merged("v1"),
          recorded: "v1",
          next: "v2",
          expected: emitted("v2"),
        },
        {
          // The manifest has one cliVersion, so an entry still holding the
          // FROM version's hash can no longer be rebuilt: it becomes merged.
          name: "disk still equals the recorded hash (a revert), which differs from the new release: keeps the old hash marked merged",
          disk: "v1",
          old: emitted("v1"),
          recorded: "v1",
          next: "v2",
          expected: merged("v1"),
        },
        {
          name: "disk still equals the recorded hash of a merged entry: keeps it merged",
          disk: "v1",
          old: merged("v1"),
          recorded: "v1",
          next: "v2",
          expected: "old",
        },
        {
          name: "disk differs from both: the user kept their own bytes, recorded as merged with the disk hash",
          disk: "mine",
          old: emitted("v1"),
          recorded: "v1",
          next: "v2",
          expected: merged("mine"),
        },
        {
          name: "disk differs and nothing was recorded: recorded as merged with the disk hash",
          disk: "mine",
          next: "v2",
          expected: merged("mine"),
        },
      ];
      it.each(rows)("$name", (row) => {
        runRow(cls, row);
      });
    });

    describe("local-only keeps the old entry unchanged (its hash equals the new release's)", () => {
      it.each<Row>([
        {
          name: "disk edited",
          disk: "mine",
          old: emitted("v1"),
          recorded: "v1",
          next: "v1",
          expected: "old",
        },
        {
          name: "disk absent",
          old: emitted("v1"),
          recorded: "v1",
          next: "v1",
          expected: "old",
        },
        {
          name: "disk equal to the new content and a merged old entry",
          disk: "v1",
          old: merged("v1"),
          recorded: "v1",
          next: "v1",
          expected: "old",
        },
      ])("$name", (row) => {
        runRow("local-only", row);
      });
    });

    describe("current with the recorded hash equal to the new release's (M == N)", () => {
      it.each<Row>([
        {
          name: "absent from disk: an emitted entry stays emitted",
          old: emitted("v1"),
          recorded: "v1",
          next: "v1",
          expected: "old",
        },
        {
          name: "disk equals both: stays emitted",
          disk: "v1",
          old: emitted("v1"),
          recorded: "v1",
          next: "v1",
          expected: "old",
        },
      ])("$name", (row) => {
        runRow("current", row);
      });
    });

    describe("orphan-edited (no new release hash)", () => {
      it.each<Row>([
        {
          name: "an emitted old entry, disk edited: keeps the hash, marked merged",
          disk: "mine",
          old: emitted("v1"),
          recorded: "v1",
          expected: merged("v1"),
        },
        {
          name: "an emitted old entry, disk absent: keeps the hash, marked merged",
          old: emitted("v1"),
          recorded: "v1",
          expected: merged("v1"),
        },
        {
          name: "a merged old entry, disk edited: unchanged",
          disk: "mine",
          old: merged("v1"),
          recorded: "v1",
          expected: "old",
        },
        {
          name: "a merged old entry, disk absent: unchanged",
          old: merged("v1"),
          recorded: "v1",
          expected: "old",
        },
      ])("$name", (row) => {
        runRow("orphan-edited", row);
      });
    });

    describe("user-deleted", () => {
      it.each<Row>([
        {
          name: "keeps the old hash, marked merged (an emitted base cannot be rebuilt once cliVersion moves)",
          old: emitted("v1"),
          recorded: "v1",
          next: "v1",
          expected: merged("v1"),
        },
        {
          name: "keeps a merged entry merged",
          old: merged("v1"),
          recorded: "v1",
          next: "v1",
          expected: merged("v1"),
        },
      ])("$name", (row) => {
        runRow("user-deleted", row);
      });
    });

    describe("gone", () => {
      it.each<Row>([
        {
          name: "keeps the old hash, marked merged, when a regular file is there now (no new release hash exists)",
          disk: "surprise",
          old: emitted("v1"),
          recorded: "v1",
          expected: merged("v1"),
        },
        {
          name: "keeps a merged old entry unchanged when a regular file is there now",
          disk: "surprise",
          old: merged("v1"),
          recorded: "v1",
          expected: "old",
        },
        {
          name: "drops an emitted entry",
          old: emitted("v1"),
          recorded: "v1",
          expected: undefined,
        },
        {
          name: "drops a merged entry",
          old: merged("v1"),
          recorded: "v1",
          expected: undefined,
        },
      ])("$name", (row) => {
        runRow("gone", row);
      });
    });

    describe("remove", () => {
      it.each<Row>([
        {
          name: "drops the entry once the file is absent",
          old: emitted("v1"),
          recorded: "v1",
          expected: undefined,
        },
        {
          name: "keeps the old hash marked merged while the file is still there, unedited",
          disk: "v1",
          old: emitted("v1"),
          recorded: "v1",
          expected: merged("v1"),
        },
        {
          name: "keeps the old hash marked merged while the file is still there, edited",
          disk: "mine",
          old: emitted("v1"),
          recorded: "v1",
          expected: merged("v1"),
        },
      ])("$name", (row) => {
        runRow("remove", row);
      });
    });
  });

  describe("JSON keys", () => {
    const FILE = "package.json";
    const withScripts = (scripts: Record<string, unknown>): string =>
      `${JSON.stringify({ name: "acme", scripts }, null, 2)}\n`;

    function stampKeys(params: {
      disk: string | undefined;
      old: Record<string, string> | undefined;
      entries: JsonKeyInput[];
    }): Manifest["jsonKeys"] {
      writeManifestFile({
        jsonKeys: params.old === undefined ? {} : { [FILE]: params.old },
      });
      if (params.disk !== undefined) writeProjectFile(FILE, params.disk);
      writePlan({ jsonKeys: { [FILE]: params.entries } });
      return stamp().manifest.jsonKeys;
    }

    it("records the new hash when the key on disk equals the new release, hashed from the disk file", () => {
      const keys = stampKeys({
        disk: withScripts({ lint: "eslint ." }),
        old: { "/scripts/lint": hv("old") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "safe-update",
            recordedSha256: hv("old"),
            nextSha256: hv("eslint ."),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("eslint .") } });
    });

    it("records an added key whose disk value equals the new release", () => {
      const keys = stampKeys({
        disk: withScripts({ lint: "eslint ." }),
        old: {},
        entries: [
          {
            pointer: "/scripts/lint",
            class: "add",
            nextSha256: hv("eslint ."),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("eslint .") } });
    });

    it("keeps the old hash for a key the user kept different, so it is a conflict next time", () => {
      const keys = stampKeys({
        disk: withScripts({ lint: "my-lint" }),
        old: { "/scripts/lint": hv("old") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "conflict-3way",
            recordedSha256: hv("old"),
            nextSha256: hv("eslint ."),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("old") } });
    });

    it("records nothing for a differing added key that was never recorded", () => {
      const keys = stampKeys({
        disk: withScripts({ lint: "my-lint" }),
        old: { "/name": hv("acme") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "conflict-2way",
            nextSha256: hv("eslint ."),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/name": hv("acme") } });
    });

    it("keeps the old hash for a change not applied yet", () => {
      const keys = stampKeys({
        disk: withScripts({ lint: "old" }),
        old: { "/scripts/lint": hv("old") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "safe-update",
            recordedSha256: hv("old"),
            nextSha256: hv("eslint ."),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("old") } });
    });

    it("keeps the old hash for a key the user deleted while the release still has it", () => {
      const keys = stampKeys({
        disk: withScripts({ other: "x" }),
        old: { "/scripts/lint": hv("old") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "user-deleted",
            recordedSha256: hv("old"),
            nextSha256: hv("old"),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("old") } });
    });

    it("keeps the old hash for a key gone upstream that is still on disk", () => {
      const keys = stampKeys({
        disk: withScripts({ lint: "old" }),
        old: { "/scripts/lint": hv("old") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "remove",
            recordedSha256: hv("old"),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("old") } });
    });

    it("drops a key absent from the new release and from disk, keeping the file's other keys", () => {
      const keys = stampKeys({
        disk: withScripts({ other: "x" }),
        old: { "/scripts/lint": hv("old"), "/scripts/other": hv("x") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "gone",
            recordedSha256: hv("old"),
          },
        ],
      });
      expect(keys).toEqual({ [FILE]: { "/scripts/other": hv("x") } });
    });

    it("drops the file's entry when its last key is dropped", () => {
      const keys = stampKeys({
        disk: withScripts({}),
        old: { "/scripts/lint": hv("old") },
        entries: [
          {
            pointer: "/scripts/lint",
            class: "gone",
            recordedSha256: hv("old"),
          },
        ],
      });
      expect(Object.hasOwn(keys, FILE)).toBe(false);
    });

    it.each([
      ["absent", undefined],
      ["a JSON array", "[1, 2]"],
    ])(
      "keeps the old entry that still has a release value when the file is %s, without throwing",
      (_name, disk) => {
        const keys = stampKeys({
          disk,
          old: { "/scripts/lint": hv("old") },
          entries: [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: hv("old"),
              nextSha256: hv("eslint ."),
            },
          ],
        });
        expect(keys).toEqual({ [FILE]: { "/scripts/lint": hv("old") } });
      },
    );

    it("keeps another file's entry when only one file is in the plan", () => {
      writeManifestFile({
        jsonKeys: {
          [FILE]: { "/scripts/lint": hv("old") },
          "tsconfig.json": { "/compilerOptions/strict": hv(true) },
        },
      });
      writeProjectFile(FILE, withScripts({ lint: "eslint ." }));
      writePlan({
        jsonKeys: {
          [FILE]: [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: hv("old"),
              nextSha256: hv("eslint ."),
            },
          ],
        },
      });
      expect(stamp().manifest.jsonKeys).toEqual({
        [FILE]: { "/scripts/lint": hv("eslint .") },
        "tsconfig.json": { "/compilerOptions/strict": hv(true) },
      });
    });
  });

  describe("writes nothing but the manifest", () => {
    it("changes only .groundwork/manifest.json, leaving project files, the plan and the staged copies alone", () => {
      writeManifestFile({
        files: { "a.txt": emitted("v1"), "gone.txt": emitted("g") },
      });
      writeProjectFile("a.txt", "v2");
      writeProjectFile("sub/keep.txt", "keep");
      writeProjectFile(".groundwork/upgrade/staged/a.txt.staged", "v2");
      writeProjectFile(".groundwork/upgrade/upgrade-report.md", "# report\n");
      writePlan({
        files: [
          {
            path: "a.txt",
            class: "safe-update",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
          { path: "gone.txt", class: "gone", recordedSha256: h("g") },
        ],
        staged: [
          { path: "a.txt", staged: "staged/a.txt.staged", sha256: h("v2") },
        ],
      });
      const before = snapshotTree(project);

      stamp();

      const after = snapshotTree(project);
      const changed = Object.keys({ ...before, ...after }).filter(
        (path) => before[path] !== after[path],
      );
      expect(changed).toEqual([".groundwork/manifest.json"]);
      expect(readdirSync(join(project, ".groundwork")).sort()).toEqual([
        "manifest.json",
        "upgrade",
      ]);
      expect(existsSync(`${manifestPath()}.tmp`)).toBe(false);
    });

    it("is deterministic: the same inputs give the same manifest bytes", () => {
      const setup = (): void => {
        writeManifestFile({
          files: { "b.txt": emitted("b1"), "a.txt": emitted("a1") },
        });
        writeProjectFile("a.txt", "a2");
        writeProjectFile("b.txt", "mine");
        writePlan({
          files: [
            {
              path: "b.txt",
              class: "conflict-3way",
              recordedSha256: h("b1"),
              nextSha256: h("b2"),
            },
            {
              path: "a.txt",
              class: "safe-update",
              recordedSha256: h("a1"),
              nextSha256: h("a2"),
            },
          ],
        });
      };
      setup();
      stamp();
      const first = readFileSync(manifestPath(), "utf8");
      setup();
      stamp();
      expect(readFileSync(manifestPath(), "utf8")).toBe(first);
      expect(first).toBe(serializeManifest(parseManifest(first)));
    });
  });

  describe("idempotence guard", () => {
    it("refuses a cross-version re-stamp of the same plan as stale (its fromCliVersion no longer matches), leaving the manifest untouched", () => {
      writeManifestFile({ files: { "a.txt": emitted("v1") } });
      writeProjectFile("a.txt", "v2");
      writePlan({
        files: [
          {
            path: "a.txt",
            class: "safe-update",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
        ],
      });
      stamp();
      const after = readFileSync(manifestPath(), "utf8");

      expect(() => stamp()).toThrow(/stale|already stamped/);
      expect(() => stamp()).toThrow(/--upgrade/);
      expect(readFileSync(manifestPath(), "utf8")).toBe(after);
    });

    it("refuses a plan computed from another CLI version than the manifest records", () => {
      writeManifestFile({ cliVersion: "0.9.0" });
      writePlan();
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(/stale|already stamped/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a same-version plan whose entries no longer match the manifest as stale", () => {
      writeManifestFile({
        cliVersion: "1.0.0",
        files: { "a.txt": emitted("v1") },
      });
      writeProjectFile("a.txt", "v2");
      writePlan({
        fromCliVersion: "1.0.0",
        toCliVersion: "1.0.0",
        files: [
          {
            path: "a.txt",
            class: "safe-update",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
        ],
      });

      expect(stamp().manifest.files["a.txt"]).toEqual(emitted("v2"));
      const after = readFileSync(manifestPath(), "utf8");

      expect(thrownCode(() => stamp())).toBe("stale-plan");
      expect(readFileSync(manifestPath(), "utf8")).toBe(after);
    });
  });

  describe("refusals that write nothing", () => {
    it("names the missing plan.json", () => {
      writeManifestFile();
      const before = snapshotTree(project);
      expect(() => stamp()).toThrow(Error);
      expect(() => stamp()).toThrow(/plan\.json/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("names the missing manifest", () => {
      writePlan();
      const before = snapshotTree(project);
      expect(() => stamp()).toThrow(Error);
      expect(() => stamp()).toThrow(/manifest/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a plan.json that is a symlink, even to a valid plan", () => {
      writeManifestFile();
      mkdirSync(dirname(planPath()), { recursive: true });
      const real = join(project, "real-plan.json");
      writeFileSync(real, JSON.stringify(basePlan()));
      symlinkSync(real, planPath());
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(/plan\.json/);
      expect(() => stamp()).toThrow(/symlink|regular file/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a plan.json that is a directory", () => {
      writeManifestFile();
      mkdirSync(planPath(), { recursive: true });
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(/plan\.json/);
      expect(() => stamp()).toThrow(/regular file/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses text that is not JSON without quoting any of it", () => {
      writeManifestFile();
      writePlanText("{ SECRET-MARKER-12345 not json");
      const before = snapshotTree(project);

      let thrown: unknown;
      try {
        stamp();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("plan.json");
      expect(message).not.toContain("SECRET-MARKER-12345");
      expect(snapshotTree(project)).toEqual(before);
    });

    it.each([["[]"], ['"text"'], ["null"], ["7"]])(
      "refuses a plan that is not a JSON object (%s)",
      (text) => {
        writeManifestFile();
        writePlanText(text);
        expect(() => stamp()).toThrow(/plan\.json/);
      },
    );

    it.each<[string, Record<string, unknown>]>([
      ["schemaVersion 2", { schemaVersion: 2 }],
      ["a missing schemaVersion", { schemaVersion: undefined }],
      ["legacy: true", { legacy: true }],
      ["a missing legacy flag", { legacy: undefined }],
      ["a non-string fromCliVersion", { fromCliVersion: 1 }],
      ["a non-string toCliVersion", { toCliVersion: null }],
      ["tokens that are not an object", { tokens: "acme" }],
      ["tokens with a non-string value", { tokens: { ...TOKENS, YEAR: 1999 } }],
      ["packs that are not an array", { packs: "quality" }],
      ["files that are not an array", { files: {} }],
      ["a file entry that is not an object", { files: ["a.txt"] }],
      ["jsonKeys that are an array", { jsonKeys: [] }],
      ["jsonKeys entries that are not arrays", { jsonKeys: { "a.json": {} } }],
      ["staged that is not an array", { staged: {} }],
    ])(
      "refuses a plan with %s, naming the problem and writing nothing",
      (_name, overrides) => {
        writeManifestFile();
        writePlan(overrides);
        const before = snapshotTree(project);

        let thrown: unknown;
        try {
          stamp();
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("plan.json");
        expect(snapshotTree(project)).toEqual(before);
      },
    );

    it("refuses a legacy plan with a message that says it is legacy", () => {
      writeManifestFile();
      writePlan({ legacy: true });
      expect(() => stamp()).toThrow(/legacy/);
    });

    it("refuses a plan whose tokens differ from the manifest's", () => {
      writeManifestFile();
      writePlan({ tokens: { PROJECT_NAME: "other", YEAR: "1999" } });
      const before = snapshotTree(project);

      let thrown: unknown;
      try {
        stamp();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/tokens/);
      expect((thrown as Error).message).not.toContain("other");
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a plan whose packs differ from the manifest's", () => {
      writeManifestFile({ packs: ["quality"] });
      writePlan({ packs: ["quality", "frontend"] });
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(/packs/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("propagates a corrupt manifest and writes nothing", () => {
      mkdirSync(join(project, ".groundwork"), { recursive: true });
      writeFileSync(manifestPath(), "{ not json");
      writePlan();
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(Error);
      expect(snapshotTree(project)).toEqual(before);
    });
  });

  describe("a conflict the user resolved (by design)", () => {
    it.each(["conflict-3way", "conflict-2way"])(
      "%s with disk equal to the plan's currentSha256 is recorded as merged with that hash",
      (cls) => {
        writeManifestFile({ files: { "f.txt": emitted("v1") } });
        writeProjectFile("f.txt", "mine");
        writePlan({
          files: [
            {
              path: "f.txt",
              class: cls,
              recordedSha256: h("v1"),
              currentSha256: h("mine"),
              nextSha256: h("v2"),
            },
          ],
        });

        const result = stamp();

        expect(result.manifest.files["f.txt"]).toEqual(merged("mine"));
        expect(stampedManifest().files["f.txt"]).toEqual(merged("mine"));
        expect(result.updated).toBe(1);
      },
    );
  });

  describe("a stale plan, per entry", () => {
    const SECRET = h("SECRET-HASH-SOURCE");

    function expectStale(path: string): void {
      const before = snapshotTree(project);
      const error = thrownBy(() => stamp());
      expect(error).toBeInstanceOf(UpgradeStampError);
      expect((error as UpgradeStampError).code).toBe("stale-plan");
      const message = (error as UpgradeStampError).message;
      expect(message).toMatch(/stale/);
      expect(message).toContain("--upgrade");
      expect(message).toContain(path);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(h("v1"));
      expect(snapshotTree(project)).toEqual(before);
    }

    it("refuses a file whose recordedSha256 differs from the manifest's hash", () => {
      writeManifestFile({ files: { "a.txt": emitted("v1") } });
      writeProjectFile("a.txt", "v1");
      writePlan({
        files: [
          {
            path: "a.txt",
            class: "safe-update",
            recordedSha256: SECRET,
            nextSha256: h("v2"),
          },
        ],
      });
      expectStale("a.txt");
    });

    it("refuses a file with a recordedSha256 the manifest has no entry for", () => {
      writeManifestFile();
      writePlan({
        files: [
          {
            path: "a.txt",
            class: "safe-update",
            recordedSha256: SECRET,
            nextSha256: h("v2"),
          },
        ],
      });
      expectStale("a.txt");
    });

    it("refuses a file without recordedSha256 when the manifest now has an entry for it", () => {
      writeManifestFile({ files: { "a.txt": emitted("v1") } });
      writePlan({
        files: [{ path: "a.txt", class: "add", nextSha256: h("v2") }],
      });
      expectStale("a.txt");
    });

    it("refuses a JSON key whose recordedSha256 differs from the manifest's key hash", () => {
      writeManifestFile({
        jsonKeys: { "package.json": { "/scripts/lint": hv("old") } },
      });
      writePlan({
        jsonKeys: {
          "package.json": [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: SECRET,
              nextSha256: hv("new"),
            },
          ],
        },
      });
      expectStale("package.json");
    });

    it("refuses a JSON key without recordedSha256 when the manifest now records that pointer", () => {
      writeManifestFile({
        jsonKeys: { "package.json": { "/scripts/lint": hv("old") } },
      });
      writePlan({
        jsonKeys: {
          "package.json": [
            { pointer: "/scripts/lint", class: "add", nextSha256: hv("new") },
          ],
        },
      });
      expectStale("package.json");
    });

    it("refuses a JSON key with a recordedSha256 for a pointer the manifest does not record", () => {
      writeManifestFile();
      writePlan({
        jsonKeys: {
          "package.json": [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: SECRET,
              nextSha256: hv("new"),
            },
          ],
        },
      });
      expectStale("package.json");
    });

    it("accepts a plan whose every recordedSha256 matches and whose unrecorded entries are unrecorded", () => {
      writeManifestFile({
        files: { "a.txt": emitted("v1") },
        jsonKeys: { "package.json": { "/scripts/lint": hv("old") } },
      });
      writeProjectFile("a.txt", "v2");
      writePlan({
        files: [
          {
            path: "a.txt",
            class: "safe-update",
            recordedSha256: h("v1"),
            nextSha256: h("v2"),
          },
          { path: "new.txt", class: "add", nextSha256: h("n") },
        ],
        jsonKeys: {
          "package.json": [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: hv("old"),
              nextSha256: hv("new"),
            },
            { pointer: "/scripts/new", class: "add", nextSha256: hv("n") },
          ],
        },
      });
      expect(stamp().manifest.cliVersion).toBe(TO);
    });
  });

  describe("JSON keys of a file that is absent, gone or unreadable", () => {
    const FILE = "package.json";

    it("drops key entries the release no longer has and keeps those it still has, when the file is absent", () => {
      writeManifestFile({
        jsonKeys: {
          [FILE]: {
            "/scripts/lint": hv("old"),
            "/scripts/dead": hv("d"),
            "/name": hv("acme"),
          },
        },
      });
      writePlan({
        jsonKeys: {
          [FILE]: [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: hv("old"),
              nextSha256: hv("new"),
            },
            {
              pointer: "/scripts/dead",
              class: "gone",
              recordedSha256: hv("d"),
            },
          ],
        },
      });

      expect(stamp().manifest.jsonKeys).toEqual({
        [FILE]: { "/scripts/lint": hv("old"), "/name": hv("acme") },
      });
    });

    it("drops the file's jsonKeys entry too when its files entry is dropped as gone", () => {
      writeManifestFile({
        files: { [FILE]: emitted("v1") },
        jsonKeys: { [FILE]: { "/scripts/lint": hv("old") } },
      });
      writePlan({
        files: [{ path: FILE, class: "gone", recordedSha256: h("v1") }],
      });

      const manifest = stamp().manifest;

      expect(Object.hasOwn(manifest.files, FILE)).toBe(false);
      expect(Object.hasOwn(manifest.jsonKeys, FILE)).toBe(false);
    });

    it("keeps the jsonKeys entry when a gone file is in fact present", () => {
      writeManifestFile({
        files: { [FILE]: emitted("v1") },
        jsonKeys: { [FILE]: { "/scripts/lint": hv("old") } },
      });
      writeProjectFile(FILE, "{}");
      writePlan({
        files: [{ path: FILE, class: "gone", recordedSha256: h("v1") }],
      });

      const manifest = stamp().manifest;

      expect(manifest.files[FILE]).toEqual(merged("v1"));
      expect(manifest.jsonKeys[FILE]).toEqual({ "/scripts/lint": hv("old") });
    });

    function expectUnreadable(text: string): void {
      writeManifestFile({
        jsonKeys: { [FILE]: { "/scripts/lint": hv("old") } },
      });
      writeProjectFile(FILE, text);
      writePlan({
        jsonKeys: {
          [FILE]: [
            {
              pointer: "/scripts/lint",
              class: "safe-update",
              recordedSha256: hv("old"),
              nextSha256: hv("new"),
            },
          ],
        },
      });
      const before = snapshotTree(project);

      const error = thrownBy(() => stamp());

      expect(error).toBeInstanceOf(UpgradeStampError);
      expect((error as UpgradeStampError).code).toBe("unreadable-file");
      expect((error as UpgradeStampError).message).toBe(
        `could not hash the JSON keys of ${FILE}`,
      );
      expect((error as UpgradeStampError).cause).toBeDefined();
      expect(snapshotTree(project)).toEqual(before);
    }

    it("throws unreadable-file, chaining the cause, for a present file that does not parse", () => {
      expectUnreadable("{ broken");
    });

    it("throws unreadable-file for a file nested deeper than the stack allows", () => {
      expectUnreadable(`${'{"a":'.repeat(20000)}1${"}".repeat(20000)}`);
    });
  });

  describe("plan.json versions and unknown keys", () => {
    function expectInvalid(
      overrides: Record<string, unknown>,
      leak?: string,
    ): void {
      writeManifestFile();
      writePlan(overrides);
      const before = snapshotTree(project);
      const error = thrownBy(() => stamp());
      expect(error).toBeInstanceOf(UpgradeStampError);
      expect((error as UpgradeStampError).code).toBe("invalid-plan");
      expect((error as UpgradeStampError).message).toContain("plan.json");
      if (leak !== undefined) {
        expect((error as UpgradeStampError).message).not.toContain(leak);
      }
      expect(snapshotTree(project)).toEqual(before);
    }

    it.each([
      ["a leading v", "v1.0.0"],
      ["two parts", "1.0"],
      ["a newline", "1.0.0\nSECRET-LINE"],
      ["an escape code", "\u001b[31m1.0.0"],
      ["trailing text", "1.0.0 SECRET-TAIL"],
    ])("refuses a fromCliVersion with %s without quoting it", (_n, value) => {
      expectInvalid({ fromCliVersion: value }, "SECRET");
    });

    it.each([
      ["a leading v", "v2.0.0"],
      ["a newline", "2.0.0\nSECRET-LINE"],
      ["an escape code", "\u001b[31m2.0.0"],
    ])("refuses a toCliVersion with %s without quoting it", (_n, value) => {
      expectInvalid({ toCliVersion: value }, "SECRET");
    });

    it("accepts prerelease and build suffixes", () => {
      writeManifestFile({ cliVersion: "1.2.3-rc.1+build.5" });
      writePlan({
        fromCliVersion: "1.2.3-rc.1+build.5",
        toCliVersion: "2.0.0-beta.1+exp.sha.5114f85",
      });
      expect(stamp().manifest.cliVersion).toBe("2.0.0-beta.1+exp.sha.5114f85");
    });

    it.each<[string, Record<string, unknown>]>([
      ["the top level", { "SECRET-KEY-XYZ": 1 }],
      [
        "a files entry",
        { files: [{ path: "a.txt", class: "add", "SECRET-KEY-XYZ": 1 }] },
      ],
      [
        "a jsonKeys entry",
        {
          jsonKeys: {
            "a.json": [{ pointer: "/a", class: "add", "SECRET-KEY-XYZ": 1 }],
          },
        },
      ],
      [
        "a staged entry",
        {
          staged: [
            { path: "a", staged: "b", sha256: "c", "SECRET-KEY-XYZ": 1 },
          ],
        },
      ],
    ])("refuses an unknown key in %s without echoing the key", (_n, o) => {
      expectInvalid(o, "SECRET-KEY-XYZ");
    });
  });

  describe("plan validation refusals", () => {
    const GOOD = h("x");
    const file = (extra: Record<string, unknown>): Record<string, unknown> => ({
      path: "a.txt",
      class: "add",
      nextSha256: GOOD,
      ...extra,
    });

    function expectInvalid(text: string): void {
      writeManifestFile();
      writePlanText(text);
      const before = snapshotTree(project);
      const error = thrownBy(() => stamp());
      expect(error).toBeInstanceOf(UpgradeStampError);
      expect((error as UpgradeStampError).code).toBe("invalid-plan");
      expect((error as UpgradeStampError).message).toContain("plan.json");
      expect(snapshotTree(project)).toEqual(before);
    }
    const planText = (overrides: Record<string, unknown>): string =>
      JSON.stringify(basePlan(overrides));

    it.each<[string, Record<string, unknown>]>([
      ["an unknown class", { files: [file({ class: "bogus" })] }],
      ["a non-hex sha256", { files: [file({ nextSha256: "xyz" })] }],
      [
        "an uppercase sha256",
        { files: [file({ nextSha256: GOOD.toUpperCase() })] },
      ],
      ["a non-string currentSha256", { files: [file({ currentSha256: 5 })] }],
      ["an absolute path", { files: [file({ path: "/etc/passwd" })] }],
      ["a path leaving the project", { files: [file({ path: "../x" })] }],
      ["an empty path", { files: [file({ path: "" })] }],
      ["a duplicate path", { files: [file({}), file({})] }],
      [
        "a jsonKeys path leaving the project",
        { jsonKeys: { "../x.json": [] } },
      ],
      [
        "a pointer without a leading slash",
        { jsonKeys: { "a.json": [{ pointer: "a", class: "add" }] } },
      ],
      [
        "a duplicate pointer",
        {
          jsonKeys: {
            "a.json": [
              { pointer: "/a", class: "add" },
              { pointer: "/a", class: "add" },
            ],
          },
        },
      ],
      [
        "an unknown class in a jsonKeys entry",
        { jsonKeys: { "a.json": [{ pointer: "/a", class: "bogus" }] } },
      ],
      [
        "a staged entry with a non-string field",
        { staged: [{ path: 1, staged: "b", sha256: "c" }] },
      ],
      [
        "a staged entry missing a field",
        { staged: [{ path: "a", staged: "b" }] },
      ],
      ["a staged entry that is not an object", { staged: ["a"] }],
      ["a non-string pack", { packs: [1] }],
    ])("refuses %s", (_n, overrides) => {
      expectInvalid(planText(overrides));
    });

    it("refuses a prototype-sensitive key at the top level", () => {
      expectInvalid(`{"__proto__":{},${planText({}).slice(1)}`);
    });

    it("refuses a token with a non-string value without naming the token", () => {
      writeManifestFile();
      writePlan({ tokens: { ...TOKENS, SECRET_KEY_NAME: 5 } });
      const error = thrownBy(() => stamp());
      expect(error).toBeInstanceOf(UpgradeStampError);
      expect((error as UpgradeStampError).code).toBe("invalid-plan");
      expect((error as UpgradeStampError).message).toContain("plan.json");
      expect((error as UpgradeStampError).message).not.toContain(
        "SECRET_KEY_NAME",
      );
    });

    it("refuses a prototype-sensitive token name", () => {
      const tokens = JSON.parse(
        '{"PROJECT_NAME":"acme","YEAR":"1999","__proto__":"x"}',
      ) as unknown;
      expectInvalid(planText({ tokens }));
    });

    it("refuses a prototype-sensitive key in a files entry", () => {
      const entry = JSON.parse(
        '{"path":"a.txt","class":"add","__proto__":{}}',
      ) as unknown;
      expectInvalid(planText({ files: [entry] }));
    });

    it("refuses a prototype-sensitive jsonKeys path", () => {
      const jsonKeys = JSON.parse('{"__proto__":[]}') as unknown;
      expectInvalid(planText({ jsonKeys }));
    });

    it("refuses a staging directory that is a symlink, even to a valid plan", () => {
      writeManifestFile();
      const real = join(project, "real-upgrade");
      mkdirSync(real);
      writeFileSync(join(real, "plan.json"), JSON.stringify(basePlan()));
      symlinkSync(real, join(project, ".groundwork", "upgrade"));
      const before = snapshotTree(project);

      const error = thrownBy(() => stamp());

      expect(error).toBeInstanceOf(UpgradeStampError);
      expect((error as UpgradeStampError).code).toBe("invalid-plan");
      expect((error as UpgradeStampError).message).toMatch(/upgrade/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("reports the codes of the missing manifest and plan", () => {
      writePlan();
      expect(thrownCode(() => stamp())).toBe("no-manifest");
      rmSync(join(project, ".groundwork", "upgrade"), { recursive: true });
      writeManifestFile();
      expect(thrownCode(() => stamp())).toBe("no-plan");
    });
  });

  describe("the project walk", () => {
    const addPlan = (path: string): void => {
      writeManifestFile();
      writePlan({
        files: [{ path, class: "add", nextSha256: h("n") }],
      });
    };
    const asRoot = process.getuid?.() === 0;

    it("treats a missing ancestor directory as an absent file", () => {
      addPlan("nodir/deeper/f.txt");
      expect(Object.keys(stamp().manifest.files)).toEqual([]);
    });

    it("refuses a symlinked ancestor directory, naming it", () => {
      addPlan("sub/f.txt");
      mkdirSync(join(project, "real"));
      writeFileSync(join(project, "real", "f.txt"), "n");
      symlinkSync(join(project, "real"), join(project, "sub"));
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(/sub/);
      expect(() => stamp()).toThrow(/symlink|not a directory/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses an ancestor that is a regular file", () => {
      addPlan("sub/f.txt");
      writeProjectFile("sub", "a file");
      expect(() => stamp()).toThrow(/sub/);
    });

    it("refuses a listed file that is a symlink", () => {
      addPlan("f.txt");
      writeProjectFile("target.txt", "n");
      symlinkSync(join(project, "target.txt"), join(project, "f.txt"));
      const before = snapshotTree(project);

      expect(() => stamp()).toThrow(/f\.txt/);
      expect(() => stamp()).toThrow(/symlink|regular file/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a listed file that is a directory", () => {
      addPlan("f.txt");
      mkdirSync(join(project, "f.txt"));
      expect(() => stamp()).toThrow(/regular file/);
    });

    it("refuses a JSON file that is a symlink", () => {
      writeManifestFile();
      writePlan({
        jsonKeys: { "package.json": [{ pointer: "/a", class: "add" }] },
      });
      writeProjectFile("real.json", "{}");
      symlinkSync(join(project, "real.json"), join(project, "package.json"));

      expect(() => stamp()).toThrow(/package\.json/);
    });

    it.skipIf(asRoot)(
      "reports an unreadable listed file, chaining the cause",
      () => {
        addPlan("f.txt");
        writeProjectFile("f.txt", "n");
        chmodSync(join(project, "f.txt"), 0o000);
        try {
          const error = thrownBy(() => stamp());
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/could not read f\.txt/);
          expect((error as Error).cause).toBeDefined();
        } finally {
          chmodSync(join(project, "f.txt"), 0o644);
        }
      },
    );

    it.skipIf(asRoot)(
      "reports an lstat failure that is not 'absent', chaining the cause",
      () => {
        addPlan("d/f.txt");
        writeProjectFile("d/f.txt", "n");
        chmodSync(join(project, "d"), 0o000);
        try {
          const error = thrownBy(() => stamp());
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(
            /could not inspect d\/f\.txt/,
          );
          expect((error as Error).cause).toBeDefined();
        } finally {
          chmodSync(join(project, "d"), 0o755);
        }
      },
    );

    it.skipIf(asRoot)(
      "reports an unreadable plan.json as invalid-plan with the cause",
      () => {
        writeManifestFile();
        writePlan();
        chmodSync(planPath(), 0o000);
        try {
          const error = thrownBy(() => stamp());
          expect(error).toBeInstanceOf(UpgradeStampError);
          expect((error as UpgradeStampError).code).toBe("invalid-plan");
          expect((error as UpgradeStampError).message).toMatch(
            /could not read/,
          );
          expect((error as UpgradeStampError).cause).toBeDefined();
        } finally {
          chmodSync(planPath(), 0o644);
        }
      },
    );
  });
});
