// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Backfill tests for `.claude/hooks/nudge-invariants.mjs`'s exported,
 * side-effect-free helpers (`statusLine`, `isNewFile`, `isDirty`, `anyDirty`,
 * `hasSpdxHeader`, and the main `computeInvariantNotes` decision function).
 * The module's `isEntryPoint()` guard keeps the stdin-read-and-exit side
 * effects out of a plain `import()`, same convention as
 * `guard-hub-src-writes.test.ts`'s `shouldBlockHubSrcWrite`.
 *
 * `computeInvariantNotes` shells out to real `git status` for its dirty/new
 * checks, so each test builds a throwaway git repository under a per-test
 * `mkdtemp` sandbox (torn down in the same test via `finally`), pre-seeded
 * with placeholder files at every twin path any rule in `computeInvariantNotes`
 * itself references (read that function for the current rule set -- restating
 * a count here would only drift). This mirrors `core-hooks.test.ts`'s
 * `envWithoutRepoLocals` isolation so an inherited `GIT_DIR` (a git hook, or a
 * session in a linked worktree) can never redirect these throwaway `git`
 * calls at the real repository.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const hookPath = join(repoRoot, ".claude", "hooks", "nudge-invariants.mjs");

// Plain ESM under .claude/hooks/, outside every tsconfig -- loaded by URL
// (see guard-hub-src-writes.test.ts for the same pattern). Its own relative
// import of `../../bin/lib/hook-input.mjs` resolves against its real
// location in the checkout, so no mirroring of that file is needed here.
const hook = (await import(pathToFileURL(hookPath).href)) as {
  isExcludedHookPath: (rel: string) => boolean;
  statusLine: (
    target: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) => string | undefined;
  isNewFile: (target: string, cwd: string, env?: NodeJS.ProcessEnv) => boolean;
  isDirty: (target: string, cwd: string, env?: NodeJS.ProcessEnv) => boolean;
  anyDirty: (
    targets: string[],
    projectDir: string,
    env?: NodeJS.ProcessEnv,
  ) => boolean;
  hasSpdxHeader: (target: string) => boolean;
  HEADER_ELIGIBLE_EXT: RegExp;
  HARNESS_TS_GLOB: RegExp;
  HARNESS_JS_TWINS: string[];
  HARNESS_TWIN_GLOB: RegExp;
  HARNESS_TS_TWINS: string[];
  TOOLCHAIN_TS_GLOB: RegExp;
  TOOLCHAIN_TWIN: string;
  TOOLCHAIN_TS_TWINS: string[];
  computeInvariantNotes: (
    rel: string,
    abs: string,
    projectDir: string,
    env?: NodeJS.ProcessEnv,
  ) => string[];
};

/** The parent environment minus repository-local git variables (`GIT_DIR`,
 * `GIT_WORK_TREE`, ...) -- see `core-hooks.test.ts`'s identical helper for
 * why an inherited `GIT_DIR` must never leak into a throwaway fixture repo. */
