// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Regression tests for two bugs in `harness-extras`'s compaction-handoff hook
 * pair (`write-compact-handoff.mjs`, PreCompact; `reinject-compact-handoff.mjs`,
 * SessionStart):
 *
 * 1. Both hooks resolved their root from
 *    `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`. Claude Code pins
 *    `CLAUDE_PROJECT_DIR` to the session's ORIGINAL checkout and does not move
 *    it into a linked worktree, so a handoff written from inside a worktree
 *    recorded the wrong checkout. The hook payload carries `cwd` (the
 *    worktree the session actually runs in) and `session_id`, which the fixed
 *    contract (`resolveRoot`/`writeHandoff`) must prefer.
 * 2. Every session shared one `tmp/compact-handoff.json`, so any session's
 *    `startup`/`resume` reinject could read AND DELETE another session's
 *    still-pending handoff. The fixed contract keys the artifact by
 *    `session_id` (`handoffRelPath`) and `findHandoffPath` only ever falls
 *    back to another session's file for orphan recovery (`resume`/`startup`),
 *    never for a plain `compact` reinject.
 *
 * The hooks live under `templates/packs/harness-extras/files/.claude/hooks/`
 * and import each other by relative path, so both are copied into a temp dir
 * mirroring the emitted layout (`<tmp>/.claude/hooks/*.mjs`) and loaded via
 * `import()` + `pathToFileURL` -- the same pattern `guard-readonly-bash.test.ts`
 * uses for a hook with a cross-file dependency. Git behavior is exercised
 * against real throwaway repos (`mkdtemp` + `git init`/`worktree add`), torn
 * down per test -- the contract here IS filesystem+git behavior, so mocking
 * git would test nothing. Every git invocation pins identity/signing via `-c`
 * flags so the machine's own signing config can't interfere, mirroring
 * `core-hooks.test.ts`'s `envWithoutRepoLocals()` guard against an ambient
 * `GIT_DIR` leaking in from a session already running inside a worktree.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const hooksSourceDir = join(
  repoRoot,
  "templates",
  "packs",
  "harness-extras",
  "files",
  ".claude",
  "hooks",
);

type HandoffEnv = Record<string, string | undefined>;

interface WriteHandoffModule {
  runGit: (args: string[], cwd?: string) => string | null;
  currentBranch: (cwd?: string) => string;
  currentWorktree: (cwd?: string) => string;
  lastCommitInfo: (cwd?: string) => { sha: string; signature: string } | null;
  uncommittedFiles: (cwd?: string) => string[] | null;
  findScratchJournals: (repoRoot: string) => string[];
  buildHandoff: (cwd?: string, worktree?: string) => Record<string, unknown>;
  handoffRelPath: (sessionId: unknown) => string;
  resolveRoot: (input: unknown, env: HandoffEnv, fallbackCwd: string) => string;
  writeHandoff: (
    input: unknown,
    env: HandoffEnv,
    fallbackCwd: string,
  ) => string | null;
}

interface ReinjectHandoffModule {
  isStale: (handoff: Record<string, unknown>, nowMs?: number) => boolean;
  formatHandoff: (handoff: Record<string, unknown>, nowMs?: number) => string;
  shouldReinject: (input: unknown) => boolean;
  readHandoff: (handoffPath: string) => Record<string, unknown> | null;
  REINJECT_SOURCES: Set<string>;
  findHandoffPath: (
    root: string,
    sessionId: unknown,
    source: string,
  ) => string | null;
  ORPHAN_MIN_AGE_MS: number;
  STALE_THRESHOLD_MS: number;
}

