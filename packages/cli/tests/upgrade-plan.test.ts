// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import type { UpgradeClass } from "../src/upgrade/classify.js";
import { computePlan, renderRelease } from "../src/upgrade/plan.js";
import type { RenderedRelease, UpgradePlan } from "../src/upgrade/plan.js";
import {
  buildProject,
  snapshotTree,
  writeRelease,
} from "./upgrade-plan-fixture.js";
import type { FixtureRelease, WrittenRelease } from "./upgrade-plan-fixture.js";

// chmod does not deny access to root or on Windows, so those tests skip there.
const cannotChmod = process.platform === "win32" || process.getuid?.() === 0;

const h = sha256Hex;
const hj = (value: unknown): string => h(JSON.stringify(value));

const OLD_PACKAGE = `${JSON.stringify(
  {
    name: "__PROJECT_NAME__",
    scripts: { lint: "eslint .", build: "tsc" },
    devDependencies: { typescript: "5.0.0", vitest: "1.0.0" },
  },
  null,
  2,
)}\n`;
const NEW_PACKAGE = `${JSON.stringify(
  {
    name: "__PROJECT_NAME__",
    scripts: { lint: "eslint .", build: "tsc", test: "vitest" },
    devDependencies: { typescript: "5.1.0" },
  },
  null,
  2,
)}\n`;

const OLD: FixtureRelease = {
  core: {
    "package.json": OLD_PACKAGE,
    "tsconfig.json": '{"compilerOptions":{"target":"ES2022"}}\n',
    "tsconfig.build.json": "[]\n",
    "a.txt": "a v1\n",
    "b.txt": "b v1\n",
    "c.txt": "c v1\n",
    "e.txt": "e v1\n",
    "f.txt": "f v1\n",
    "g.txt": "g v1\n",
    "h.txt": "h v1\n",
    "m.txt": "m v1\n",
    "j.txt": "j v1 __YEAR__\n",
    LICENSE: "Copyright __YEAR__ __PROJECT_NAME__\n",
    "docs/guide.md": "guide v1\n",
  },
  packs: {
    extras: {
      files: { "extra.mjs": "extra v1\n" },
      scripts: { extra: "node extra.mjs" },
    },
  },
};

const NEW: FixtureRelease = {
  core: {
    "package.json": NEW_PACKAGE,
    "tsconfig.json": '{"compilerOptions":{"target":"ES2022","strict":true}}\n',
    "tsconfig.build.json": "[]\n",
    "a.txt": "a v2\n",
    "b.txt": "b v1\n",
    "c.txt": "c v2\n",
    "d.txt": "d v1\n",
    "g.txt": "g v1\n",
    "m.txt": "m v2\n",
    "j.txt": "j v2 __YEAR__\n",
    LICENSE: "Copyright __YEAR__ __PROJECT_NAME__\n",
    "docs/guide.md": "guide v1\n",
  },
  packs: {
    extras: {
      files: { "extra.mjs": "extra v2\n" },
      scripts: { extra: "node extra.mjs" },
    },
  },
};

const TOKENS = { PROJECT_NAME: "acme", YEAR: "1999" };

function classOf(plan: UpgradePlan, path: string): UpgradeClass | undefined {
  return plan.files.find((entry) => entry.path === path)?.class;
}

