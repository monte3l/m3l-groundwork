// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `stagePacks` copies every pack's `pack.json` + `files/` tree, unmodified,
 * into `<groundworkDir>/packs/<name>/`, each file under a neutral
 * `<path>.staged` name -- the inert, atomic twin of `baseline-stage.ts`'s
 * `stageBaselineAdditions`, now covering every pack adopt mode surveys in one
 * atomic swap rather than one pack at a time. Mirrors
 * `baseline-stage.test.ts`'s structure one-to-one; failure modes that need a
 * mocked `node:fs` primitive live in their own isolated sibling files (see
 * `pack-stage-swap-restore.test.ts`, `pack-stage-write-failure.test.ts`,
 * `pack-stage-cleanup-warn.test.ts`,
 * `pack-stage-empty-list-cleanup-failure.test.ts`,
 * `pack-stage-assertion-rethrow.test.ts`), the same isolation pattern
 * `baseline-stage.test.ts`'s own header comment documents.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, matchesGlob, relative } from "node:path";
import type { CapCounts } from "../src/caps.js";
import { listPackNames, loadPack } from "../src/packs.js";
import type { Pack, PackManifest } from "../src/packs.js";
import {
  STAGED_PACKS_DIR,
  STAGED_PACK_MANIFEST,
  plannedPackStagingPaths,
  stagePacks,
} from "../src/pack-stage.js";
import type { StagedPack, StagedPackFile } from "../src/pack-stage.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `root`, relative to it, sorted. */
function listFiles(root: string): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      results.push(relative(root, absPath));
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return results.sort();
}

const EMPTY_BUDGET: CapCounts = {
  agents: 0,
  skills: 0,
  hooks: 0,
  workflows: 0,
  scripts: 0,
};

function makeManifest(
  name: string,
  overrides: Partial<PackManifest> = {},
): PackManifest {
  return {
    schemaVersion: 1,
    name,
    description: `the ${name} test pack`,
    modes: ["fresh", "adopt"],
    budget: EMPTY_BUDGET,
    requires: undefined,
    wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
    adoptNotes: undefined,
    ...overrides,
  };
}

/** Builds an in-memory `Pack` pointing at a real `filesDir` on disk -- no `pack.json` file is ever written for these tests, since `stagePacks` takes `Pack[]` objects directly, never pack names. */
function makePack(
  name: string,
  filesDir: string,
  overrides: Partial<PackManifest> = {},
): Pack {
  return { manifest: makeManifest(name, overrides), filesDir };
}

