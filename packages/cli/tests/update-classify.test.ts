// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `classifyFile` (the pure decision table, one case per row, in order) and
 * `classifyProject` (the walk over a real bootstrapped project). Assumes
 * `classifyProject` merges as JSON every path ending in `.json`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFile, classifyProject } from "../src/update-classify.js";
import type { UpdateFileEntry } from "../src/update-classify.js";
import { buildTheirsTree } from "../src/theirs-tree.js";
import type { TemplateHistory } from "../src/template-history.js";
import {
  readLockOrThrow,
  bootstrapFresh,
  EMPTY_HISTORY,
  TOKENS,
  readText,
  sha256,
  simulateOlder,
} from "./update-classify-fixtures.js";
import { snapshotTree } from "./add-pack-fixtures.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

type Input = Parameters<typeof classifyFile>[0];

function input(overrides: Partial<Input>): Input {
  return {
    path: "src/x.ts",
    source: "core",
    skipped: false,
    base: { kind: "content", bytes: enc("base"), from: "snapshot" },
    ours: enc("base"),
    theirs: enc("base"),
    jsonMerge: false,
    ...overrides,
  };
}

const contentBase = (text: string): Input["base"] => ({
  kind: "content",
  bytes: enc(text),
  from: "snapshot",
});
const hashBase = (text: string): Input["base"] => ({
  kind: "hash",
  sha256: sha256(text),
  from: "lock",
});
const NONE: Input["base"] = { kind: "none" };

