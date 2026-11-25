// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers bin/lib/template-history.mjs -- the pure helpers behind
 * bin/build-template-history.mjs, plain ESM under bin/ outside every tsconfig,
 * loaded by URL. The generator is exercised against a throwaway git repository
 * built per test, with tagged releases, never this repository's own tags.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  escapeDotfileName,
  restoreDotfilePath as assetsRestore,
} from "../src/assets.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface History {
  schemaVersion: number;
  versions: Record<
    string,
    {
      core: Record<string, string>;
      packs: Record<
        string,
        { manifest: string; files: Record<string, string> }
      >;
    }
  >;
  blobs: Record<string, string>;
}

interface HistoryLib {
  buildTemplateHistory(options: {
    repoDir: string;
    tagPrefix?: string;
  }): History;
  serializeTemplateHistory(history: unknown): string;
  checkTemplateHistory(options: {
    text: string | null;
    path?: string;
    changelogText: string;
    currentVersion: string;
  }): string[];
  assertBuildable(history: unknown): void;
  restoreDotfilePath(relPath: string): string;
  stableVersionsFromTags(tags: string[]): string[];
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "template-history.mjs")).href
)) as HistoryLib;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

let repo: string;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd: repo, env: GIT_ENV, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function put(rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function release(version: string, tagPrefix = "@monte3l/groundwork@"): void {
  git("add", "-A");
  git("commit", "-m", `release ${version}`);
  git("tag", `${tagPrefix}${version}`);
}

const PKG_1_0 = `{"name":"__PROJECT_NAME__","version":"1.0.0"}\n`;
const PKG_1_1 = `{"name":"__PROJECT_NAME__","version":"1.1.0"}\n`;
const README_1_0 = "# plain readme\n";
const README_1_1 = "# plain readme, edited\n";
const GITIGNORE = "node_modules\n";
const SETTINGS = `{"hooks":{}}\n`;
const TSCONFIG = `{"extends":"./tsconfig.base.json"}\n`;
const PACK_JSON_1_0 = `{"name":"demo","version":"1"}\n`;
const PACK_JSON_1_1 = `{"name":"demo","version":"2"}\n`;
const PACK_TOKENIZED = "(c) __YEAR__ demo\n";
const PACK_PLAIN = "plain pack file\n";
const NPMRC = "ignore-scripts=true\n";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "template-history-"));
  git("init", "-q");

  put("templates/core/package.json", PKG_1_0);
  put("templates/core/README.md", README_1_0);
  put("templates/core/_gitignore", GITIGNORE);
  put("templates/core/.claude/settings.json", SETTINGS);
  put("templates/core/tsconfig.json", TSCONFIG);
  put("templates/packs/demo/pack.json", PACK_JSON_1_0);
  put("templates/packs/demo/files/docs/notice.md", PACK_TOKENIZED);
  put("templates/packs/demo/files/plain.txt", PACK_PLAIN);
  put("templates/packs/demo/files/_npmrc", NPMRC);
  put("unrelated/file.txt", "not a template\n");
  release("1.0.0");

  put("templates/core/package.json", PKG_1_1);
  put("templates/core/README.md", README_1_1);
  put("templates/packs/demo/pack.json", PACK_JSON_1_1);
  put("templates/packs/demo/files/added.txt", "added later\n");
  release("1.1.0");

  put("templates/core/README.md", "# prerelease readme\n");
  release("1.2.0-rc.1");
  git("tag", "v9.9.9");
  git("tag", "other@3.0.0");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function build(): History {
  return lib.buildTemplateHistory({ repoDir: repo });
}

describe("stableVersionsFromTags", () => {
  it("keeps only stable x.y.z tags of the prefix, stripped of it", () => {
    expect(
      lib.stableVersionsFromTags([
        "@monte3l/groundwork@1.0.0",
        "@monte3l/groundwork@1.0.0-rc.2",
        "@monte3l/groundwork@0.1.0-next.0",
        "@monte3l/groundwork@10.2.30",
        "v1.0.0",
        "other@2.0.0",
        "@monte3l/groundwork@1.0",
        "@monte3l/groundwork@",
      ]),
    ).toEqual(expect.arrayContaining(["1.0.0", "10.2.30"]));
    expect(
      lib.stableVersionsFromTags([
        "@monte3l/groundwork@1.0.0",
        "@monte3l/groundwork@1.0.0-rc.2",
        "@monte3l/groundwork@0.1.0-next.0",
        "@monte3l/groundwork@10.2.30",
        "v1.0.0",
        "other@2.0.0",
        "@monte3l/groundwork@1.0",
        "@monte3l/groundwork@",
      ]),
    ).toHaveLength(2);
  });

  it("returns nothing for no tags", () => {
    expect(lib.stableVersionsFromTags([])).toEqual([]);
  });
});