function envWithoutRepoLocals(): NodeJS.ProcessEnv {
  const listed = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  });
  const local = new Set(
    listed.status === 0
      ? listed.stdout.split("\n").filter(Boolean)
      : ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"],
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !local.has(name)),
  );
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: envWithoutRepoLocals(),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function gitCommit(cwd: string, message: string): void {
  git(cwd, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Every twin path the six `computeInvariantNotes` rules reference, seeded
 * with placeholder content and committed in the fixture's initial commit so
 * each is tracked-and-clean by default -- a test only needs to touch the
 * specific file(s) whose dirty/new state it wants to flip. */
function baselineFiles(): Array<[string, string]> {
  return [
    ["packages/cli/src/harness/frontmatter.ts", "export const a = 1;\n"],
    ["packages/cli/src/harness/rules.ts", "export const b = 1;\n"],
    ["packages/cli/src/harness/grade.ts", "export const c = 1;\n"],
    ["templates/core/bin/lib/frontmatter.mjs", "export const d = 1;\n"],
    ["templates/core/bin/lib/harness-rules.mjs", "export const e = 1;\n"],
    ["packages/cli/src/toolchain/rules.ts", "export const f = 1;\n"],
    ["packages/cli/src/toolchain/grade.ts", "export const g = 1;\n"],
    ["templates/core/bin/lib/toolchain-rules.mjs", "export const h = 1;\n"],
  ];
}

/** Builds a throwaway git repo with every twin path pre-committed clean. */
function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nudge-invariants-"));
  git(dir, ["init", "-b", "main"]);
  for (const [rel, content] of baselineFiles()) {
    writeFile(dir, rel, content);
  }
  git(dir, ["add", "-A"]);
  gitCommit(dir, "init");
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("isExcludedHookPath (re-exported passthrough)", () => {
  it("excludes a path outside the project, matching bin/lib/hook-input.mjs's own contract", () => {
    expect(hook.isExcludedHookPath("../outside/file.ts")).toBe(true);
  });
});

describe("statusLine", () => {
  it("returns undefined when the cwd is not a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-invariants-nonrepo-"));
    try {
      expect(
        hook.statusLine(join(dir, "x.ts"), dir, envWithoutRepoLocals()),
      ).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("returns an empty string for a clean, committed file", () => {
    const dir = setupRepo();
    try {
      expect(
        hook.statusLine(
          join(dir, "packages/cli/src/harness/rules.ts"),
          dir,
          envWithoutRepoLocals(),
        ),
      ).toBe("");
    } finally {
      cleanup(dir);
    }
  });

  it("returns an empty string (not undefined) for a path that does not exist at all", () => {
    const dir = setupRepo();
    try {
      expect(
        hook.statusLine(
          join(dir, "does/not/exist.ts"),
          dir,
          envWithoutRepoLocals(),
        ),
      ).toBe("");
    } finally {
      cleanup(dir);
    }
  });
});

describe("isNewFile / isDirty / anyDirty", () => {
  it("isNewFile is true for an untracked file", () => {
    const dir = setupRepo();
    try {
      const target = join(dir, "packages/cli/src/harness/new-thing.ts");
      writeFile(dir, "packages/cli/src/harness/new-thing.ts", "export {};\n");
      expect(hook.isNewFile(target, dir, envWithoutRepoLocals())).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('isNewFile is true for a staged-but-uncommitted add (the `line.startsWith("A")` arm)', () => {
    const dir = setupRepo();
    try {
      const rel = "packages/cli/src/harness/staged-new-thing.ts";
      const target = join(dir, rel);
      writeFile(dir, rel, "export {};\n");
      git(dir, ["add", rel]);
      expect(hook.isNewFile(target, dir, envWithoutRepoLocals())).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("isNewFile is false for a clean, already-committed file", () => {
    const dir = setupRepo();
    try {
      const target = join(dir, "packages/cli/src/harness/rules.ts");
      expect(hook.isNewFile(target, dir, envWithoutRepoLocals())).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("isDirty is true for a modified, already-tracked file", () => {
    const dir = setupRepo();
    try {
      const target = join(dir, "packages/cli/src/harness/rules.ts");
      writeFile(
        dir,
        "packages/cli/src/harness/rules.ts",
        "export const b = 2;\n",
      );
      expect(hook.isDirty(target, dir, envWithoutRepoLocals())).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("isDirty is false for a clean, unchanged file", () => {
    const dir = setupRepo();
    try {
      const target = join(dir, "packages/cli/src/harness/rules.ts");
      expect(hook.isDirty(target, dir, envWithoutRepoLocals())).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("anyDirty is true when any one of several targets is dirty", () => {
    const dir = setupRepo();
    try {
      writeFile(
        dir,
        "templates/core/bin/lib/frontmatter.mjs",
        "export const d = 2;\n",
      );
      expect(
        hook.anyDirty(
          [
            "templates/core/bin/lib/frontmatter.mjs",
            "templates/core/bin/lib/harness-rules.mjs",
          ],
          dir,
          envWithoutRepoLocals(),
        ),
      ).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("anyDirty is false when none of several targets is dirty", () => {
    const dir = setupRepo();
    try {
      expect(
        hook.anyDirty(
          [
            "templates/core/bin/lib/frontmatter.mjs",
            "templates/core/bin/lib/harness-rules.mjs",
          ],
          dir,
          envWithoutRepoLocals(),
        ),
      ).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe("hasSpdxHeader", () => {
  it("is true when the file's first 2000 bytes contain the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-invariants-spdx-"));
    try {
      writeFile(
        dir,
        "with-header.mjs",
        "// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors\nexport {};\n",
      );
      expect(hook.hasSpdxHeader(join(dir, "with-header.mjs"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("is false when the file has no marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-invariants-spdx-"));
    try {
      writeFile(dir, "no-header.mjs", "export {};\n");
      expect(hook.hasSpdxHeader(join(dir, "no-header.mjs"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("is false, not a throw, for a nonexistent file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-invariants-spdx-"));
    try {
      expect(hook.hasSpdxHeader(join(dir, "does-not-exist.mjs"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe("computeInvariantNotes", () => {
  it("returns an empty array when no rule matches", () => {
    const dir = setupRepo();
    try {
      const rel = "packages/cli/src/main.ts";
      writeFile(dir, rel, "export {};\n");
      git(dir, ["add", "-A"]);
      gitCommit(dir, "add main.ts");
      expect(
        hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        ),
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  describe("rule 1: harness TS-side glob -> JS twins", () => {
    const rel = "packages/cli/src/harness/rules.ts";

    it("note present when neither HARNESS_JS_TWINS file is dirty", () => {
      const dir = setupRepo();
      try {
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("emitted JS twin");
      } finally {
        cleanup(dir);
      }
    });

    it("suppressed when frontmatter.mjs (one of the two JS twins) is already dirty", () => {
      const dir = setupRepo();
      try {
        writeFile(
          dir,
          "templates/core/bin/lib/frontmatter.mjs",
          "export const d = 2;\n",
        );
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });

    it("suppressed when harness-rules.mjs (the OTHER of the two JS twins) is already dirty", () => {
      const dir = setupRepo();
      try {
        writeFile(
          dir,
          "templates/core/bin/lib/harness-rules.mjs",
          "export const e = 2;\n",
        );
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe("rule 2: harness JS-side twin -> TS twins", () => {
    const rel = "templates/core/bin/lib/frontmatter.mjs";
    const otherTwinRel = "templates/core/bin/lib/harness-rules.mjs";

    it("note present when none of HARNESS_TS_TWINS is dirty", () => {
      const dir = setupRepo();
      try {
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("emitted harness grader twin");
      } finally {
        cleanup(dir);
      }
    });

    it("HARNESS_TWIN_GLOB also matches the OTHER twin file (harness-rules.mjs)", () => {
      const dir = setupRepo();
      try {
        const notes = hook.computeInvariantNotes(
          otherTwinRel,
          join(dir, otherTwinRel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("emitted harness grader twin");
      } finally {
        cleanup(dir);
      }
    });

    describe("HARNESS_TWIN_GLOB anchoring/escaping", () => {
      it("does NOT match when the dot before the extension is any other character (proves `.` is escaped, not a wildcard)", () => {
        expect(
          hook.HARNESS_TWIN_GLOB.test("templates/core/bin/lib/frontmatterXmjs"),
        ).toBe(false);
      });

      it("does NOT match a path with an extra suffix after the real twin path (proves the pattern is anchored with `$`, not a prefix match)", () => {
        expect(
          hook.HARNESS_TWIN_GLOB.test(
            "templates/core/bin/lib/frontmatter.mjs.bak",
          ),
        ).toBe(false);
      });

      it("still matches the real, exact twin path (sanity pin for the two negatives above)", () => {
        expect(
          hook.HARNESS_TWIN_GLOB.test("templates/core/bin/lib/frontmatter.mjs"),
        ).toBe(true);
      });
    });

    it.each([
      ["packages/cli/src/harness/frontmatter.ts"],
      ["packages/cli/src/harness/rules.ts"],
      ["packages/cli/src/harness/grade.ts"],
    ])(
      "suppressed when %s (one of the three TS twins) is already dirty",
      (tsTwin) => {
        const dir = setupRepo();
        try {
          writeFile(dir, tsTwin, "export const x = 2;\n");
          expect(
            hook.computeInvariantNotes(
              rel,
              join(dir, rel),
              dir,
              envWithoutRepoLocals(),
            ),
          ).toEqual([]);
        } finally {
          cleanup(dir);
        }
      },
    );
  });

  describe("rule 3: toolchain TS-side glob -> single JS twin", () => {
    const rel = "packages/cli/src/toolchain/rules.ts";

    it("note present when the toolchain JS twin is not dirty", () => {
      const dir = setupRepo();
      try {
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("emitted JS twin");
        expect(notes[0]).toContain("toolchain-rules.mjs");
      } finally {
        cleanup(dir);
      }
    });

    it("suppressed when the toolchain JS twin is already dirty", () => {
      const dir = setupRepo();
      try {
        writeFile(
          dir,
          "templates/core/bin/lib/toolchain-rules.mjs",
          "export const h = 2;\n",
        );
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe("rule 4: toolchain JS-side twin -> two TS twins", () => {
    const rel = "templates/core/bin/lib/toolchain-rules.mjs";

    it("note present when neither TOOLCHAIN_TS_TWINS file is dirty", () => {
      const dir = setupRepo();
      try {
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("emitted toolchain grader twin");
      } finally {
        cleanup(dir);
      }
    });

    it.each([
      ["packages/cli/src/toolchain/rules.ts"],
      ["packages/cli/src/toolchain/grade.ts"],
    ])(
      "suppressed when %s (one of the two TS twins) is already dirty",
      (tsTwin) => {
        const dir = setupRepo();
        try {
          writeFile(dir, tsTwin, "export const x = 2;\n");
          expect(
            hook.computeInvariantNotes(
              rel,
              join(dir, rel),
              dir,
              envWithoutRepoLocals(),
            ),
          ).toEqual([]);
        } finally {
          cleanup(dir);
        }
      },
    );
  });

  describe("rule 5: new templates/core file -> domain-map note", () => {
    const rel = "templates/core/some-new-file.md";

    it("note present for a new (untracked) file under templates/core/", () => {
      const dir = setupRepo();
      try {
        writeFile(dir, rel, "# new\n");
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("domain-map.ts");
      } finally {
        cleanup(dir);
      }
    });

    it("no note when the same file is already committed (not new)", () => {
      const dir = setupRepo();
      try {
        writeFile(dir, rel, "# new\n");
        git(dir, ["add", "-A"]);
        gitCommit(dir, "add file");
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe("rule 6: SPDX header on a new file", () => {
    it("note present for a new header-eligible file with no SPDX header", () => {
      const dir = setupRepo();
      try {
        const rel = "packages/cli/src/new-thing.mjs";
        writeFile(dir, rel, "export {};\n");
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("SPDX header");
      } finally {
        cleanup(dir);
      }
    });

    it("no note for the same shape of file when it already carries an SPDX header", () => {
      const dir = setupRepo();
      try {
        const rel = "packages/cli/src/new-thing.mjs";
        writeFile(
          dir,
          rel,
          "// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors\nexport {};\n",
        );
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });

    it("no note for a new, header-less file under templates/ (SPDX rule explicitly excludes templates/)", () => {
      const dir = setupRepo();
      try {
        // Deliberately NOT under templates/core/ -- that would also trip
        // rule 5's domain-map note, muddying this test's own claim. Any
        // `templates/` prefix is enough to exercise the SPDX rule's own
        // `!rel.startsWith("templates/")` exclusion.
        const rel = "templates/packs/some-pack/new-script.mjs";
        writeFile(dir, rel, "export {};\n");
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });

    it("no note for a new, header-less file OUTSIDE templates/ whose extension is not HEADER_ELIGIBLE_EXT (proves the extension check, not just isNewFile, gates this rule)", () => {
      const dir = setupRepo();
      try {
        // `.md` is not in HEADER_ELIGIBLE_EXT (`ts|mjs|js|sh|yml|yaml`). If
        // this fired anyway, the extension condition would be redundant with
        // the `isNewFile` check rather than load-bearing on its own.
        const rel = "docs/new-thing.md";
        writeFile(dir, rel, "# new\n");
        expect(
          hook.computeInvariantNotes(
            rel,
            join(dir, rel),
            dir,
            envWithoutRepoLocals(),
          ),
        ).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe("design tokens rule", () => {
    it("note present for a design/source/ edit, unconditionally (no dirty-suppression on this rule)", () => {
      const dir = setupRepo();
      try {
        const rel = "design/source/tokens.json";
        writeFile(dir, rel, "{}\n");
        git(dir, ["add", "-A"]);
        gitCommit(dir, "add design source");
        // Already committed (not new) and nothing else is dirty -- the note
        // still fires, confirming the rule has no suppression guard, unlike
        // the harness/toolchain twin rules above.
        const notes = hook.computeInvariantNotes(
          rel,
          join(dir, rel),
          dir,
          envWithoutRepoLocals(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("design/tokens.css");
      } finally {
        cleanup(dir);
      }
    });
  });
});

/**
 * Subprocess coverage for the actual entry-point wrapper (stdin read,
 * `isEntryPoint()` guard, exit code, stderr shape) -- everything above this
 * point only ever calls the exported pure functions directly, so none of it
 * proves the guard at the bottom of the module actually fires. Same pattern
 * as `guard-hub-src-writes.test.ts`'s own `describe("guard-hub-src-writes
 * entry point (subprocess)", ...)` block.
 */
describe("nudge-invariants entry point (subprocess)", () => {
  function run(
    repoDir: string,
    filePath: string,
  ): { status: number | null; stderr: string } {
    const result = spawnSync("node", [hookPath], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      cwd: repoDir,
      env: { ...envWithoutRepoLocals(), CLAUDE_PROJECT_DIR: repoDir },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr };
  }

  it("exits 2 with a reminder on stderr for a file_path matching one of the rules, with nothing suppressing it", () => {
    const dir = setupRepo();
    try {
      const rel = "packages/cli/src/new-thing.mjs";
      // New, header-less, header-eligible, outside templates/ -- trips
      // rule 6 (SPDX header) with no suppression condition to satisfy.
      writeFile(dir, rel, "export {};\n");

      const { status, stderr } = run(dir, rel);

      expect(status).toBe(2);
      expect(stderr).toContain("Invariant reminder");
      expect(stderr).toContain("SPDX header");
    } finally {
      cleanup(dir);
    }
  });

  it("exits 0 with no reminder for an excluded path (under node_modules/)", () => {
    const dir = setupRepo();
    try {
      const rel = "node_modules/some-dep/index.js";
      // New, header-less, header-eligible file that WOULD trip rule 6 (SPDX
      // header) like the test above if the exclusion didn't short-circuit
      // first -- without this write the path never exists on disk, `git
      // status` reports nothing for it, `isNewFile` is false, and no rule
      // fires regardless of whether the exclusion check works at all.
      writeFile(dir, rel, "export {};\n");

      const { status, stderr } = run(dir, rel);

      expect(status).toBe(0);
      expect(stderr).not.toContain("Invariant reminder");
    } finally {
      cleanup(dir);
    }
  });
});