let scratch: string;
let writeMod: WriteHandoffModule;
let reinjectMod: ReinjectHandoffModule;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "compact-handoff-mod-"));
  mkdirSync(join(scratch, ".claude", "hooks"), { recursive: true });
  copyFileSync(
    join(hooksSourceDir, "write-compact-handoff.mjs"),
    join(scratch, ".claude", "hooks", "write-compact-handoff.mjs"),
  );
  copyFileSync(
    join(hooksSourceDir, "reinject-compact-handoff.mjs"),
    join(scratch, ".claude", "hooks", "reinject-compact-handoff.mjs"),
  );
  writeMod = (await import(
    pathToFileURL(
      join(scratch, ".claude", "hooks", "write-compact-handoff.mjs"),
    ).href
  )) as WriteHandoffModule;
  reinjectMod = (await import(
    pathToFileURL(
      join(scratch, ".claude", "hooks", "reinject-compact-handoff.mjs"),
    ).href
  )) as ReinjectHandoffModule;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The parent environment minus the variables git itself calls
 * repository-local (`git rev-parse --local-env-vars`). A session already
 * running inside a linked worktree can export an absolute `GIT_DIR`; a child
 * that inherited it would ignore its own `cwd` and run against the
 * developer's real repository instead of the fixture. Same helper as
 * `core-hooks.test.ts`/`post-edit-verify.test.ts`.
 */
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

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: envWithoutRepoLocals() },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

describe("handoffRelPath", () => {
  const cases: Array<[unknown, string]> = [
    ["abc123", "tmp/compact-handoff-abc123.json"],
    ["abc-DEF_123", "tmp/compact-handoff-abc-DEF_123.json"],
    ["a".repeat(128), `tmp/compact-handoff-${"a".repeat(128)}.json`],
    ["a".repeat(129), "tmp/compact-handoff.json"],
    ["../x", "tmp/compact-handoff.json"],
    ["..", "tmp/compact-handoff.json"],
    ["a/b", "tmp/compact-handoff.json"],
    ["has space", "tmp/compact-handoff.json"],
    ["", "tmp/compact-handoff.json"],
    [undefined, "tmp/compact-handoff.json"],
    [42, "tmp/compact-handoff.json"],
  ];

  it.each(cases)("maps session id %o to %s", (sessionId, expected) => {
    expect(writeMod.handoffRelPath(sessionId)).toBe(expected);
  });
});

describe("resolveRoot", () => {
  it("prefers input.cwd over env and fallbackCwd", () => {
    expect(
      writeMod.resolveRoot({ cwd: "/a" }, { CLAUDE_PROJECT_DIR: "/b" }, "/c"),
    ).toBe("/a");
  });

  it("falls back to env.CLAUDE_PROJECT_DIR when input has no cwd", () => {
    expect(writeMod.resolveRoot(null, { CLAUDE_PROJECT_DIR: "/b" }, "/c")).toBe(
      "/b",
    );
  });

  it("ignores an empty-string input.cwd and falls through to env", () => {
    expect(
      writeMod.resolveRoot({ cwd: "" }, { CLAUDE_PROJECT_DIR: "/b" }, "/c"),
    ).toBe("/b");
  });

  it("ignores an empty-string env.CLAUDE_PROJECT_DIR and falls through to fallbackCwd", () => {
    expect(writeMod.resolveRoot(null, { CLAUDE_PROJECT_DIR: "" }, "/c")).toBe(
      "/c",
    );
  });

  it("falls back to fallbackCwd when input is null and env is unset", () => {
    expect(writeMod.resolveRoot(null, {}, "/c")).toBe("/c");
  });

  it("tolerates a non-object input (string), falling through to fallbackCwd", () => {
    expect(writeMod.resolveRoot("not-an-object", {}, "/c")).toBe("/c");
  });

  it("tolerates a non-object input (number), still consulting env", () => {
    expect(writeMod.resolveRoot(42, { CLAUDE_PROJECT_DIR: "/b" }, "/c")).toBe(
      "/b",
    );
  });
});