describe("buildTemplateHistory", () => {
  it("records exactly the stable tagged versions, skipping prereleases and foreign tags", () => {
    expect(Object.keys(build().versions).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(build().schemaVersion).toBe(1);
  });

  it("hashes core files by project path, restoring escaped dotfile names", () => {
    const { core } = build().versions["1.0.0"] ?? { core: {} };
    expect(core).toEqual({
      ".claude/settings.json": sha(SETTINGS),
      ".gitignore": sha(GITIGNORE),
      "README.md": sha(README_1_0),
      "package.json": sha(PKG_1_0),
      "tsconfig.json": sha(TSCONFIG),
    });
  });

  it("reflects each tag's own content, not the latest", () => {
    const history = build();
    expect(history.versions["1.0.0"]?.core["package.json"]).toBe(sha(PKG_1_0));
    expect(history.versions["1.1.0"]?.core["package.json"]).toBe(sha(PKG_1_1));
    expect(history.versions["1.1.0"]?.core["README.md"]).toBe(sha(README_1_1));
  });

  it("hashes pack files by project path (relative to files/, dotfiles restored) and the manifest by raw bytes", () => {
    const demo = build().versions["1.0.0"]?.packs["demo"];
    expect(demo).toEqual({
      manifest: sha(PACK_JSON_1_0),
      files: {
        ".npmrc": sha(NPMRC),
        "docs/notice.md": sha(PACK_TOKENIZED),
        "plain.txt": sha(PACK_PLAIN),
      },
    });
  });

  it("sees a pack file added in a later release only from that release", () => {
    const history = build();
    expect(history.versions["1.0.0"]?.packs["demo"]?.files).not.toHaveProperty(
      "added.txt",
    );
    expect(history.versions["1.1.0"]?.packs["demo"]?.files).toHaveProperty(
      "added.txt",
    );
    expect(history.versions["1.1.0"]?.packs["demo"]?.manifest).toBe(
      sha(PACK_JSON_1_1),
    );
  });

  it("never records files outside templates/core and templates/packs", () => {
    const text = JSON.stringify(build());
    expect(text).not.toContain("unrelated");
    expect(text).not.toContain(sha("not a template\n"));
  });

  it("keeps full text only for tokenized files, pack.json, package.json, tsconfig*.json and .claude/settings.json", () => {
    const { blobs } = build();
    expect(blobs[sha(PKG_1_0)]).toBe(PKG_1_0);
    expect(blobs[sha(PKG_1_1)]).toBe(PKG_1_1);
    expect(blobs[sha(PACK_TOKENIZED)]).toBe(PACK_TOKENIZED);
    expect(blobs[sha(PACK_JSON_1_0)]).toBe(PACK_JSON_1_0);
    expect(blobs[sha(PACK_JSON_1_1)]).toBe(PACK_JSON_1_1);
    expect(blobs[sha(TSCONFIG)]).toBe(TSCONFIG);
    expect(blobs[sha(SETTINGS)]).toBe(SETTINGS);
  });

  it("keeps hashes only for every other file", () => {
    const { blobs } = build();
    for (const text of [README_1_0, README_1_1, GITIGNORE, PACK_PLAIN, NPMRC]) {
      expect(blobs).not.toHaveProperty(sha(text));
    }
  });

  it("keys every blob by the sha256 of its own text", () => {
    for (const [key, text] of Object.entries(build().blobs)) {
      expect(key).toBe(sha(text));
    }
  });

  it("is deterministic: two runs serialize to identical bytes", () => {
    expect(lib.serializeTemplateHistory(build())).toBe(
      lib.serializeTemplateHistory(build()),
    );
  });

  it("honours a custom tagPrefix", () => {
    git("tag", "pkg-7.0.0", "@monte3l/groundwork@1.0.0");
    const history = lib.buildTemplateHistory({
      repoDir: repo,
      tagPrefix: "pkg-",
    });
    expect(Object.keys(history.versions)).toEqual(["7.0.0"]);
    expect(history.versions["7.0.0"]?.core["package.json"]).toBe(sha(PKG_1_0));
  });
});

/** True when every object in `value` lists its keys in default sort order. */
function keysSortedDeep(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  return (
    keys.every((key, index) => key === sorted[index]) &&
    Object.values(value).every(keysSortedDeep)
  );
}

describe("serializeTemplateHistory", () => {
  it("writes 2-space JSON with a trailing newline", () => {
    const history = build();
    const text = lib.serializeTemplateHistory(history);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + "\n");
  });

  it("sorts every object's keys, however the input was ordered", () => {
    const history = build();
    const shuffled = {
      blobs: Object.fromEntries(Object.entries(history.blobs).reverse()),
      versions: Object.fromEntries(
        Object.entries(history.versions)
          .reverse()
          .map(([version, entry]) => [
            version,
            {
              packs: entry.packs,
              core: Object.fromEntries(Object.entries(entry.core).reverse()),
            },
          ]),
      ),
      schemaVersion: history.schemaVersion,
    };
    const text = lib.serializeTemplateHistory(shuffled);
    expect(keysSortedDeep(JSON.parse(text))).toBe(true);
    expect(text).toBe(lib.serializeTemplateHistory(history));
  });
});