describe("stagePacks", () => {
  it("exports the staging subdir and manifest file name as constants", () => {
    expect(STAGED_PACKS_DIR).toBe(".groundwork/packs");
    expect(STAGED_PACK_MANIFEST).toBe("pack.json");
  });

  it("stages pack.json and the files/ tree unmodified, each under <path>.staged, with dir/suffix matching the literal .groundwork/packs/<name> convention, restoring a dotfile name and leaving no unsuffixed file", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-gw-"));
    try {
      mkdirSync(join(filesRoot, "src", "deep"), { recursive: true });
      writeFileSync(join(filesRoot, "a.txt"), "a\n");
      writeFileSync(join(filesRoot, "src", "deep", "b.ts"), "export {};\n");
      writeFileSync(join(filesRoot, "_gitignore"), "node_modules\n");

      const pack = makePack("stage-me", filesRoot);
      const [staged] = stagePacks([pack], groundworkDir, {});

      expect(staged).toBeDefined();
      expect(staged?.name).toBe("stage-me");
      expect(staged?.dir).toBe(".groundwork/packs/stage-me");
      expect(staged?.suffix).toBe(".staged");
      expect(staged?.manifest.path).toBe("pack.json");
      expect(staged?.manifest.staged).toBe("pack.json.staged");

      const destDir = join(groundworkDir, "packs", "stage-me");
      const manifestBytes = Buffer.from(
        JSON.stringify(pack.manifest, null, 2) + "\n",
      );
      expect(staged?.manifest.sha256).toBe(sha256Hex(manifestBytes));
      expect(readFileSync(join(destDir, "pack.json.staged"))).toEqual(
        manifestBytes,
      );
      // No unsuffixed pack.json ever exists alongside the staged one.
      expect(existsSync(join(destDir, "pack.json"))).toBe(false);

      const paths = (staged?.files ?? [])
        .map((f: StagedPackFile) => f.path)
        .sort();
      expect(paths).toEqual([".gitignore", "a.txt", "src/deep/b.ts"].sort());

      for (const file of staged?.files ?? []) {
        expect(file.staged).toBe(`${file.path}.staged`);
        const onDisk = join(destDir, "files", file.staged);
        expect(existsSync(onDisk)).toBe(true);
        expect(file.sha256).toBe(sha256Hex(readFileSync(onDisk)));
        // The real, unsuffixed name never exists alongside it.
        expect(existsSync(join(destDir, "files", file.path))).toBe(false);
      }

      expect(listFiles(join(destDir, "files"))).toEqual(
        ["a.txt.staged", "src/deep/b.ts.staged", ".gitignore.staged"].sort(),
      );
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("computes each file's sha256 from the RAW source bytes (independently verified, not read back from the staged copy)", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-sha-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-sha-gw-"));
    try {
      const content = "hello pack\n";
      writeFileSync(join(filesRoot, "hello.txt"), content);
      const sourceBytes = readFileSync(join(filesRoot, "hello.txt"));
      const independentHash = sha256Hex(sourceBytes);

      const pack = makePack("sha-check", filesRoot);
      const [staged] = stagePacks([pack], groundworkDir, {});

      const entry = staged?.files.find(
        (f: StagedPackFile) => f.path === "hello.txt",
      );
      expect(entry).toBeDefined();
      expect(entry?.sha256).toBe(independentHash);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("stages a byte-identical copy of a binary file and a CRLF text file, each matching an independent sha256", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-bin-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-bin-gw-"));
    try {
      const binaryBytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0xff, 0x7f]);
      writeFileSync(join(filesRoot, "binary.bin"), binaryBytes);
      const crlfText = "line one\r\nline two\r\n";
      writeFileSync(join(filesRoot, "crlf.txt"), crlfText, "utf8");

      const pack = makePack("binary-crlf", filesRoot);
      const [staged] = stagePacks([pack], groundworkDir, {});

      const destDir = join(groundworkDir, "packs", "binary-crlf", "files");
      const binaryEntry = staged?.files.find(
        (f: StagedPackFile) => f.path === "binary.bin",
      );
      expect(binaryEntry).toBeDefined();
      const stagedBinary = readFileSync(
        join(destDir, binaryEntry?.staged ?? ""),
      );
      expect(stagedBinary.equals(binaryBytes)).toBe(true);
      expect(binaryEntry?.sha256).toBe(sha256Hex(binaryBytes));

      const crlfEntry = staged?.files.find(
        (f: StagedPackFile) => f.path === "crlf.txt",
      );
      expect(crlfEntry).toBeDefined();
      const stagedCrlf = readFileSync(join(destDir, crlfEntry?.staged ?? ""));
      expect(stagedCrlf.toString("utf8")).toBe(crlfText);
      expect(crlfEntry?.sha256).toBe(sha256Hex(Buffer.from(crlfText, "utf8")));
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("never substitutes tokens into staged file CONTENT, only into the install path", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-tok-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-tok-gw-"));
    try {
      writeFileSync(
        join(filesRoot, "__PROJECT_NAME__.txt"),
        "__PROJECT_NAME__",
      );
      const tokens = { PROJECT_NAME: "acme-corp" };

      const pack = makePack("token-pack", filesRoot);
      const [staged] = stagePacks([pack], groundworkDir, tokens);

      const entry = staged?.files.find(
        (f: StagedPackFile) => f.path === "acme-corp.txt",
      );
      expect(entry).toBeDefined();
      expect(entry?.staged).toBe("acme-corp.txt.staged");
      expect(
        readFileSync(
          join(
            groundworkDir,
            "packs",
            "token-pack",
            "files",
            "acme-corp.txt.staged",
          ),
          "utf8",
        ),
      ).toBe("__PROJECT_NAME__");
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("stages multiple packs together, each getting its own dir", () => {
    const rootA = mkdtempSync(join(tmpdir(), "pack-stage-multi-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "pack-stage-multi-b-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-multi-gw-"));
    try {
      writeFileSync(join(rootA, "a.txt"), "a\n");
      writeFileSync(join(rootB, "b.txt"), "b\n");
      const packA = makePack("pack-a", rootA);
      const packB = makePack("pack-b", rootB);

      const staged = stagePacks([packA, packB], groundworkDir, {});

      expect(staged.map((s: StagedPack) => s.name).sort()).toEqual([
        "pack-a",
        "pack-b",
      ]);
      expect(
        existsSync(
          join(groundworkDir, "packs", "pack-a", "files", "a.txt.staged"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(groundworkDir, "packs", "pack-b", "files", "b.txt.staged"),
        ),
      ).toBe(true);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("removes any previous packs/ and returns [] when the pack list is empty", () => {
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-empty-gw-"));
    try {
      mkdirSync(join(groundworkDir, "packs", "old-pack"), {
        recursive: true,
      });
      writeFileSync(
        join(groundworkDir, "packs", "old-pack", "pack.json.staged"),
        "{}",
      );

      const staged = stagePacks([], groundworkDir, {});

      expect(staged).toEqual([]);
      expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    } finally {
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("replaces previous staging wholesale: a pack no longer passed disappears, a stale file in a surviving pack is gone", () => {
    const rootA = mkdtempSync(join(tmpdir(), "pack-stage-replace-a-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-replace-gw-"));
    try {
      mkdirSync(join(rootA, "files"), { recursive: true });
      writeFileSync(join(rootA, "keep.txt"), "keep\n");
      writeFileSync(join(rootA, "drop.txt"), "drop\n");
      const packAv1 = makePack("evolve", rootA);
      stagePacks([packAv1], groundworkDir, {});
      expect(
        existsSync(
          join(groundworkDir, "packs", "evolve", "files", "drop.txt.staged"),
        ),
      ).toBe(true);

      // A newer version of "evolve" that dropped drop.txt, plus "gone"
      // disappears entirely because it's no longer in the list passed.
      const rootGone = mkdtempSync(join(tmpdir(), "pack-stage-replace-gone-"));
      writeFileSync(join(rootGone, "x.txt"), "x\n");
      const packGone = makePack("gone", rootGone);
      stagePacks([packGone], groundworkDir, {});
      rmSync(join(rootA, "drop.txt"));
      const packAv2 = makePack("evolve", rootA);
      stagePacks([packAv2], groundworkDir, {});

      expect(existsSync(join(groundworkDir, "packs", "gone"))).toBe(false);
      expect(
        existsSync(
          join(groundworkDir, "packs", "evolve", "files", "drop.txt.staged"),
        ),
      ).toBe(false);
      expect(
        existsSync(
          join(groundworkDir, "packs", "evolve", "files", "keep.txt.staged"),
        ),
      ).toBe(true);
      rmSync(rootGone, { recursive: true, force: true });
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  describe("atomic staging -- stale work dir sweep", () => {
    it("removes a stale .groundwork/.packs-* temp dir left by a crashed earlier run, without touching an unrelated directory or a .baseline-* sibling", () => {
      const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-stale-files-"));
      const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-stale-gw-"));
      try {
        mkdirSync(join(groundworkDir, ".packs-stale1", "x"), {
          recursive: true,
        });
        writeFileSync(
          join(groundworkDir, ".packs-stale1", "x", "leftover.txt"),
          "leftover\n",
        );
        mkdirSync(join(groundworkDir, ".baseline-stale2"), {
          recursive: true,
        });
        mkdirSync(join(groundworkDir, ".other"), { recursive: true });
        mkdirSync(join(groundworkDir, "baseline"), { recursive: true });

        writeFileSync(join(filesRoot, "only.txt"), "same\n");
        stagePacks([makePack("only", filesRoot)], groundworkDir, {});

        expect(existsSync(join(groundworkDir, ".packs-stale1"))).toBe(false);
        expect(existsSync(join(groundworkDir, ".baseline-stale2"))).toBe(true);
        expect(existsSync(join(groundworkDir, ".other"))).toBe(true);
        expect(existsSync(join(groundworkDir, "baseline"))).toBe(true);
      } finally {
        rmSync(filesRoot, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });

    it("stages normally when groundworkDir does not exist yet", () => {
      const filesRoot = mkdtempSync(
        join(tmpdir(), "pack-stage-missing-gw-files-"),
      );
      const groundworkDir = join(
        tmpdir(),
        `pack-stage-missing-${String(Date.now())}`,
      );
      try {
        expect(existsSync(groundworkDir)).toBe(false);
        writeFileSync(join(filesRoot, "only.txt"), "same\n");

        const staged = stagePacks(
          [makePack("only", filesRoot)],
          groundworkDir,
          {},
        );

        expect(staged.map((s: StagedPack) => s.name)).toEqual(["only"]);
        expect(
          existsSync(
            join(groundworkDir, "packs", "only", "files", "only.txt.staged"),
          ),
        ).toBe(true);
      } finally {
        rmSync(filesRoot, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });
  });

  describe("symlink guard", () => {
    let outsideDir: string;

    function freshOutsideDir(): string {
      return mkdtempSync(join(tmpdir(), "pack-stage-outside-"));
    }

    it("throws before writing or deleting anything when groundworkDir itself is a symlink", () => {
      outsideDir = freshOutsideDir();
      const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-sym-gw-"));
      try {
        writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch");
        rmSync(groundworkDir, { recursive: true, force: true });
        symlinkSync(outsideDir, groundworkDir, "dir");

        const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-sym-files-"));
        writeFileSync(join(filesRoot, "a.txt"), "a\n");

        expect(() =>
          stagePacks([makePack("p", filesRoot)], groundworkDir, {}),
        ).toThrow();
        expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
          "do not touch",
        );
        expect(existsSync(join(outsideDir, "packs"))).toBe(false);
        rmSync(filesRoot, { recursive: true, force: true });
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("throws before writing or deleting anything when <groundworkDir>/packs is a symlink", () => {
      outsideDir = freshOutsideDir();
      const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-sym2-gw-"));
      try {
        writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch");
        symlinkSync(outsideDir, join(groundworkDir, "packs"), "dir");

        const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-sym2-files-"));
        writeFileSync(join(filesRoot, "a.txt"), "a\n");

        expect(() =>
          stagePacks([makePack("p", filesRoot)], groundworkDir, {}),
        ).toThrow();
        expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
          "do not touch",
        );
        expect(existsSync(join(outsideDir, "p"))).toBe(false);
        rmSync(filesRoot, { recursive: true, force: true });
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });
  });

  describe("plan failure (runs before any temp dir is created, previous packs/ untouched, no cause)", () => {
    it("throws its own distinct Error -- no 'incomplete'/'re-run' wording, no cause -- when a pack's files tree has two files mapping to the same install path (a dotfile-escaped name and its literal twin)", () => {
      const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-dup-files-"));
      const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-dup-gw-"));
      try {
        writeFileSync(join(filesRoot, "_gitignore"), "escaped\n");
        writeFileSync(join(filesRoot, ".gitignore"), "literal\n");

        // A previous, unrelated successful staging that must survive the
        // failed run below untouched.
        const previousRoot = mkdtempSync(
          join(tmpdir(), "pack-stage-dup-prev-"),
        );
        writeFileSync(join(previousRoot, "ok.txt"), "ok\n");
        stagePacks([makePack("previous", previousRoot)], groundworkDir, {});
        const before = listFiles(join(groundworkDir, "packs"));
        expect(before.length).toBeGreaterThan(0);

        let thrown: unknown;
        try {
          stagePacks([makePack("dup", filesRoot)], groundworkDir, {});
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(".gitignore");
        expect(message).toContain("_gitignore");
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect((thrown as Error).cause).toBeUndefined();
        expect(listFiles(join(groundworkDir, "packs"))).toEqual(before);
        expect(
          readdirSync(groundworkDir).some((n) => n.startsWith(".packs-")),
        ).toBe(false);

        rmSync(previousRoot, { recursive: true, force: true });
      } finally {
        rmSync(filesRoot, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });

    it("throws its own distinct Error -- no 'incomplete'/'re-run' wording, no cause -- when a tokenized file name's substituted path would escape the pack's staging directory (CWE-22)", () => {
      const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-esc-files-"));
      const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-esc-gw-"));
      try {
        writeFileSync(join(filesRoot, "__PROJECT_NAME__.txt"), "x\n");
        const tokens = { PROJECT_NAME: "../../escape" };

        let thrown: unknown;
        try {
          stagePacks([makePack("escaper", filesRoot)], groundworkDir, tokens);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect((thrown as Error).cause).toBeUndefined();
        expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
      } finally {
        rmSync(filesRoot, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });

    it("throws its own distinct Error naming the pack and the path -- no 'incomplete'/'re-run' wording, no cause -- when a pack's filesDir does not exist", () => {
      const groundworkDir = mkdtempSync(
        join(tmpdir(), "pack-stage-missingdir-gw-"),
      );
      const missingFilesDir = join(tmpdir(), "pack-stage-does-not-exist-xyz");
      try {
        let thrown: unknown;
        try {
          stagePacks([makePack("ghost", missingFilesDir)], groundworkDir, {});
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain("ghost");
        expect(message).toContain(missingFilesDir);
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect((thrown as Error).cause).toBeUndefined();
        expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
      } finally {
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });

    it("throws its own distinct Error naming the duplicate -- no 'incomplete'/'re-run' wording, no cause -- when two packs declare the same manifest name", () => {
      const rootA = mkdtempSync(join(tmpdir(), "pack-stage-samename-a-"));
      const rootB = mkdtempSync(join(tmpdir(), "pack-stage-samename-b-"));
      const groundworkDir = mkdtempSync(
        join(tmpdir(), "pack-stage-samename-gw-"),
      );
      try {
        writeFileSync(join(rootA, "a.txt"), "a\n");
        writeFileSync(join(rootB, "b.txt"), "b\n");
        const packA = makePack("same-name", rootA);
        const packB = makePack("same-name", rootB);

        let thrown: unknown;
        try {
          stagePacks([packA, packB], groundworkDir, {});
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain("same-name");
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect((thrown as Error).cause).toBeUndefined();
        expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
        rmSync(rootB, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });

    it.each([["a/b"], [".."], ["."], [""]])(
      "throws its own distinct Error naming the pack name -- no 'incomplete'/'re-run' wording, no cause -- when a pack's manifest.name %j is not a single directory name",
      (badName) => {
        const filesRoot = mkdtempSync(
          join(tmpdir(), "pack-stage-badname-files-"),
        );
        const groundworkDir = mkdtempSync(
          join(tmpdir(), "pack-stage-badname-gw-"),
        );
        try {
          writeFileSync(join(filesRoot, "a.txt"), "a\n");
          const pack = makePack(badName, filesRoot);

          let thrown: unknown;
          try {
            stagePacks([pack], groundworkDir, {});
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(Error);
          const message = (thrown as Error).message;
          expect(message).toContain(JSON.stringify(badName));
          expect(message).not.toContain("incomplete");
          expect(message).not.toContain("re-run");
          expect((thrown as Error).cause).toBeUndefined();
          expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
        } finally {
          rmSync(filesRoot, { recursive: true, force: true });
          rmSync(groundworkDir, { recursive: true, force: true });
        }
      },
    );

    it("throws its own distinct Error naming the pack -- no 'incomplete'/'re-run' wording, no cause -- when the manifest does not serialize to a JSON string (a toJSON returning undefined)", () => {
      const filesRoot = mkdtempSync(
        join(tmpdir(), "pack-stage-notjson-files-"),
      );
      const groundworkDir = mkdtempSync(
        join(tmpdir(), "pack-stage-notjson-gw-"),
      );
      try {
        writeFileSync(join(filesRoot, "a.txt"), "a\n");
        const manifest = {
          ...makeManifest("not-json"),
          toJSON: () => undefined,
        };
        const pack: Pack = { manifest, filesDir: filesRoot };

        let thrown: unknown;
        try {
          stagePacks([pack], groundworkDir, {});
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain("not-json");
        expect(message).not.toContain("incomplete");
        expect(message).not.toContain("re-run");
        expect((thrown as Error).cause).toBeUndefined();
        expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
      } finally {
        rmSync(filesRoot, { recursive: true, force: true });
        rmSync(groundworkDir, { recursive: true, force: true });
      }
    });
  });

  it("orders files[] strictly by path (lexicographic string compare), not by the directory walk's own visitation order", () => {
    // '-' (0x2D) sorts before '/' (0x2F): "a-top.txt" < "a/nested.txt"
    // lexicographically, but the walk visits the "a" directory (and so
    // inserts "a/nested.txt") before the sibling file "a-top.txt", since
    // readdirSync returns "a" ahead of "a-top.txt" (a shorter name that is
    // itself a prefix sorts first) and the walk recurses into a directory
    // entry immediately, before continuing to later top-level entries. A
    // stager that forgot to sort would therefore report
    // ["a/nested.txt", "a-top.txt"], the walk's own order -- not the
    // lexicographic order this test pins.
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-stage-order-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-order-gw-"));
    try {
      mkdirSync(join(filesRoot, "a"), { recursive: true });
      writeFileSync(join(filesRoot, "a", "nested.txt"), "nested\n");
      writeFileSync(join(filesRoot, "a-top.txt"), "top\n");
      expect(readdirSync(filesRoot).sort()).toEqual(["a", "a-top.txt"]);

      const [staged] = stagePacks(
        [makePack("order-pack", filesRoot)],
        groundworkDir,
        {},
      );

      expect(staged?.files.map((f: StagedPackFile) => f.path)).toEqual([
        "a-top.txt",
        "a/nested.txt",
      ]);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});

describe("plannedPackStagingPaths", () => {
  it("returns every path stagePacks would write, all resolving under groundworkDir/packs, including pack.json.staged for each pack, writing nothing", () => {
    const rootA = mkdtempSync(join(tmpdir(), "planned-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "planned-b-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "planned-gw-"));
    try {
      writeFileSync(join(rootA, "a.txt"), "a\n");
      writeFileSync(join(rootB, "b.txt"), "b\n");
      const packA = makePack("pack-a", rootA);
      const packB = makePack("pack-b", rootB);

      const paths = plannedPackStagingPaths([packA, packB], groundworkDir, {});

      expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
      const packsRoot = join(groundworkDir, "packs");
      for (const p of paths) {
        expect(p.startsWith(packsRoot)).toBe(true);
      }
      expect(paths).toContain(join(packsRoot, "pack-a", "pack.json.staged"));
      expect(paths).toContain(join(packsRoot, "pack-b", "pack.json.staged"));
      expect(paths).toContain(
        join(packsRoot, "pack-a", "files", "a.txt.staged"),
      );
      expect(paths).toContain(
        join(packsRoot, "pack-b", "files", "b.txt.staged"),
      );
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("throws the same plan error as stagePacks (missing filesDir), writing nothing", () => {
    const groundworkDir = mkdtempSync(join(tmpdir(), "planned-missing-gw-"));
    const missingFilesDir = join(tmpdir(), "planned-does-not-exist-xyz");
    try {
      expect(() =>
        plannedPackStagingPaths(
          [makePack("ghost", missingFilesDir)],
          groundworkDir,
          {},
        ),
      ).toThrow(/ghost/);
      expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    } finally {
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});

describe("inertness over every real pack under templates/packs", () => {
  const TOOLCHAIN_GLOB =
    "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,md,mdx,yml,yaml,toml}";
  const SKILL_GLOB = "**/SKILL.md";
  const BASENAME_GLOBS = ["**/CLAUDE.md", "**/pack.json", "**/package.json"];

  it("stages every real pack so no staged file name matches a toolchain glob, and counts stay faithful to the source tree", () => {
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-stage-real-gw-"));
    try {
      const names = listPackNames();
      expect(names.length).toBeGreaterThan(0);
      const packs = names.map((name) => loadPack(name));

      const staged = stagePacks(packs, groundworkDir, {});
      expect(staged.map((s: StagedPack) => s.name).sort()).toEqual(
        [...names].sort(),
      );

      let sawNestedSkillMd = false;
      let sawWorkflowYml = false;

      for (const pack of staged) {
        const destDir = join(groundworkDir, "packs", pack.name, "files");
        const stagedNames = listFiles(destDir);

        const sourcePack = packs.find((p) => p.manifest.name === pack.name);
        expect(sourcePack).toBeDefined();
        const sourceFiles = listFiles(sourcePack?.filesDir ?? "");
        expect(stagedNames.length).toBe(sourceFiles.length);
        expect(pack.files.length).toBe(sourceFiles.length);

        for (const staged1 of stagedNames) {
          expect(staged1.endsWith(".staged")).toBe(true);
          expect(matchesGlob(staged1, TOOLCHAIN_GLOB)).toBe(false);
          expect(matchesGlob(staged1, SKILL_GLOB)).toBe(false);
          for (const basenameGlob of BASENAME_GLOBS) {
            expect(matchesGlob(staged1, basenameGlob)).toBe(false);
          }
          if (staged1.endsWith("SKILL.md.staged") && staged1.includes("/")) {
            sawNestedSkillMd = true;
          }
          if (
            staged1.includes(".github/workflows/") &&
            staged1.endsWith(".yml.staged")
          ) {
            sawWorkflowYml = true;
          }
        }

        // The manifest itself is staged too, under its own neutral name.
        expect(matchesGlob(pack.manifest.staged, BASENAME_GLOBS[1] ?? "")).toBe(
          false,
        );
        expect(
          existsSync(
            join(groundworkDir, "packs", pack.name, "pack.json.staged"),
          ),
        ).toBe(true);
      }

      // Non-vacuous: at least one real pack genuinely has a nested SKILL.md
      // and a CI workflow .yml, so the loop above actually exercised both
      // assertions rather than vacuously passing over a shallow tree.
      expect(sawNestedSkillMd).toBe(true);
      expect(sawWorkflowYml).toBe(true);
    } finally {
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});
