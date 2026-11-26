// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `ClassifyProjectInput.fetchedBase`: the templates `--fetch-base` rebuilt
 * from npm. Used only for a path whose base would otherwise be hash-only
 * (resolution order step 6), with tokens applied like a history blob, and
 * only when its bytes hash to the base the lock or history recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProject } from "../src/update-classify.js";
import type { UpdateFileEntry } from "../src/update-classify.js";
import { buildTheirsTree } from "../src/theirs-tree.js";
import type { FetchedBase } from "../src/fetch-base.js";
import { BASE_DIR, BASE_SUFFIX } from "../src/lock.js";
import type { TemplateHistory } from "../src/template-history.js";
import { changeLockFiles } from "./update-fixtures.js";
import {
  bootstrapFresh,
  EMPTY_HISTORY,
  readLockOrThrow,
  sha256,
  simulateOlder,
  TOKENS,
} from "./update-classify-fixtures.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const OLD = "older: true\n";
const MINE = "older: true\nmine: 1\n";
const PATH = "lefthook.yml";

function fetched(
  core: Record<string, string>,
  packs: Record<string, Record<string, string>> = {},
): FetchedBase {
  const toMap = (files: Record<string, string>): Map<string, Uint8Array> =>
    new Map(Object.entries(files).map(([path, text]) => [path, enc(text)]));
  return {
    version: "1.0.0",
    core: toMap(core),
    packs: new Map(Object.entries(packs).map(([n, f]) => [n, toMap(f)])),
  };
}

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "classify-fetched-"));
  project = join(root, "project");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function classify(
  packs: string[],
  overrides: Partial<Parameters<typeof classifyProject>[0]>,
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

const entryOf = (
  result: ReturnType<typeof classifyProject>,
  path: string,
): UpdateFileEntry | undefined =>
  result.entries.find((entry) => entry.path === path);

/** An older, locally edited file whose lock hash has lost its snapshot. */
function lockHashOnly(path = PATH, old = OLD, mine = MINE): void {
  simulateOlder(project, path, old, mine);
  rmSync(join(project, BASE_DIR, `${path}${BASE_SUFFIX}`));
}

/** An older, locally edited file known only by the history's hash. */
function historyHashOnly(): void {
  simulateOlder(project, PATH, OLD, MINE);
  rmSync(join(project, BASE_DIR, `${PATH}${BASE_SUFFIX}`));
  changeLockFiles(project, (files) =>
    files.map((file) =>
      file.path === PATH ? { ...file, baseSha256: null } : file,
    ),
  );
}

const hashOnlyHistory = (): TemplateHistory => ({
  schemaVersion: 1,
  versions: { "1.0.0": { core: { [PATH]: sha256(OLD) }, packs: {} } },
  blobs: {},
});

describe("classifyProject with fetchedBase: a hash-only lock base", () => {
  it("is review without fetchedBase (unchanged)", () => {
    bootstrapFresh(project);
    lockHashOnly();
    expect(entryOf(classify([], {}), PATH)?.action).toBe("review");
  });

  it("is a merge with the fetched bytes", () => {
    bootstrapFresh(project);
    lockHashOnly();
    const result = classify([], { fetchedBase: fetched({ [PATH]: OLD }) });
    expect(entryOf(result, PATH)?.action).toBe("merge");
  });

  it("is a merge when both sides changed the same line (conflict only appears at staging)", () => {
    bootstrapFresh(project);
    lockHashOnly(PATH, "a: 1\n", "a: 2\n");
    const result = classify([], { fetchedBase: fetched({ [PATH]: "a: 1\n" }) });
    expect(entryOf(result, PATH)?.action).toBe("merge");
  });

  it("applies the tokens to the fetched bytes before comparing hashes", () => {
    bootstrapFresh(project);
    // The lock's hash is of the tokenized text the project was written with.
    lockHashOnly(PATH, "name: acme\n", "name: acme\nmine: 1\n");
    const result = classify([], {
      fetchedBase: fetched({ [PATH]: "name: __PROJECT_NAME__\n" }),
    });
    expect(entryOf(result, PATH)?.action).toBe("merge");
  });

  it("does not use fetched bytes that differ from the lock's hash, and says so", () => {
    bootstrapFresh(project);
    lockHashOnly();
    const result = classify([], {
      fetchedBase: fetched({ [PATH]: "something: else\n" }),
    });
    expect(entryOf(result, PATH)?.action).toBe("review");
    expect(
      result.notes.some(
        (note) => note.includes(PATH) && note.toLowerCase().includes("fetch"),
      ),
    ).toBe(true);
  });

  it("falls back to review for a path the fetched base does not hold", () => {
    bootstrapFresh(project);
    lockHashOnly();
    const result = classify([], {
      fetchedBase: fetched({ "other.txt": "x" }),
    });
    expect(entryOf(result, PATH)?.action).toBe("review");
  });
});

describe("classifyProject with fetchedBase: a hash-only history base", () => {
  it("is review without fetchedBase (unchanged)", () => {
    bootstrapFresh(project);
    historyHashOnly();
    expect(
      entryOf(classify([], { history: hashOnlyHistory() }), PATH)?.action,
    ).toBe("review");
  });

  it("is a merge with the fetched bytes", () => {
    bootstrapFresh(project);
    historyHashOnly();
    const result = classify([], {
      history: hashOnlyHistory(),
      fetchedBase: fetched({ [PATH]: OLD }),
    });
    expect(entryOf(result, PATH)?.action).toBe("merge");
  });

  it("does not use fetched bytes that differ from the history's hash", () => {
    bootstrapFresh(project);
    historyHashOnly();
    const result = classify([], {
      history: hashOnlyHistory(),
      fetchedBase: fetched({ [PATH]: "something: else\n" }),
    });
    expect(entryOf(result, PATH)?.action).toBe("review");
    expect(result.notes.some((note) => note.includes(PATH))).toBe(true);
  });
});

describe("classifyProject with fetchedBase: only when otherwise hash-only", () => {
  it("never overrides a verified snapshot", () => {
    bootstrapFresh(project);
    simulateOlder(project, PATH, OLD, MINE);
    const result = classify([], {
      fetchedBase: fetched({ [PATH]: "bogus: true\n" }),
    });
    const entry = entryOf(result, PATH);
    expect(entry?.action).toBe("merge");
    expect(entry?.baseFrom).toBe("snapshot");
    expect(entry?.baseSha256).toBe(sha256(OLD));
  });

  it("never overrides a history blob", () => {
    bootstrapFresh(project);
    historyHashOnly();
    const history: TemplateHistory = {
      ...hashOnlyHistory(),
      blobs: { [sha256(OLD)]: OLD },
    };
    const entry = entryOf(
      classify([], {
        history,
        fetchedBase: fetched({ [PATH]: "bogus: true\n" }),
      }),
      PATH,
    );
    expect(entry?.action).toBe("merge");
    expect(entry?.baseFrom).toBe("history");
  });

  it("does not turn a path with no base at all into a merge", () => {
    bootstrapFresh(project);
    writeFileSync(join(project, PATH), MINE);
    changeLockFiles(project, (files) =>
      files.filter((file) => file.path !== PATH),
    );
    const entry = entryOf(
      classify([], { fetchedBase: fetched({ [PATH]: OLD }) }),
      PATH,
    );
    expect(entry?.action).not.toBe("merge");
  });
});

describe("classifyProject with fetchedBase: pack files", () => {
  it("uses the fetched pack's files for a ledger pack's hash-only base", () => {
    bootstrapFresh(project, ["quality"]);
    const path = "bin/check-file-budget.mjs";
    lockHashOnly(path, "// old\n", "// old\n// mine\n");
    expect(entryOf(classify(["quality"], {}), path)?.action).toBe("review");
    const result = classify(["quality"], {
      fetchedBase: fetched({}, { quality: { [path]: "// old\n" } }),
    });
    expect(entryOf(result, path)?.action).toBe("merge");
  });

  it("does not look a pack file up in the core files", () => {
    bootstrapFresh(project, ["quality"]);
    const path = "bin/check-file-budget.mjs";
    lockHashOnly(path, "// old\n", "// old\n// mine\n");
    const result = classify(["quality"], {
      fetchedBase: fetched({ [path]: "// old\n" }),
    });
    expect(entryOf(result, path)?.action).toBe("review");
  });
});