const CHANGELOG = [
  "# Changelog",
  "",
  "## [1.1.0](https://example.com/compare/a...b) (2026-01-02)",
  "",
  "## [1.0.0](https://example.com/compare/c...d) (2026-01-01)",
  "",
  "## 0.9.0",
  "",
].join("\n");

describe("checkTemplateHistory", () => {
  function check(
    text: string,
    options: { changelogText?: string; currentVersion?: string } = {},
  ): string[] {
    return lib.checkTemplateHistory({
      text,
      changelogText: options.changelogText ?? CHANGELOG,
      currentVersion: options.currentVersion ?? "1.2.0",
    });
  }

  it("passes a generated history that covers the changelog", () => {
    expect(check(lib.serializeTemplateHistory(build()))).toEqual([]);
  });

  it("reports a problem for text that is not JSON", () => {
    expect(check("{ nope").join("\n")).toMatch(/json/i);
  });

  it("reports a problem for an empty file", () => {
    expect(check("")).not.toEqual([]);
  });

  it("reports a wrong schemaVersion, naming it", () => {
    const wrong = JSON.stringify({ ...build(), schemaVersion: 2 }, null, 2);
    expect(check(wrong).join("\n")).toMatch(/schemaVersion/);
  });

  it("reports unsorted keys", () => {
    const history = build();
    const unsorted = JSON.stringify(
      {
        schemaVersion: 1,
        versions: history.versions,
        blobs: Object.fromEntries(Object.entries(history.blobs).reverse()),
      },
      null,
      2,
    );
    expect(Object.keys(history.blobs).length).toBeGreaterThan(1);
    expect(check(unsorted).join("\n")).toMatch(/sorted/i);
  });

  it("reports unsorted keys deep in a version's core", () => {
    const history = build();
    const core = history.versions["1.0.0"]?.core ?? {};
    const unsorted = JSON.stringify(
      {
        ...history,
        versions: {
          ...history.versions,
          "1.0.0": {
            ...history.versions["1.0.0"],
            core: Object.fromEntries(Object.entries(core).reverse()),
          },
        },
      },
      null,
      2,
    );
    expect(check(unsorted).join("\n")).toMatch(/sorted/i);
  });

  it("reports a blob whose key is not the sha256 of its text", () => {
    const history = build();
    const forged = { ...history.blobs, [sha("other")]: "not other" };
    const text = lib.serializeTemplateHistory({ ...history, blobs: forged });
    const problems = check(text);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(sha("other"));
  });

  it("reports a released version missing from the history", () => {
    const history = build();
    const { "1.1.0": _dropped, ...rest } = history.versions;
    const text = lib.serializeTemplateHistory({ ...history, versions: rest });
    expect(check(text).join("\n")).toContain("1.1.0");
  });

  it("excepts the version being released from the changelog coverage check", () => {
    const history = build();
    const { "1.1.0": _dropped, ...rest } = history.versions;
    const text = lib.serializeTemplateHistory({ ...history, versions: rest });
    expect(check(text, { currentVersion: "1.1.0" })).toEqual([]);
  });

  it("does not except a released version that is not the current one", () => {
    const history = build();
    const { "1.0.0": _dropped, ...rest } = history.versions;
    const text = lib.serializeTemplateHistory({ ...history, versions: rest });
    expect(check(text, { currentVersion: "1.1.0" }).join("\n")).toContain(
      "1.0.0",
    );
  });

  it("ignores changelog headings that are not bracketed releases", () => {
    const text = lib.serializeTemplateHistory(build());
    expect(
      check(text, { changelogText: "## 7.7.7\n\n## [1.0.0](x)\n" }),
    ).toEqual([]);
  });

  it("needs no tags: it works from the text alone", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const text = lib.serializeTemplateHistory({
      schemaVersion: 1,
      versions: {},
      blobs: {},
    });
    expect(check(text, { changelogText: "", currentVersion: "1.0.0" })).toEqual(
      [],
    );
  });
});