describe("classifyFile", () => {
  it("0: a skipped path is skip", () => {
    const entry = classifyFile(
      input({ skipped: true, ours: enc("a"), theirs: enc("b") }),
    );
    expect(entry.action).toBe("skip");
  });

  it("0 beats 1: skipped wins over a rename", () => {
    expect(
      classifyFile(input({ skipped: true, renamedTo: "y.ts" })).action,
    ).toBe("skip");
  });

  it("1: a migrated rename is rename, apply when ours is untouched", () => {
    const entry = classifyFile(input({ renamedTo: "y.ts", theirs: undefined }));
    expect(entry).toMatchObject({
      action: "rename",
      renamedTo: "y.ts",
      default: "apply",
    });
  });

  it("1: a rename of a locally edited file asks", () => {
    const entry = classifyFile(
      input({ renamedTo: "y.ts", ours: enc("edited"), theirs: undefined }),
    );
    expect(entry).toMatchObject({ action: "rename", default: "ask" });
  });

  it("1 beats 2: a rename wins over a declined status", () => {
    expect(
      classifyFile(input({ renamedTo: "y.ts", status: "declined" })).action,
    ).toBe("rename");
  });

  it.each(["declined", "kept"] as const)(
    "2: %s with theirs equal to base is skip",
    (status) => {
      expect(classifyFile(input({ status })).action).toBe("skip");
    },
  );

  it("2: declined with no base and no theirs is skip", () => {
    expect(
      classifyFile(
        input({
          status: "declined",
          base: NONE,
          theirs: undefined,
          ours: undefined,
        }),
      ).action,
    ).toBe("skip");
  });

  it.each(["declined", "kept"] as const)(
    "2: %s with theirs changed is review, default skip, even when ours equals theirs",
    (status) => {
      // ours == theirs would be "current" by row 3: row 2 must come first.
      const entry = classifyFile(
        input({ status, ours: enc("new"), theirs: enc("new") }),
      );
      expect(entry).toMatchObject({ action: "review", default: "skip" });
    },
  );

  it("3: ours equal to theirs is current", () => {
    const entry = classifyFile(input({ ours: enc("n"), theirs: enc("n") }));
    expect(entry.action).toBe("current");
  });

  it("3 holds with no base at all", () => {
    expect(
      classifyFile(input({ base: NONE, ours: enc("n"), theirs: enc("n") }))
        .action,
    ).toBe("current");
  });

  it("4: theirs equal to base (local-only change) is keep", () => {
    const entry = classifyFile(input({ ours: enc("tailored") }));
    expect(entry.action).toBe("keep");
  });

  it("4: keep also works with a hash-only base", () => {
    const entry = classifyFile(
      input({ base: hashBase("base"), ours: enc("tailored") }),
    );
    expect(entry.action).toBe("keep");
  });

  it("4 beats 6: deleted locally but theirs unchanged is keep, not review", () => {
    const entry = classifyFile(input({ ours: undefined }));
    expect(entry.action).toBe("keep");
  });

  it("5: ours equal to base and theirs changed is take, default apply", () => {
    const entry = classifyFile(input({ theirs: enc("newer") }));
    expect(entry).toMatchObject({ action: "take", default: "apply" });
  });

  it("5: take also works with a hash-only base", () => {
    const entry = classifyFile(
      input({ base: hashBase("base"), theirs: enc("newer") }),
    );
    expect(entry).toMatchObject({ action: "take", default: "apply" });
  });

  it("6: deleted locally and changed upstream is review, default skip", () => {
    const entry = classifyFile(
      input({ ours: undefined, theirs: enc("newer") }),
    );
    expect(entry).toMatchObject({ action: "review", default: "skip" });
    expect(entry.reason).toMatch(/delet/i);
  });

  it("7: both changed, not JSON, is merge, default apply, reason says conflicts come later", () => {
    const entry = classifyFile(
      input({ ours: enc("mine"), theirs: enc("theirs") }),
    );
    expect(entry).toMatchObject({ action: "merge", default: "apply" });
    expect(entry.reason).toMatch(/conflict/i);
  });

  it("7: both changed JSON, disjoint keys, is a clean merge with per-key resolutions", () => {
    const entry = classifyFile(
      input({
        path: "package.json",
        jsonMerge: true,
        base: contentBase('{"a":1,"b":1}'),
        ours: enc('{"a":2,"b":1}'),
        theirs: enc('{"a":1,"b":2}'),
      }),
    );
    expect(entry.action).toBe("merge");
    expect(entry.keyDiffs).toEqual(
      expect.arrayContaining([
        { pointer: "/a", resolution: "ours" },
        { pointer: "/b", resolution: "theirs" },
      ]),
    );
  });

  it("7: both changed JSON, the same key, is a conflict naming it", () => {
    const entry = classifyFile(
      input({
        path: "package.json",
        jsonMerge: true,
        base: contentBase('{"a":1}'),
        ours: enc('{"a":2}'),
        theirs: enc('{"a":3}'),
      }),
    );
    expect(entry.action).toBe("conflict");
    expect(entry.keyDiffs).toContainEqual({
      pointer: "/a",
      resolution: "conflict",
    });
  });

  it("7: both changed JSON that is unmergeable (a comment) is review", () => {
    const entry = classifyFile(
      input({
        path: "tsconfig.json",
        jsonMerge: true,
        base: contentBase('{"a":1}'),
        ours: enc('{ // mine\n "a":2}'),
        theirs: enc('{"a":3}'),
      }),
    );
    expect(entry.action).toBe("review");
  });

  it("8: both changed with a hash-only base is review and names the base", () => {
    const entry = classifyFile(
      input({
        base: hashBase("base"),
        ours: enc("mine"),
        theirs: enc("theirs"),
      }),
    );
    expect(entry.action).toBe("review");
    expect(entry.reason).toContain("base");
  });

  it("9: no base, theirs present and ours absent is add, default apply", () => {
    const entry = classifyFile(
      input({ base: NONE, ours: undefined, theirs: enc("new") }),
    );
    expect(entry).toMatchObject({ action: "add", default: "apply" });
  });

  it("9: no base, both present and different is a two-way review", () => {
    const entry = classifyFile(
      input({ base: NONE, ours: enc("mine"), theirs: enc("theirs") }),
    );
    expect(entry.action).toBe("review");
  });

  it("10: removed upstream and untouched locally is delete, default apply", () => {
    const entry = classifyFile(input({ theirs: undefined }));
    expect(entry).toMatchObject({ action: "delete", default: "apply" });
  });

  it("10: removed upstream but edited locally is review, default skip", () => {
    const entry = classifyFile(
      input({ theirs: undefined, ours: enc("edited") }),
    );
    expect(entry).toMatchObject({ action: "review", default: "skip" });
  });

  it("reports the three hashes and where the base came from", () => {
    const entry: UpdateFileEntry = classifyFile(
      input({ ours: enc("mine"), theirs: enc("theirs") }),
    );
    expect(entry).toMatchObject({
      path: "src/x.ts",
      source: "core",
      baseSha256: sha256("base"),
      oursSha256: sha256("mine"),
      theirsSha256: sha256("theirs"),
      baseFrom: "snapshot",
    });
  });

  it("reports null hashes for an absent side and a missing base", () => {
    const entry = classifyFile(
      input({ base: NONE, ours: undefined, theirs: enc("new") }),
    );
    expect(entry).toMatchObject({
      baseSha256: null,
      oursSha256: null,
      theirsSha256: sha256("new"),
      baseFrom: null,
    });
  });

  it("uses a hash-only base's own hash", () => {
    const entry = classifyFile(input({ base: hashBase("base") }));
    expect(entry.baseSha256).toBe(sha256("base"));
    expect(entry.baseFrom).toBe("lock");
  });
});