describe("writeHandoff", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "compact-handoff-repo-"));
    dirs.push(dir);
    git(dir, "init", "-b", "main");
    git(dir, "commit", "--allow-empty", "-m", "init");
    return dir;
  }

  it("writes a session-keyed file at <toplevel>/tmp/ and returns its path", () => {
    const repo = makeRepo();
    const written = writeMod.writeHandoff(
      { cwd: repo, session_id: "sess-a" },
      {},
      repo,
    );
    expect(written).toBe(join(repo, "tmp", "compact-handoff-sess-a.json"));
    expect(existsSync(written ?? "")).toBe(true);

    const payload = JSON.parse(readFileSync(written ?? "", "utf8")) as {
      sessionId: unknown;
      branch: unknown;
    };
    expect(payload.sessionId).toBe("sess-a");
    expect(payload.branch).toBe("main");
  });

  it("writes two distinct files for two session ids in the same repo", () => {
    const repo = makeRepo();
    const a = writeMod.writeHandoff(
      { cwd: repo, session_id: "sess-a" },
      {},
      repo,
    );
    const b = writeMod.writeHandoff(
      { cwd: repo, session_id: "sess-b" },
      {},
      repo,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(existsSync(a ?? "")).toBe(true);
    expect(existsSync(b ?? "")).toBe(true);
  });

  it("resolves the worktree's own toplevel, branch and tmp/ -- not the main checkout's -- when cwd sits inside a linked worktree", () => {
    const mainRepo = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), "compact-handoff-wt-"));
    dirs.push(wtParent);
    const worktreeDir = join(wtParent, "wt");
    git(mainRepo, "worktree", "add", "-b", "feature/x", worktreeDir);

    // A subdirectory inside the worktree -- proves toplevel resolution, not
    // just "cwd happens to equal the worktree root".
    const sub = join(worktreeDir, "sub");
    mkdirSync(sub, { recursive: true });

    const written = writeMod.writeHandoff(
      { cwd: sub, session_id: "sess-wt" },
      { CLAUDE_PROJECT_DIR: mainRepo },
      mainRepo,
    );

    expect(written).toBe(
      join(worktreeDir, "tmp", "compact-handoff-sess-wt.json"),
    );
    expect(existsSync(written ?? "")).toBe(true);

    const payload = JSON.parse(readFileSync(written ?? "", "utf8")) as {
      branch: unknown;
      worktree: unknown;
    };
    expect(payload.branch).toBe("feature/x");
    expect(payload.worktree).toBe(worktreeDir);

    // The main checkout (named by CLAUDE_PROJECT_DIR) must get no file at all.
    expect(existsSync(join(mainRepo, "tmp"))).toBe(false);
  });

  // PR #83 review (round 3, third bot review): the handoff exists to record
  // GIT state (branch, last commit, uncommitted files) for the next session
  // to reconstruct from -- outside a git repository entirely there is no
  // such state to record, and writing anyway litters whatever directory the
  // session happened to start in (which, for a non-repo `cwd`, could be
  // `$HOME` itself) with a stray `tmp/compact-handoff-*.json`. The correct
  // contract is a no-op: return null and create nothing at all, the same
  // "advisory, never litters" shape `writeHandoff` already gives a removed
  // worktree. Verified against the pushed hook: it currently DOES write a
  // file here (this replaces the prior test, which pinned that behavior).
  it("returns null and creates nothing when cwd is not inside a git repository at all", () => {
    const plain = mkdtempSync(join(tmpdir(), "compact-handoff-nonrepo-"));
    dirs.push(plain);
    let written: string | null | undefined;
    expect(() => {
      written = writeMod.writeHandoff(
        { cwd: plain, session_id: "s" },
        {},
        plain,
      );
    }).not.toThrow();
    expect(written).toBeNull();
    expect(existsSync(join(plain, "tmp"))).toBe(false);
  });

  it("returns null without throwing when the tmp/ target cannot be created", () => {
    const repo = makeRepo();
    // Block mkdirSync(tmp, { recursive: true }) by placing a plain FILE
    // where the tmp/ directory needs to go -- deterministic across
    // platforms/CI users, unlike a permission-bit approach.
    writeFileSync(join(repo, "tmp"), "not a directory");
    let written: string | null | undefined;
    expect(() => {
      written = writeMod.writeHandoff({ cwd: repo, session_id: "s" }, {}, repo);
    }).not.toThrow();
    expect(written).toBeNull();
  });

  it("writes a diagnostic line to stderr beginning 'write-compact-handoff: handoff not written' when the write fails", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "tmp"), "not a directory");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const written = writeMod.writeHandoff(
        { cwd: repo, session_id: "s" },
        {},
        repo,
      );
      expect(written).toBeNull();
      const messages = stderrSpy.mock.calls.map(([chunk]) => String(chunk));
      expect(
        messages.some((m) =>
          m.startsWith("write-compact-handoff: handoff not written"),
        ),
      ).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("returns null and creates nothing when cwd names a removed worktree (directory does not exist)", () => {
    const parent = mkdtempSync(join(tmpdir(), "compact-handoff-removed-"));
    dirs.push(parent);
    const removed = join(parent, "gone");
    const written = writeMod.writeHandoff(
      { cwd: removed, session_id: "s" },
      {},
      removed,
    );
    expect(written).toBeNull();
    expect(existsSync(removed)).toBe(false);
  });

  it("leaves no temp/partial artifact behind after a successful write, and any final name still matches findHandoffPath's own scan pattern", () => {
    const repo = makeRepo();
    const written = writeMod.writeHandoff(
      { cwd: repo, session_id: "sess-atomic" },
      {},
      repo,
    );
    expect(written).not.toBeNull();
    const entries = readdirSync(join(repo, "tmp"));
    const handoffLike = entries.filter((name) =>
      /^compact-handoff.*\.json$/.test(name),
    );
    // Exactly the one final artifact -- no `.partial`/temp sibling left
    // behind, and nothing under a name shaped so it would itself be
    // (mis)picked up by a later orphan-recovery scan.
    expect(handoffLike).toEqual(["compact-handoff-sess-atomic.json"]);
  });

  it("fully replaces pre-existing content at the target path rather than leaving old bytes behind", () => {
    const repo = makeRepo();
    const target = join(repo, "tmp", "compact-handoff-sess-replace.json");
    mkdirSync(join(repo, "tmp"), { recursive: true });
    // Much longer than any real payload, so leftover bytes from a
    // non-atomic in-place write would be trivially detectable.
    writeFileSync(target, "x".repeat(5000));

    const written = writeMod.writeHandoff(
      { cwd: repo, session_id: "sess-replace" },
      {},
      repo,
    );
    expect(written).toBe(target);
    const raw = readFileSync(target, "utf8");
    expect(() => {
      JSON.parse(raw);
    }).not.toThrow();
    expect(raw.startsWith("x")).toBe(false);
    const parsed = JSON.parse(raw) as { sessionId: unknown };
    expect(parsed.sessionId).toBe("sess-replace");
  });
});