describe("renderRelease and computePlan", () => {
  let base: string;
  let project: string;
  let tmpRoot: string;
  let oldRelease: WrittenRelease;
  let newRelease: WrittenRelease;
  let manifest: Manifest;
  let rendered: RenderedRelease | undefined;

  const render = (
    written: WrittenRelease = newRelease,
    m: Manifest = manifest,
  ): RenderedRelease => {
    rendered = renderRelease({
      manifest: m,
      cliVersion: "2.0.0",
      templatesDir: written.templatesDir,
      packsRoot: written.packsRoot,
      tmpRoot,
    });
    return rendered;
  };
  const plan = (release: RenderedRelease = render()): UpgradePlan =>
    computePlan({
      targetDir: project,
      manifest,
      release,
      cliVersion: "2.0.0",
    });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "upgrade-plan-test-"));
    project = join(base, "project");
    tmpRoot = join(base, "tmp");
    mkdirSync(tmpRoot);
    oldRelease = writeRelease(join(base, "old"), OLD);
    newRelease = writeRelease(join(base, "new"), NEW);
    manifest = buildProject({
      written: oldRelease,
      packNames: ["extras"],
      targetDir: project,
      tokens: TOKENS,
      cliVersion: "1.0.0",
    });
    rendered = undefined;
  });

  afterEach(() => {
    rendered?.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  /** Applies the local edits and manifest tweaks the class scenarios need. */
  function scenario(): void {
    writeFileSync(join(project, "b.txt"), "b mine\n");
    writeFileSync(join(project, "c.txt"), "c mine\n");
    writeFileSync(join(project, "f.txt"), "f mine\n");
    rmSync(join(project, "g.txt"));
    rmSync(join(project, "h.txt"));
    writeFileSync(join(project, "stray.txt"), "mine\n");
    const pkg = JSON.parse(
      readFileSync(join(project, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    pkg.scripts["lint"] = "eslint src";
    writeFileSync(join(project, "package.json"), JSON.stringify(pkg, null, 2));
    manifest.files["m.txt"] = { sha256: h("m v1\n"), origin: "merged" };
    Reflect.deleteProperty(manifest.jsonKeys, "tsconfig.json");
  }

  describe("renderRelease", () => {
    it("renders the release with the manifest's tokens into a fresh temp dir under tmpRoot", () => {
      const release = render();

      expect(release.dir.startsWith(tmpRoot)).toBe(true);
      expect(release.dir.slice(tmpRoot.length + 1)).toMatch(
        /^groundwork-upgrade-/,
      );
      expect(readFileSync(join(release.dir, "j.txt"), "utf8")).toBe(
        "j v2 1999\n",
      );
      expect(readFileSync(join(release.dir, "extra.mjs"), "utf8")).toBe(
        "extra v2\n",
      );
    });

    it("builds the next manifest from the rendered files, packs included, hand-pinned", () => {
      const release = render();

      expect(release.manifest.cliVersion).toBe("2.0.0");
      expect(release.manifest.tokens).toEqual(TOKENS);
      expect(release.manifest.packs).toEqual(["extras"]);
      expect(Object.keys(release.manifest.files)).toEqual([
        "LICENSE",
        "a.txt",
        "b.txt",
        "c.txt",
        "d.txt",
        "docs/guide.md",
        "extra.mjs",
        "g.txt",
        "j.txt",
        "m.txt",
        "package.json",
        "tsconfig.build.json",
        "tsconfig.json",
      ]);
      expect(release.manifest.files["j.txt"]).toEqual({
        sha256: h("j v2 1999\n"),
        origin: "emitted",
      });
      expect(release.manifest.files["extra.mjs"]?.sha256).toBe(h("extra v2\n"));
      expect(
        Object.keys(release.manifest.jsonKeys["package.json"] ?? {}),
      ).toContain("/scripts/extra");
    });

    it("lists a file once even when a pack rewrites a baseline path", () => {
      const clash = writeRelease(join(base, "clash"), {
        core: NEW.core,
        packs: {
          extras: {
            files: { "a.txt": "a pack\n", "extra.mjs": "x\n" },
            scripts: { extra: "node extra.mjs" },
          },
        },
      });
      const release = render(clash);

      expect(release.manifest.files["a.txt"]?.sha256).toBe(h("a pack\n"));
      expect(
        Object.keys(release.manifest.files).filter((p) => p === "a.txt"),
      ).toHaveLength(1);
    });

    it("writes nothing outside its own temp dir and leaves nothing after dispose, idempotently", () => {
      const before = snapshotTree(base);
      const release = render();

      expect(readdirSync(tmpRoot)).toHaveLength(1);
      const outside = (tree: Record<string, string>): Record<string, string> =>
        Object.fromEntries(
          Object.entries(tree).filter(([path]) => !path.startsWith("tmp")),
        );
      expect(outside(snapshotTree(base))).toEqual(outside(before));

      release.dispose();
      expect(readdirSync(tmpRoot)).toEqual([]);
      expect(existsSync(release.dir)).toBe(false);
      expect(() => {
        release.dispose();
      }).not.toThrow();
    });

    it("throws naming a pack recorded in the manifest but missing from the release, leaving tmpRoot empty", () => {
      const ghostManifest: Manifest = {
        ...manifest,
        packs: ["extras", "ghost"],
      };

      let thrown: unknown;
      try {
        render(newRelease, ghostManifest);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("ghost");
      expect(message).toContain("manifest");
      expect(message).toContain("missing");
      expect(readdirSync(tmpRoot)).toEqual([]);
    });

    it("cleans tmpRoot and keeps the original as cause when a pack's requires.paths is missing", () => {
      const broken = writeRelease(join(base, "broken"), {
        core: NEW.core,
        packs: {
          extras: {
            files: { "extra.mjs": "x\n" },
            scripts: { extra: "node extra.mjs" },
            requires: ["does/not/exist.mjs"],
          },
        },
      });

      let thrown: unknown;
      try {
        render(broken);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toContain("does/not/exist.mjs");
      expect(readdirSync(tmpRoot)).toEqual([]);
    });
  });

  describe("computePlan classification", () => {
    it.each<[string, UpgradeClass]>([
      ["a.txt", "safe-update"],
      ["b.txt", "local-only"],
      ["c.txt", "conflict-3way"],
      ["d.txt", "add"],
      ["e.txt", "remove"],
      ["f.txt", "orphan-edited"],
      ["g.txt", "user-deleted"],
      ["h.txt", "gone"],
      ["m.txt", "conflict-2way"],
      ["LICENSE", "current"],
      ["docs/guide.md", "current"],
      ["j.txt", "safe-update"],
      ["extra.mjs", "safe-update"],
      ["package.json", "conflict-3way"],
      ["tsconfig.json", "safe-update"],
      ["tsconfig.build.json", "current"],
    ])("classifies %s as %s", (path, expected) => {
      scenario();

      expect(classOf(plan(), path)).toBe(expected);
    });

    it("never lists a project file that is in neither manifest nor release", () => {
      scenario();

      const paths = plan().files.map((entry) => entry.path);

      // Old manifest: 14 baseline files + extra.mjs; the release adds d.txt.
      // .claude/settings.json (written by installPack) is in neither.
      expect(paths).toEqual([
        "LICENSE",
        "a.txt",
        "b.txt",
        "c.txt",
        "d.txt",
        "docs/guide.md",
        "e.txt",
        "extra.mjs",
        "f.txt",
        "g.txt",
        "h.txt",
        "j.txt",
        "m.txt",
        "package.json",
        "tsconfig.build.json",
        "tsconfig.json",
      ]);
    });

    it("uses the manifest's tokens, not the current year, for the next hash", () => {
      scenario();

      const entry = plan().files.find((e) => e.path === "j.txt");

      expect(entry).toEqual({
        path: "j.txt",
        class: "safe-update",
        recordedSha256: h("j v1 1999\n"),
        currentSha256: h("j v1 1999\n"),
        nextSha256: h("j v2 1999\n"),
      });
    });

    it("records the three hashes only when each exists, as own properties", () => {
      scenario();
      const result = plan();
      const entry = (path: string) =>
        result.files.find((e) => e.path === path) as Record<string, unknown>;

      expect(Object.hasOwn(entry("d.txt"), "recordedSha256")).toBe(false);
      expect(Object.hasOwn(entry("d.txt"), "currentSha256")).toBe(false);
      expect(entry("d.txt")["nextSha256"]).toBe(h("d v1\n"));
      expect(Object.hasOwn(entry("g.txt"), "currentSha256")).toBe(false);
      expect(entry("g.txt")["recordedSha256"]).toBe(h("g v1\n"));
      expect(Object.hasOwn(entry("h.txt"), "nextSha256")).toBe(false);
      expect(Object.hasOwn(entry("h.txt"), "currentSha256")).toBe(false);
      expect(entry("e.txt")["currentSha256"]).toBe(h("e v1\n"));
    });

    it("copies versions, tokens and packs, and sorts files by code unit", () => {
      scenario();
      const result = plan();

      expect(result.schemaVersion).toBe(1);
      expect(result.fromCliVersion).toBe("1.0.0");
      expect(result.toCliVersion).toBe("2.0.0");
      expect(result.tokens).toEqual(TOKENS);
      expect(result.packs).toEqual(["extras"]);
      const paths = result.files.map((entry) => entry.path);
      expect(paths[0]).toBe("LICENSE");
      expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : 1)));
    });

    it("classifies JSON keys per key, within the same file", () => {
      scenario();

      const keys = plan().jsonKeys["package.json"];

      expect(keys).toEqual([
        {
          pointer: "/devDependencies/typescript",
          class: "safe-update",
          recordedSha256: hj("5.0.0"),
          currentSha256: hj("5.0.0"),
          nextSha256: hj("5.1.0"),
        },
        {
          pointer: "/devDependencies/vitest",
          class: "remove",
          recordedSha256: hj("1.0.0"),
          currentSha256: hj("1.0.0"),
        },
        {
          pointer: "/name",
          class: "current",
          recordedSha256: hj("acme"),
          currentSha256: hj("acme"),
          nextSha256: hj("acme"),
        },
        {
          pointer: "/scripts/build",
          class: "current",
          recordedSha256: hj("tsc"),
          currentSha256: hj("tsc"),
          nextSha256: hj("tsc"),
        },
        {
          pointer: "/scripts/extra",
          class: "current",
          recordedSha256: hj("node extra.mjs"),
          currentSha256: hj("node extra.mjs"),
          nextSha256: hj("node extra.mjs"),
        },
        {
          pointer: "/scripts/lint",
          class: "local-only",
          recordedSha256: hj("eslint ."),
          currentSha256: hj("eslint src"),
          nextSha256: hj("eslint ."),
        },
        {
          pointer: "/scripts/test",
          class: "add",
          nextSha256: hj("vitest"),
        },
      ]);
    });

    it("gives add entries for keys of a file whose manifest recorded no jsonKeys", () => {
      scenario();

      const keys = plan().jsonKeys["tsconfig.json"];

      expect(keys).toEqual([
        {
          pointer: "/compilerOptions/strict",
          class: "add",
          nextSha256: hj(true),
        },
        {
          pointer: "/compilerOptions/target",
          class: "current",
          currentSha256: hj("ES2022"),
          nextSha256: hj("ES2022"),
        },
      ]);
    });

    it("holds jsonKeys only for files with a pointer in recorded or next", () => {
      scenario();

      const result = plan();

      expect(Object.keys(result.jsonKeys).sort()).toEqual([
        "package.json",
        "tsconfig.json",
      ]);
      expect(Object.hasOwn(result.jsonKeys, "tsconfig.build.json")).toBe(false);
    });

    it("treats an absent JSON file as an empty current map", () => {
      scenario();
      rmSync(join(project, "package.json"));

      const keys = plan().jsonKeys["package.json"] ?? [];

      expect(keys.length).toBeGreaterThan(0);
      expect(
        keys.every((entry) => !Object.hasOwn(entry, "currentSha256")),
      ).toBe(true);
      expect(keys.find((k) => k.pointer === "/name")?.class).toBe(
        "user-deleted",
      );
      expect(keys.find((k) => k.pointer === "/scripts/test")?.class).toBe(
        "add",
      );
    });
  });

  describe("computePlan safety and failures", () => {
    it("leaves the project tree byte-identical", () => {
      scenario();
      symlinkSync("a.txt", join(project, "stray-link"));
      const before = snapshotTree(project);

      plan();

      expect(snapshotTree(project)).toEqual(before);
    });

    it("is deterministic and JSON-serialisable without loss", () => {
      scenario();
      const release = render();

      const first = plan(release);
      const second = plan(release);

      expect(second).toStrictEqual(first);
      expect(JSON.parse(JSON.stringify(first)) as unknown).toStrictEqual(first);
    });

    it("throws naming a managed file that is a symlink", () => {
      writeFileSync(join(project, "elsewhere.txt"), "a v1\n");
      rmSync(join(project, "a.txt"));
      symlinkSync("elsewhere.txt", join(project, "a.txt"));
      const release = render();
      const before = snapshotTree(project);

      expect(() => plan(release)).toThrowError(/a\.txt/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("throws naming a managed file under a symlinked directory", () => {
      renameSync(join(project, "docs"), join(project, "docs-real"));
      symlinkSync("docs-real", join(project, "docs"));
      const release = render();
      const before = snapshotTree(project);

      expect(() => plan(release)).toThrowError(/docs\/guide\.md/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("throws naming a directory where a managed file is expected", () => {
      rmSync(join(project, "a.txt"));
      mkdirSync(join(project, "a.txt"));
      const release = render();
      const before = snapshotTree(project);

      expect(() => plan(release)).toThrowError(/a\.txt/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("names an unparseable current package.json without leaking its text", () => {
      const secret = ["sk", "live", "0123456789abcdef"].join("_");
      writeFileSync(
        join(project, "package.json"),
        `{"name": "acme", "apiToken": "${secret}" oops`,
      );
      const release = render();

      let thrown: unknown;
      try {
        plan(release);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("package.json");
      const seen: string[] = [];
      let link: unknown = thrown;
      for (let depth = 0; depth < 10 && link !== undefined; depth++) {
        // A cause need not be an Error (a parser may chain a bare string).
        seen.push(JSON.stringify(link) ?? "");
        if (!(link instanceof Error)) break;
        seen.push(link.message, String(link.stack ?? ""));
        link = link.cause;
      }
      expect(seen.length).toBeGreaterThan(0);
      // The chain must end at the thrown error itself: no cause at all.
      expect((thrown as Error).cause).toBeUndefined();
      for (const text of seen) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain("apiToken");
      }
    });
  });

  describe("renderRelease temp dir and computePlan read failures", () => {
    it("uses the system temp dir when tmpRoot is omitted, and dispose removes it", () => {
      const release = renderRelease({
        manifest,
        cliVersion: "2.0.0",
        templatesDir: newRelease.templatesDir,
        packsRoot: newRelease.packsRoot,
      });
      try {
        expect(realpathSync(dirname(release.dir))).toBe(realpathSync(tmpdir()));
        expect(release.dir.split("/").pop()).toMatch(/^groundwork-upgrade-/);
        expect(existsSync(join(release.dir, "a.txt"))).toBe(true);
      } finally {
        release.dispose();
      }
      expect(existsSync(release.dir)).toBe(false);
    });

    it.each(["missing", "file"])(
      "throws with a cause when tmpRoot is unusable (%s)",
      (kind) => {
        const bad = join(base, "not-a-dir");
        if (kind === "file") writeFileSync(bad, "x");
        let thrown: unknown;
        try {
          renderRelease({
            manifest,
            cliVersion: "2.0.0",
            templatesDir: newRelease.templatesDir,
            packsRoot: newRelease.packsRoot,
            tmpRoot: bad,
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(bad);
        expect((thrown as Error).cause).toBeInstanceOf(Error);
      },
    );

    it("classifies a file whose ancestor directory is missing as absent", () => {
      rmSync(join(project, "docs"), { recursive: true });

      const entry = plan().files.find((e) => e.path === "docs/guide.md");

      expect(entry?.class).toBe("user-deleted");
      expect(Object.hasOwn(entry ?? {}, "currentSha256")).toBe(false);
    });

    it.each([
      "/etc/hosts",
      "a\\b.txt",
      "docs//guide.md",
      "./a.txt",
      "docs/../a.txt",
      "../outside.txt",
    ])("refuses the recorded path %j before reading anything", (bad) => {
      writeFileSync(join(base, "outside.txt"), "outside\n");
      const release = render();
      const control = plan(release);
      expect(control.files.length).toBeGreaterThan(0);
      manifest.files[bad] = { sha256: h("outside\n"), origin: "emitted" };

      let thrown: unknown;
      try {
        plan(release);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(JSON.stringify(bad));
    });

    it.skipIf(cannotChmod)(
      "throws naming the path when lstat fails for a reason other than absence (unsearchable directory)",
      () => {
        const release = render();
        chmodSync(join(project, "docs"), 0o000);
        try {
          expect(() => plan(release)).toThrowError(/docs\/guide\.md/);
        } finally {
          chmodSync(join(project, "docs"), 0o755);
        }
      },
    );

    it.skipIf(cannotChmod)(
      "throws naming the path when a regular file cannot be read",
      () => {
        const release = render();
        chmodSync(join(project, "a.txt"), 0o000);
        let thrown: unknown;
        try {
          plan(release);
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(join(project, "a.txt"), 0o644);
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("a.txt");
        expect((thrown as Error).cause).toBeInstanceOf(Error);
      },
    );
  });
});