describe("classifyProject", () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "update-classify-"));
    project = join(root, "project");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Classifies `project` against the running CLI's own theirs tree. */
  function classify(
    packs: string[],
    overrides: Partial<Parameters<typeof classifyProject>[0]> = {},
  ): ReturnType<typeof classifyProject> {
    const lock = readLockOrThrow(project);
    const theirs = buildTheirsTree({ tokens: TOKENS, packNames: packs });
    try {
      return classifyProject({
        targetDir: project,
        lock,
        history: EMPTY_HISTORY,
        baseVersion: lock.baseVersion,
        ledgerPacks: packs,
        tokens: TOKENS,
        theirsDir: theirs.dir,
        theirsSources: theirs.sources,
        migrations: [],
        runningVersion: "99.0.0",
        origin: "fresh",
        ...overrides,
      });
    } finally {
      theirs.cleanup();
    }
  }

  const byPath = (
    result: ReturnType<typeof classifyProject>,
    path: string,
  ): UpdateFileEntry | undefined =>
    result.entries.find((entry) => entry.path === path);

  it.each([[[]], [["quality"]], [["quality", "statusline"]]] as string[][][])(
    "is idempotent: a fresh bootstrap with packs %j classifies only current or skip",
    (packs) => {
      bootstrapFresh(project, packs);
      const before = snapshotTree(project);
      const result = classify(packs);
      expect(result.entries.length).toBeGreaterThan(0);
      const actions = new Set(result.entries.map(({ action }) => action));
      expect(
        [...actions].filter((a) => a !== "current" && a !== "skip"),
      ).toEqual([]);
      expect(result.summary.current).toBeGreaterThan(0);
      expect(snapshotTree(project)).toEqual(before);
    },
  );

  it("an untouched file whose base is older than theirs is take", () => {
    bootstrapFresh(project);
    simulateOlder(project, "lefthook.yml", "older: true\n");
    const entry = byPath(classify([]), "lefthook.yml");
    expect(entry).toMatchObject({ action: "take", default: "apply" });
    expect(entry?.baseFrom).toBe("snapshot");
  });

  it("a locally edited file whose base is older than theirs is merge (text)", () => {
    bootstrapFresh(project);
    simulateOlder(
      project,
      "lefthook.yml",
      "older: true\n",
      "older: true\nmine: 1\n",
    );
    expect(byPath(classify([]), "lefthook.yml")?.action).toBe("merge");
  });

  it("a locally edited file whose theirs equals base is keep", () => {
    bootstrapFresh(project);
    writeFileSync(
      join(project, "lefthook.yml"),
      `${readText(project, "lefthook.yml")}# tailored\n`,
    );
    expect(byPath(classify([]), "lefthook.yml")?.action).toBe("keep");
  });

  describe("package.json", () => {
    function olderPackageJson(): Record<string, Record<string, string>> {
      const parsed = JSON.parse(readText(project, "package.json")) as Record<
        string,
        Record<string, string>
      >;
      parsed["devDependencies"] = {
        ...parsed["devDependencies"],
        vitest: "0.0.1",
      };
      return parsed;
    }
    const text = (value: unknown): string =>
      `${JSON.stringify(value, null, 2)}\n`;

    it("merges per dependency when ours changed other keys", () => {
      bootstrapFresh(project);
      const older = olderPackageJson();
      const mine = structuredClone(older);
      mine["scripts"] = { ...mine["scripts"], mine: "echo hi" };
      simulateOlder(project, "package.json", text(older), text(mine));
      const entry = byPath(classify([]), "package.json");
      expect(entry?.action).toBe("merge");
      expect(entry?.keyDiffs).toEqual(
        expect.arrayContaining([
          { pointer: "/devDependencies/vitest", resolution: "theirs" },
          { pointer: "/scripts/mine", resolution: "ours" },
        ]),
      );
    });

    it("conflicts on the one dependency both sides moved", () => {
      bootstrapFresh(project);
      const older = olderPackageJson();
      const mine = structuredClone(older);
      mine["devDependencies"] = { ...mine["devDependencies"], vitest: "0.0.2" };
      simulateOlder(project, "package.json", text(older), text(mine));
      const entry = byPath(classify([]), "package.json");
      expect(entry?.action).toBe("conflict");
      expect(entry?.keyDiffs).toContainEqual({
        pointer: "/devDependencies/vitest",
        resolution: "conflict",
      });
    });
  });

  describe("pack wiring JSON targets", () => {
    const targets = [
      "package.json",
      ".claude/settings.json",
      "bin/lib/verify-steps.packs.json",
    ];

    it("are current in an untouched quality-pack project", () => {
      bootstrapFresh(project, ["quality"]);
      const result = classify(["quality"]);
      for (const path of targets) {
        expect(byPath(result, path)?.action).toBe("current");
      }
    });

    it("take the pack's verify step when the project predates it", () => {
      bootstrapFresh(project, ["quality"]);
      simulateOlder(project, "bin/lib/verify-steps.packs.json", "[]\n");
      const entry = byPath(
        classify(["quality"]),
        "bin/lib/verify-steps.packs.json",
      );
      expect(entry?.action).toBe("take");
    });

    it("stay keep for an adopted project when upstream did not change them", () => {
      bootstrapFresh(project, ["quality"]);
      for (const path of ["package.json", ".claude/settings.json"]) {
        const parsed = JSON.parse(readText(project, path)) as Record<
          string,
          unknown
        >;
        parsed["x-local"] = 1;
        writeFileSync(
          join(project, path),
          `${JSON.stringify(parsed, null, 2)}\n`,
        );
      }
      const fresh = classify(["quality"]);
      const adopted = classify(["quality"], { origin: "adopted" });
      for (const path of ["package.json", ".claude/settings.json"]) {
        expect(byPath(fresh, path)?.action).toBe("keep");
        expect(byPath(adopted, path)?.action).toBe("keep");
      }
    });

    it("are review for an adopted project only where upstream changed them", () => {
      bootstrapFresh(project, ["quality"]);
      const older = JSON.parse(readText(project, "package.json")) as Record<
        string,
        Record<string, string>
      >;
      older["devDependencies"] = {
        ...older["devDependencies"],
        vitest: "0.0.1",
      };
      const mine = structuredClone(older);
      mine["scripts"] = { ...mine["scripts"], mine: "echo hi" };
      const asText = (value: unknown): string =>
        `${JSON.stringify(value, null, 2)}\n`;
      simulateOlder(project, "package.json", asText(older), asText(mine));
      simulateOlder(project, "bin/lib/verify-steps.packs.json", "[]\n");
      const fresh = classify(["quality"]);
      const adopted = classify(["quality"], { origin: "adopted" });
      expect(byPath(fresh, "package.json")?.action).toBe("merge");
      expect(byPath(fresh, "bin/lib/verify-steps.packs.json")?.action).toBe(
        "take",
      );
      for (const path of ["package.json", "bin/lib/verify-steps.packs.json"]) {
        expect(byPath(adopted, path)).toMatchObject({
          action: "review",
          default: "skip",
        });
      }
    });
  });

  describe("without a lock", () => {
    const text = "export default [];\n// older\n";
    const history = (blob: boolean): TemplateHistory => ({
      schemaVersion: 1,
      versions: {
        "1.0.0": { core: { "eslint.config.js": sha256(text) }, packs: {} },
      },
      blobs: blob ? { [sha256(text)]: text } : {},
    });
    function noLock(
      h: TemplateHistory,
      projectText: string,
    ): UpdateFileEntry | undefined {
      bootstrapFresh(project);
      rmSync(join(project, ".groundwork"), { recursive: true });
      writeFileSync(join(project, "eslint.config.js"), projectText);
      const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
      try {
        return classifyProject({
          targetDir: project,
          history: h,
          baseVersion: "1.0.0",
          ledgerPacks: [],
          tokens: TOKENS,
          theirsDir: theirs.dir,
          theirsSources: theirs.sources,
          migrations: [],
          runningVersion: "99.0.0",
          origin: "unknown",
        }).entries.find(({ path }) => path === "eslint.config.js");
      } finally {
        theirs.cleanup();
      }
    }

    it("uses the history blob as the base text (merge when edited)", () => {
      const entry = noLock(history(true), `${text}// mine\n`);
      expect(entry?.action).toBe("merge");
      expect(entry?.baseFrom).not.toBeNull();
    });

    it("uses the history blob as the base text (take when untouched)", () => {
      expect(noLock(history(true), text)?.action).toBe("take");
    });

    it("falls back to the history hash alone when no blob is stored", () => {
      expect(noLock(history(false), text)?.action).toBe("take");
      const edited = noLock(history(false), `${text}// mine\n`);
      expect(edited?.action).toBe("review");
      expect(edited?.reason).toContain("base");
    });
  });

  describe("unreadable entries", () => {
    it("a symlink in place of a file is review with a note, never a throw", () => {
      bootstrapFresh(project);
      rmSync(join(project, "eslint.config.js"));
      writeFileSync(join(root, "elsewhere"), "x");
      symlinkSync(join(root, "elsewhere"), join(project, "eslint.config.js"));
      const result = classify([]);
      expect(byPath(result, "eslint.config.js")?.action).toBe("review");
      expect(result.notes.some((n) => n.includes("eslint.config.js"))).toBe(
        true,
      );
    });

    it("a directory in place of a file is review with a note", () => {
      bootstrapFresh(project);
      rmSync(join(project, "eslint.config.js"));
      mkdirSync(join(project, "eslint.config.js"));
      const result = classify([]);
      expect(byPath(result, "eslint.config.js")?.action).toBe("review");
      expect(result.notes.some((n) => n.includes("eslint.config.js"))).toBe(
        true,
      );
    });
  });

  it("a locally deleted file the theirs tree changed is review, default skip", () => {
    bootstrapFresh(project);
    simulateOlder(project, "lefthook.yml", "older: true\n");
    rmSync(join(project, "lefthook.yml"));
    expect(byPath(classify([]), "lefthook.yml")).toMatchObject({
      action: "review",
      default: "skip",
    });
  });

  it("a file the lock skips is skip, and a declined one is not applied", () => {
    bootstrapFresh(project);
    simulateOlder(project, "lefthook.yml", "older: true\n");
    const lock = readLockOrThrow(project);
    const skipped = classify([], { lock: { ...lock, skip: ["lefthook.yml"] } });
    expect(byPath(skipped, "lefthook.yml")?.action).toBe("skip");
    const declined = classify([], {
      lock: {
        ...lock,
        files: lock.files.map((f) =>
          f.path === "lefthook.yml" ? { ...f, status: "declined" as const } : f,
        ),
      },
    });
    expect(byPath(declined, "lefthook.yml")).toMatchObject({
      action: "review",
      default: "skip",
    });
  });

  it("a file removed upstream and untouched is delete", () => {
    bootstrapFresh(project);
    writeFileSync(join(project, "gone-upstream.txt"), "x\n");
    const lock = readLockOrThrow(project);
    const result = classify([], {
      lock: {
        ...lock,
        files: [
          ...lock.files,
          {
            path: "gone-upstream.txt",
            source: "core",
            baseSha256: sha256("x\n"),
            status: "installed",
          },
        ],
      },
    });
    expect(byPath(result, "gone-upstream.txt")?.action).toBe("delete");
  });

  it("applies a migration rename in its window and folds the new path into the rename entry", () => {
    bootstrapFresh(project);
    const lock = readLockOrThrow(project);
    const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
    try {
      const content = readText(theirs.dir, "lefthook.yml");
      rmSync(join(theirs.dir, "lefthook.yml"));
      mkdirSync(join(theirs.dir, "cfg"));
      writeFileSync(join(theirs.dir, "cfg", "lefthook.yml"), content);
      const result = classifyProject({
        targetDir: project,
        lock,
        history: EMPTY_HISTORY,
        baseVersion: "1.0.0",
        ledgerPacks: [],
        tokens: TOKENS,
        theirsDir: theirs.dir,
        theirsSources: theirs.sources,
        migrations: [
          {
            id: "move-lefthook",
            since: "1.5.0",
            renames: [{ from: "lefthook.yml", to: "cfg/lefthook.yml" }],
          },
        ],
        runningVersion: "1.5.0",
        origin: "fresh",
      });
      expect(byPath(result, "lefthook.yml")).toMatchObject({
        action: "rename",
        renamedTo: "cfg/lefthook.yml",
        default: "apply",
      });
      // Assumption: a rename target produces no separate entry; the one
      // rename entry carries it, so nothing can be applied twice.
      expect(byPath(result, "cfg/lefthook.yml")).toBeUndefined();
      expect(result.summary.rename).toBe(1);
      expect(result.summary.add).toBe(0);
    } finally {
      theirs.cleanup();
    }
  });

  it("summary counts every action", () => {
    bootstrapFresh(project);
    simulateOlder(project, "lefthook.yml", "older: true\n");
    const result = classify([]);
    const total = Object.values(result.summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.entries.length);
    expect(result.summary.take).toBe(1);
  });

  describe("migration renames", () => {
    const MOVE = [
      {
        id: "move-lefthook",
        since: "1.5.0",
        renames: [{ from: "lefthook.yml", to: "cfg/lefthook.yml" }],
      },
    ];

    /** Classifies with `lefthook.yml` moved to `cfg/lefthook.yml` upstream. */
    function classifyMoved(): ReturnType<typeof classifyProject> {
      const lock = readLockOrThrow(project);
      const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
      try {
        const content = readText(theirs.dir, "lefthook.yml");
        rmSync(join(theirs.dir, "lefthook.yml"));
        mkdirSync(join(theirs.dir, "cfg"));
        writeFileSync(join(theirs.dir, "cfg", "lefthook.yml"), content);
        return classifyProject({
          targetDir: project,
          lock,
          history: EMPTY_HISTORY,
          baseVersion: "1.0.0",
          ledgerPacks: [],
          tokens: TOKENS,
          theirsDir: theirs.dir,
          theirsSources: theirs.sources,
          migrations: MOVE,
          runningVersion: "1.5.0",
          origin: "fresh",
        });
      } finally {
        theirs.cleanup();
      }
    }

    /** The target is never an apply-able add (it is folded or held back). */
    function targetIsNotApplied(result: ReturnType<typeof classifyProject>) {
      const target = byPath(result, "cfg/lefthook.yml");
      expect(
        target === undefined ||
          (target.action !== "add" && target.default !== "apply"),
      ).toBe(true);
    }

    it("a locally edited source is one rename (ask) and its target is not an apply", () => {
      bootstrapFresh(project);
      writeFileSync(
        join(project, "lefthook.yml"),
        `${readText(project, "lefthook.yml")}# tailored\n`,
      );
      const result = classifyMoved();
      expect(byPath(result, "lefthook.yml")).toMatchObject({
        action: "rename",
        default: "ask",
        renamedTo: "cfg/lefthook.yml",
      });
      expect(result.summary.rename).toBe(1);
      expect(result.summary.add).toBe(0);
      targetIsNotApplied(result);
    });

    it("an untouched source is one rename (apply) and its target is not a second apply", () => {
      bootstrapFresh(project);
      const result = classifyMoved();
      expect(byPath(result, "lefthook.yml")).toMatchObject({
        action: "rename",
        default: "apply",
      });
      expect(result.summary.rename).toBe(1);
      expect(result.summary.add).toBe(0);
      targetIsNotApplied(result);
    });

    it("a rename whose source the project never had is current, not rename", () => {
      bootstrapFresh(project);
      const lock = readLockOrThrow(project);
      const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
      try {
        const result = classifyProject({
          targetDir: project,
          lock,
          history: EMPTY_HISTORY,
          baseVersion: "1.0.0",
          ledgerPacks: [],
          tokens: TOKENS,
          theirsDir: theirs.dir,
          theirsSources: theirs.sources,
          migrations: [
            {
              id: "move-pack-file",
              since: "1.5.0",
              renames: [{ from: "legacy/never-installed.ts", to: "new.ts" }],
            },
          ],
          runningVersion: "1.5.0",
          origin: "fresh",
        });
        expect(byPath(result, "legacy/never-installed.ts")?.action).toBe(
          "current",
        );
        expect(result.summary.rename).toBe(0);
      } finally {
        theirs.cleanup();
      }
    });
  });

  describe("a pack the CLI no longer ships", () => {
    it("never deletes its files by default: they are review (skip) or left out", () => {
      bootstrapFresh(project, ["quality"]);
      const result = classify([], {
        ledgerPacks: ["quality"],
        missingPacks: ["quality"],
      });
      const packFiles = result.entries.filter(
        (entry) =>
          entry.source === "pack:quality" && entry.theirsSha256 === null,
      );
      expect(packFiles.length).toBeGreaterThan(0);
      for (const entry of packFiles) {
        expect(entry.action).not.toBe("delete");
        expect(entry.default).toBe("skip");
      }
    });
  });

  describe("a pack's own base version", () => {
    function classifyPackFile(
      extra: Partial<Parameters<typeof classifyProject>[0]>,
    ): UpdateFileEntry | undefined {
      bootstrapFresh(project, ["quality"]);
      rmSync(join(project, ".groundwork"), { recursive: true });
      const theirs = buildTheirsTree({
        tokens: TOKENS,
        packNames: ["quality"],
      });
      try {
        const packPath = [...theirs.sources].find(
          ([, source]) => source === "pack:quality",
        )?.[0];
        if (packPath === undefined) throw new Error("fixture: no pack file");
        const bytes = readFileSync(join(theirs.dir, packPath));
        writeFileSync(
          join(project, packPath),
          Buffer.concat([bytes, Buffer.from("\n# local\n")]),
        );
        const history: TemplateHistory = {
          schemaVersion: 1,
          versions: {
            "1.0.0": { core: {}, packs: {} },
            "1.2.0": {
              core: {},
              packs: {
                quality: {
                  manifest: sha256("m"),
                  files: { [packPath]: sha256(bytes) },
                },
              },
            },
          },
          blobs: {},
        };
        return classifyProject({
          targetDir: project,
          history,
          baseVersion: "1.0.0",
          ledgerPacks: ["quality"],
          tokens: TOKENS,
          theirsDir: theirs.dir,
          theirsSources: theirs.sources,
          migrations: [],
          runningVersion: "99.0.0",
          origin: "fresh",
          ...extra,
        }).entries.find((entry) => entry.path === packPath);
      } finally {
        theirs.cleanup();
      }
    }

    it("is classified against the pack's own release's history entry", () => {
      const entry = classifyPackFile({
        ledgerPackVersions: { quality: "1.2.0" },
      });
      expect(entry).toMatchObject({ action: "keep", baseFrom: "history" });
    });

    it("falls back to the core base version when no pack version is given", () => {
      // 1.0.0's history lacks the file: no base, both sides have it.
      expect(classifyPackFile({ ledgerPackVersions: {} })?.action).toBe(
        "review",
      );
    });
  });

  describe("adopted origin defaults", () => {
    function lockless(
      origin: "fresh" | "adopted",
      setup: () => void,
      history: TemplateHistory,
    ): ReturnType<typeof classifyProject> {
      bootstrapFresh(project);
      rmSync(join(project, ".groundwork"), { recursive: true });
      setup();
      const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
      try {
        return classifyProject({
          targetDir: project,
          history,
          baseVersion: "1.0.0",
          ledgerPacks: [],
          tokens: TOKENS,
          theirsDir: theirs.dir,
          theirsSources: theirs.sources,
          migrations: [],
          runningVersion: "99.0.0",
          origin,
        });
      } finally {
        theirs.cleanup();
      }
    }
    const text = "export default [];\n// older\n";
    const withBlob: TemplateHistory = {
      schemaVersion: 1,
      versions: {
        "1.0.0": { core: { "eslint.config.js": sha256(text) }, packs: {} },
      },
      blobs: { [sha256(text)]: text },
    };

    it("a history-derived merge defaults to ask when adopted, apply when fresh", () => {
      const edit = (): void => {
        writeFileSync(join(project, "eslint.config.js"), `${text}// mine\n`);
      };
      const fresh = byPath(
        lockless("fresh", edit, withBlob),
        "eslint.config.js",
      );
      expect(fresh).toMatchObject({ action: "merge", default: "apply" });
      rmSync(project, { recursive: true, force: true });
      const adopted = byPath(
        lockless("adopted", edit, withBlob),
        "eslint.config.js",
      );
      expect(adopted).toMatchObject({ action: "merge", default: "ask" });
    });

    it("an add defaults to ask when adopted, apply when fresh", () => {
      const remove = (): void => {
        rmSync(join(project, "eslint.config.js"));
      };
      const fresh = byPath(
        lockless("fresh", remove, EMPTY_HISTORY),
        "eslint.config.js",
      );
      expect(fresh).toMatchObject({ action: "add", default: "apply" });
      rmSync(project, { recursive: true, force: true });
      const adopted = byPath(
        lockless("adopted", remove, EMPTY_HISTORY),
        "eslint.config.js",
      );
      expect(adopted).toMatchObject({ action: "add", default: "ask" });
    });
  });

  it("notes a missing base snapshot, naming the path, and falls back to the lock's hash", () => {
    bootstrapFresh(project);
    rmSync(join(project, ".groundwork", "base", "lefthook.yml.base"));
    const result = classify([]);
    expect(
      result.notes.some(
        (note) =>
          note.includes("lefthook.yml") &&
          note.includes("only the lock's hash"),
      ),
    ).toBe(true);
    expect(byPath(result, "lefthook.yml")?.baseFrom).toBe("lock");
  });
});