describe("uncommittedFiles", () => {
  it("preserves the leading space in a porcelain status line (' M file')", () => {
    const repo = mkdtempSync(join(tmpdir(), "compact-handoff-status-"));
    try {
      git(repo, "init", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "one\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-m", "add a");
      writeFileSync(join(repo, "a.txt"), "two\n");

      const files = writeMod.uncommittedFiles(repo);
      expect(files).toContain(" M a.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null (not []) when git status fails, e.g. cwd is not a repository", () => {
    const plain = mkdtempSync(
      join(tmpdir(), "compact-handoff-nonrepo-status-"),
    );
    try {
      expect(writeMod.uncommittedFiles(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns [] (not null) for a clean repository", () => {
    const repo = mkdtempSync(join(tmpdir(), "compact-handoff-clean-"));
    try {
      git(repo, "init", "-b", "main");
      git(repo, "commit", "--allow-empty", "-m", "init");
      expect(writeMod.uncommittedFiles(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// PR #83 review (round 3, third bot review) asked whether `buildHandoff`
// re-resolves the worktree when `writeHandoff` has already computed it as
// `toplevel`, rather than accepting the precomputed value. `buildHandoff`'s
// second parameter (`worktree = currentWorktree(cwd)`) and `currentWorktree`'s
// own second parameter (`toplevel = runGit(["rev-parse", "--show-toplevel"],
// cwd)`) are both ordinary JS default parameters -- passing an explicit
// second argument skips the default entirely, so the precomputed-toplevel
// path IS directly observable through the public API without mocking
// anything: pass a real, independently-verified toplevel and check it comes
// back verbatim as `worktree` (and, as the strongest proof, pass a bogus one
// and see IT come back verbatim too, which no re-resolution from `cwd` could
// produce).
describe("buildHandoff", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("stores null for uncommittedFiles when git status fails (non-repo cwd)", () => {
    const plain = mkdtempSync(join(tmpdir(), "compact-handoff-buildnonrepo-"));
    dirs.push(plain);
    const handoff = writeMod.buildHandoff(plain);
    expect(handoff["uncommittedFiles"]).toBeNull();
  });

  it("accepts a precomputed toplevel for a worktree subdirectory: worktree is exactly that toplevel, and branch still reflects cwd", () => {
    const mainRepo = mkdtempSync(join(tmpdir(), "compact-handoff-build-main-"));
    dirs.push(mainRepo);
    git(mainRepo, "init", "-b", "main");
    git(mainRepo, "commit", "--allow-empty", "-m", "init");
    const wtParent = mkdtempSync(join(tmpdir(), "compact-handoff-build-wt-"));
    dirs.push(wtParent);
    const worktreeDir = join(wtParent, "wt");
    git(mainRepo, "worktree", "add", "-b", "feature/build", worktreeDir);
    // A subdirectory, not the worktree root itself -- proves the precomputed
    // toplevel is used as-is rather than re-derived from this deeper `cwd`.
    const sub = join(worktreeDir, "sub");
    mkdirSync(sub, { recursive: true });

    const handoff = writeMod.buildHandoff(sub, worktreeDir);
    expect(handoff["worktree"]).toBe(worktreeDir);
    expect(handoff["branch"]).toBe("feature/build");
  });

  it("resolves the toplevel itself when no second argument is given (default behaviour unchanged)", () => {
    const repo = mkdtempSync(join(tmpdir(), "compact-handoff-build-default-"));
    dirs.push(repo);
    git(repo, "init", "-b", "main");
    git(repo, "commit", "--allow-empty", "-m", "init");

    const handoff = writeMod.buildHandoff(repo);
    expect(handoff["worktree"]).toBe(repo);
    expect(handoff["branch"]).toBe("main");
  });

  it("reflects a bogus precomputed toplevel verbatim in worktree, proving it is not re-resolved from cwd", () => {
    const repo = mkdtempSync(join(tmpdir(), "compact-handoff-build-bogus-"));
    dirs.push(repo);
    git(repo, "init", "-b", "main");
    git(repo, "commit", "--allow-empty", "-m", "init");

    const handoff = writeMod.buildHandoff(
      repo,
      "/definitely/not/a/real/toplevel",
    );
    expect(handoff["worktree"]).toBe("/definitely/not/a/real/toplevel");
    // Only `worktree` is threaded through verbatim -- `branch` still comes
    // from the real `cwd` (the actual repo), not from the bogus toplevel.
    expect(handoff["branch"]).toBe("main");
  });
});

describe("findScratchJournals", () => {
  it("finds journal-shaped .md files under tmp/, case-insensitively, sorted", () => {
    const repo = mkdtempSync(join(tmpdir(), "compact-handoff-journals-"));
    try {
      mkdirSync(join(repo, "tmp"), { recursive: true });
      writeFileSync(join(repo, "tmp", "journal-foo.md"), "x");
      writeFileSync(join(repo, "tmp", "JOURNAL-bar.md"), "x");
      writeFileSync(join(repo, "tmp", "notes.md"), "x"); // must not match
      writeFileSync(join(repo, "tmp", "journal-baz.txt"), "x"); // wrong ext

      expect(writeMod.findScratchJournals(repo)).toEqual([
        "tmp/JOURNAL-bar.md",
        "tmp/journal-foo.md",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns an empty array when tmp/ does not exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "compact-handoff-notmp-"));
    try {
      expect(writeMod.findScratchJournals(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");

  it("is false for a capturedAt within the last 24h", () => {
    expect(
      reinjectMod.isStale(
        { capturedAt: new Date(now - 60_000).toISOString() },
        now,
      ),
    ).toBe(false);
  });

  it("is true for a capturedAt more than 24h old", () => {
    expect(
      reinjectMod.isStale(
        { capturedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
        now,
      ),
    ).toBe(true);
  });

  it("is false when capturedAt is missing", () => {
    expect(reinjectMod.isStale({}, now)).toBe(false);
  });

  it("is false when capturedAt does not parse to a valid date", () => {
    expect(reinjectMod.isStale({ capturedAt: "not-a-date" }, now)).toBe(false);
  });

  it("is false when capturedAt is not a string", () => {
    expect(reinjectMod.isStale({ capturedAt: now }, now)).toBe(false);
  });
});

describe("formatHandoff", () => {
  it("includes the branch and worktree", () => {
    const text = reinjectMod.formatHandoff({
      branch: "feature/x",
      worktree: "/repo",
    });
    expect(text).toContain("feature/x");
    expect(text).toContain("/repo");
  });

  it("summarizes uncommitted files beyond 10 with a '+N more' suffix", () => {
    const files = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
    const text = reinjectMod.formatHandoff({ uncommittedFiles: files });
    expect(text).toContain("+2 more");
  });

  it("lists scratch journals when present", () => {
    const text = reinjectMod.formatHandoff({
      journals: ["tmp/journal-a.md"],
    });
    expect(text).toContain("tmp/journal-a.md");
  });

  it("flags a handoff more than 24h old as stale", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    const text = reinjectMod.formatHandoff(
      { capturedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
      now,
    );
    expect(text).toMatch(/stale/i);
  });

  it("does not flag a fresh handoff as stale", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    const text = reinjectMod.formatHandoff(
      { capturedAt: new Date(now - 60_000).toISOString() },
      now,
    );
    expect(text).not.toMatch(/stale/i);
  });

  it("flags git-status-unavailable when uncommittedFiles is null", () => {
    const text = reinjectMod.formatHandoff({ uncommittedFiles: null });
    expect(text).toContain("git status unavailable");
  });

  it("does not flag git-status-unavailable when uncommittedFiles is an empty array", () => {
    const text = reinjectMod.formatHandoff({ uncommittedFiles: [] });
    expect(text).not.toContain("git status unavailable");
  });

  it("does not flag git-status-unavailable when uncommittedFiles is absent", () => {
    const text = reinjectMod.formatHandoff({});
    expect(text).not.toContain("git status unavailable");
  });
});

describe("shouldReinject", () => {
  const cases: Array<[unknown, boolean]> = [
    [{ source: "compact" }, true],
    [{ source: "resume" }, true],
    [{ source: "startup" }, true],
    [{ source: "clear" }, false],
    [{}, false],
    [null, false],
    ["not-an-object", false],
    [42, false],
  ];

  it.each(cases)("input %o -> %s", (input, expected) => {
    expect(reinjectMod.shouldReinject(input)).toBe(expected);
  });
});

describe("findHandoffPath", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "compact-handoff-find-"));
    dirs.push(dir);
    mkdirSync(join(dir, "tmp"), { recursive: true });
    return dir;
  }

  it("returns the session's own file when it exists, for the 'compact' source", () => {
    const root = makeRoot();
    const own = join(root, "tmp", "compact-handoff-sess-a.json");
    writeFileSync(own, "{}");
    expect(reinjectMod.findHandoffPath(root, "sess-a", "compact")).toBe(own);
  });

  it("returns the session's own file when it exists, for the 'startup' source", () => {
    const root = makeRoot();
    const own = join(root, "tmp", "compact-handoff-sess-a.json");
    writeFileSync(own, "{}");
    expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(own);
  });

  it("never falls back to another session's file when source is 'compact'", () => {
    const root = makeRoot();
    writeFileSync(join(root, "tmp", "compact-handoff-sess-b.json"), "{}");
    expect(reinjectMod.findHandoffPath(root, "sess-a", "compact")).toBeNull();
  });

  it.each(["startup", "resume"] as const)(
    "picks the newest-by-mtime other-session file for '%s' (orphan recovery)",
    (source) => {
      const root = makeRoot();
      const older = join(root, "tmp", "compact-handoff-sess-old.json");
      const newer = join(root, "tmp", "compact-handoff-sess-new.json");
      writeFileSync(older, "{}");
      writeFileSync(newer, "{}");
      // Both mtimes must sit inside the [10min, 24h] orphan-recovery
      // eligibility window (see the "orphan-recovery age window" describe
      // below) -- a "just created" mtime would otherwise fall inside the
      // 10-minute grace period and get excluded rather than picked.
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
      const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
      utimesSync(older, past, past);
      utimesSync(newer, recent, recent);

      expect(reinjectMod.findHandoffPath(root, "sess-a", source)).toBe(newer);
    },
  );

  it("treats the legacy unkeyed file as eligible for 'startup' orphan recovery", () => {
    const root = makeRoot();
    const legacy = join(root, "tmp", "compact-handoff.json");
    writeFileSync(legacy, "{}");
    // Same eligibility-window reasoning as above.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(legacy, oneHourAgo, oneHourAgo);
    expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(legacy);
  });

  it("returns null when tmp/ does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "compact-handoff-notmp-"));
    dirs.push(root);
    expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBeNull();
  });

  it("returns null when tmp/ exists but has no qualifying file", () => {
    const root = makeRoot();
    expect(reinjectMod.findHandoffPath(root, "sess-a", "compact")).toBeNull();
  });

  it("returns the session's own file regardless of its age -- fresher than the grace period", () => {
    const root = makeRoot();
    const own = join(root, "tmp", "compact-handoff-sess-a.json");
    writeFileSync(own, "{}");
    const secondsAgo = new Date(Date.now() - 5_000);
    utimesSync(own, secondsAgo, secondsAgo);
    expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(own);
  });

  it("returns the session's own file regardless of its age -- older than the 24h stale threshold", () => {
    const root = makeRoot();
    const own = join(root, "tmp", "compact-handoff-sess-a.json");
    writeFileSync(own, "{}");
    const daysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(own, daysAgo, daysAgo);
    expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(own);
  });

  describe("corrupt-candidate pruning", () => {
    it("skips a newest orphan whose content is not parseable JSON, deletes it, and returns the next-newest valid orphan", () => {
      const root = makeRoot();
      const corruptNewest = join(root, "tmp", "compact-handoff-sess-bad.json");
      const validOlder = join(root, "tmp", "compact-handoff-sess-good.json");
      writeFileSync(corruptNewest, "{not json");
      writeFileSync(validOlder, "{}");
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(corruptNewest, thirtyMinAgo, thirtyMinAgo);
      utimesSync(validOlder, twoHoursAgo, twoHoursAgo);

      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        validOlder,
      );
      expect(existsSync(corruptNewest)).toBe(false);
    });

    it("skips a newest orphan that is an empty file, deletes it, and returns the next-newest valid orphan", () => {
      const root = makeRoot();
      const emptyNewest = join(root, "tmp", "compact-handoff-sess-empty.json");
      const validOlder = join(root, "tmp", "compact-handoff-sess-good2.json");
      writeFileSync(emptyNewest, "");
      writeFileSync(validOlder, "{}");
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(emptyNewest, thirtyMinAgo, thirtyMinAgo);
      utimesSync(validOlder, twoHoursAgo, twoHoursAgo);

      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        validOlder,
      );
      expect(existsSync(emptyNewest)).toBe(false);
    });

    it("deletes an unparseable own-session file and returns null for 'compact' (no orphan fallback)", () => {
      const root = makeRoot();
      const own = join(root, "tmp", "compact-handoff-sess-a.json");
      writeFileSync(own, "{not json");
      expect(reinjectMod.findHandoffPath(root, "sess-a", "compact")).toBeNull();
      expect(existsSync(own)).toBe(false);
    });

    it("deletes an unparseable own-session file and falls through to a valid orphan for 'startup'", () => {
      const root = makeRoot();
      const own = join(root, "tmp", "compact-handoff-sess-a.json");
      writeFileSync(own, "{not json");
      const orphan = join(root, "tmp", "compact-handoff-sess-b.json");
      writeFileSync(orphan, "{}");
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(orphan, oneHourAgo, oneHourAgo);

      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        orphan,
      );
      expect(existsSync(own)).toBe(false);
    });
  });

  describe("per-entry tolerance for a vanished/dangling candidate", () => {
    it("still returns a valid orphan when the newest matching entry is a dangling symlink (points at a missing target)", () => {
      const root = makeRoot();
      const validOlder = join(root, "tmp", "compact-handoff-sess-good3.json");
      writeFileSync(validOlder, "{}");
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(validOlder, oneHourAgo, oneHourAgo);

      const danglingLink = join(root, "tmp", "compact-handoff-sess-x.json");
      symlinkSync(join(root, "tmp", "does-not-exist.json"), danglingLink);

      expect(() =>
        reinjectMod.findHandoffPath(root, "sess-a", "startup"),
      ).not.toThrow();
      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        validOlder,
      );
    });

    it("does not abort the whole scan when a corrupt file AND a dangling symlink both sit ahead of the valid orphan", () => {
      const root = makeRoot();
      const corruptNewest = join(root, "tmp", "compact-handoff-sess-bad2.json");
      writeFileSync(corruptNewest, "{not json");
      const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(corruptNewest, twentyMinAgo, twentyMinAgo);

      const danglingLink = join(root, "tmp", "compact-handoff-sess-y.json");
      symlinkSync(join(root, "tmp", "also-missing.json"), danglingLink);

      const validOldest = join(root, "tmp", "compact-handoff-sess-good4.json");
      writeFileSync(validOldest, "{}");
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(validOldest, threeHoursAgo, threeHoursAgo);

      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        validOldest,
      );
    });
  });

  describe("orphan-recovery age window", () => {
    it("exports the orphan-recovery age-window constants", () => {
      expect(reinjectMod.ORPHAN_MIN_AGE_MS).toBe(10 * 60 * 1000);
      expect(reinjectMod.STALE_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
    });

    it("does not take a 1-minute-old other-session file on startup while a 1-hour-old one is eligible", () => {
      const root = makeRoot();
      const tooRecent = join(root, "tmp", "compact-handoff-sess-recent.json");
      const eligible = join(root, "tmp", "compact-handoff-sess-eligible.json");
      writeFileSync(tooRecent, "{}");
      writeFileSync(eligible, "{}");
      const oneMinuteAgo = new Date(Date.now() - 60_000);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(tooRecent, oneMinuteAgo, oneMinuteAgo);
      utimesSync(eligible, oneHourAgo, oneHourAgo);

      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        eligible,
      );
      // Merely too recent -- not stale, so not pruned.
      expect(existsSync(tooRecent)).toBe(true);
    });

    it("ignores and deletes an other-session file older than 24h (stale), preferring a younger-but-still-eligible one", () => {
      const root = makeRoot();
      const stale = join(root, "tmp", "compact-handoff-sess-stale.json");
      const eligible = join(root, "tmp", "compact-handoff-sess-eligible2.json");
      writeFileSync(stale, "{}");
      writeFileSync(eligible, "{}");
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(stale, twoDaysAgo, twoDaysAgo);
      utimesSync(eligible, twoHoursAgo, twoHoursAgo);

      expect(reinjectMod.findHandoffPath(root, "sess-a", "startup")).toBe(
        eligible,
      );
      expect(existsSync(stale)).toBe(false);
    });
  });
});

describe("reinject-compact-handoff.mjs entry point", () => {
  it("unlinks only the session's own handoff file it read, leaving another session's file untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "compact-handoff-entry-"));
    try {
      mkdirSync(join(root, "tmp"), { recursive: true });
      const ownPath = join(root, "tmp", "compact-handoff-sess-a.json");
      const otherPath = join(root, "tmp", "compact-handoff-sess-b.json");
      writeFileSync(
        ownPath,
        JSON.stringify({
          branch: "own-branch",
          worktree: root,
          sessionId: "sess-a",
        }),
      );
      writeFileSync(
        otherPath,
        JSON.stringify({
          branch: "other-branch",
          worktree: root,
          sessionId: "sess-b",
        }),
      );

      const result = spawnSync(
        "node",
        [join(scratch, ".claude", "hooks", "reinject-compact-handoff.mjs")],
        {
          input: JSON.stringify({
            source: "startup",
            session_id: "sess-a",
            cwd: root,
          }),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).not.toBe("");
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(output.hookSpecificOutput.additionalContext).toContain(
        "own-branch",
      );

      expect(existsSync(ownPath)).toBe(false);
      expect(existsSync(otherPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