describe("generator guards", () => {
  const goodHistory = (): History => {
    const manifestText = '{"name":"demo"}\n';
    return {
      schemaVersion: 1,
      versions: {
        "1.0.0": {
          core: {},
          packs: { demo: { manifest: sha(manifestText), files: {} } },
        },
      },
      blobs: { [sha(manifestText)]: manifestText },
    };
  };

  it("assertBuildable accepts a well-formed history", () => {
    expect(() => lib.assertBuildable(goodHistory())).not.toThrow();
  });

  it("assertBuildable throws an Error naming the problem when there are zero versions", () => {
    expect(() =>
      lib.assertBuildable({ schemaVersion: 1, versions: {}, blobs: {} }),
    ).toThrowError(/tag|version/i);
  });

  it("assertBuildable throws when the built output fails checkTemplateHistory", () => {
    const history = goodHistory();
    history.blobs = {};
    expect(() => lib.assertBuildable(history)).toThrowError(/blob|manifest/i);
  });

  it("the entry script refuses a repo with zero stable tags: non-zero exit, existing file untouched, message names tags", () => {
    const untagged = mkdtempSync(join(tmpdir(), "template-history-untagged-"));
    try {
      const run = (...args: string[]): void => {
        const result = spawnSync(
          "git",
          ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
          { cwd: untagged, env: GIT_ENV, encoding: "utf8" },
        );
        if (result.status !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
        }
      };
      run("init", "-q");
      const outRel = "packages/cli/data/template-history.json";
      mkdirSync(join(untagged, "templates/core"), { recursive: true });
      writeFileSync(join(untagged, "templates/core/README.md"), "x\n");
      mkdirSync(join(untagged, dirname(outRel)), { recursive: true });
      writeFileSync(join(untagged, outRel), "PRE-EXISTING\n");
      run("add", "-A");
      run("commit", "-m", "init");
      const result = spawnSync(
        "node",
        [join(repoRoot, "bin", "build-template-history.mjs")],
        { cwd: untagged, env: GIT_ENV, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(untagged, outRel), "utf8")).toBe(
        "PRE-EXISTING\n",
      );
      expect(`${result.stdout}${result.stderr}`).toMatch(/tag/i);
    } finally {
      rmSync(untagged, { recursive: true, force: true });
    }
  });
});

describe("checkTemplateHistory: manifest blobs and a missing file", () => {
  const manifest = "b".repeat(64);
  const textOf = (blobs: Record<string, string>): string =>
    lib.serializeTemplateHistory({
      schemaVersion: 1,
      versions: {
        "1.0.0": {
          core: {},
          packs: { demo: { manifest, files: {} } },
        },
      },
      blobs,
    });

  it("reports a manifest with no entry in blobs, naming the version, pack and hash", () => {
    const problems = lib.checkTemplateHistory({
      text: textOf({}),
      changelogText: "",
      currentVersion: "9.9.9",
    });
    expect(
      problems.some(
        (p) =>
          p.includes("1.0.0") && p.includes("demo") && p.includes(manifest),
      ),
    ).toBe(true);
  });

  it("reports a missing file (text: null) with its path and the regeneration command, not 'empty'", () => {
    const problems = lib.checkTemplateHistory({
      text: null,
      path: "packages/cli/data/template-history.json",
      changelogText: "",
      currentVersion: "9.9.9",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("packages/cli/data/template-history.json");
    expect(problems[0]).toContain("node bin/build-template-history.mjs");
    expect(problems[0]).not.toMatch(/empty/i);
  });
});

describe("dotfile restore map parity with packages/cli/src/assets.ts", () => {
  /** Real names: a fixed superset plus every dotfile and escaped name in the template trees. */
  const found = new Set<string>();
  for (const dir of ["core", "packs"]) {
    for (const entry of readdirSync(join(repoRoot, "templates", dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
        found.add(entry.name);
      }
    }
  }
  const names = [
    ...new Set([
      ".gitignore",
      ".npmrc",
      ".npmignore",
      "package-lock.json",
      ".gitattributes",
      ".editorconfig",
      ".env",
      "package.json",
      "README.md",
      "_package.json",
      "_other",
      ...found,
    ]),
  ];

  it.each(names)("%s: both directions agree, flat and nested", (name) => {
    const escaped = escapeDotfileName(name);
    for (const prefix of ["", "a/", ".claude/hooks/b/"]) {
      // real -> escaped -> restored, through the generator's map
      expect(lib.restoreDotfilePath(`${prefix}${escaped}`)).toBe(
        assetsRestore(`${prefix}${escaped}`),
      );
      // the name as vendored (it may itself be an unescaped input)
      expect(lib.restoreDotfilePath(`${prefix}${name}`)).toBe(
        assetsRestore(`${prefix}${name}`),
      );
    }
  });
});