describe("classifyFile: removed status and rule order", () => {
  it("removed with theirs present and no base is review, never an add", () => {
    expect(
      classifyFile(
        input({
          status: "removed",
          base: NONE,
          ours: undefined,
          theirs: enc("new"),
        }),
      ),
    ).toMatchObject({ action: "review", default: "skip" });
  });

  it("removed with theirs equal to the base is skip", () => {
    expect(
      classifyFile(
        input({
          status: "removed",
          base: contentBase("base"),
          ours: undefined,
          theirs: enc("base"),
        }),
      ),
    ).toMatchObject({ action: "skip", default: "skip" });
  });

  it("ours and theirs both absent is current", () => {
    expect(
      classifyFile(input({ ours: undefined, theirs: undefined })).action,
    ).toBe("current");
  });

  it.each(["declined", "kept"] as const)(
    "%s with no base and theirs present is review",
    (status) => {
      expect(
        classifyFile(
          input({ status, base: NONE, ours: undefined, theirs: enc("x") }),
        ),
      ).toMatchObject({ action: "review", default: "skip" });
    },
  );

  it("skip beats a rename", () => {
    expect(
      classifyFile(input({ skipped: true, renamedTo: "y.ts" })).action,
    ).toBe("skip");
  });

  it("an unmergeable JSON review reason never embeds the parser's text", () => {
    const entry = classifyFile(
      input({
        path: "x.json",
        jsonMerge: true,
        base: contentBase('{"a":1}'),
        ours: enc('{"secret-marker-123": nope'),
        theirs: enc('{"a":2}'),
      }),
    );
    expect(entry.action).toBe("review");
    expect(entry.reason).not.toContain("secret-marker-123");
    expect(entry.reason).not.toContain("nope");
  });
});
