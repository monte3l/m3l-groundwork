/**
 * Regression test for the baseline's PreToolUse guards under a symlinked path.
 * `import.meta.url` is symlink-resolved by Node's ESM loader but
 * `process.argv[1]` is not, so a guard that gates its body on comparing the two
 * never runs when the project sits under a symlinked directory (a symlinked
 * home or workspace on Linux, `/tmp` and `/var` on macOS) -- it exits 0, and
 * for a blocking hook exit 0 means "allow". Each case below runs a guard
 * through such a path with a payload it must block, and fails against the old
 * check. `templates/**` is excluded from this repo's vitest discovery, so the
 * hooks are run by path rather than imported.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Flips the case of every letter -- guaranteed to differ from the input
 * (as long as it contains at least one letter) while still denoting the
 * SAME path on a case-insensitive-but-case-preserving filesystem. */
function invertCase(value: string): string {
  return value
    .split("")
    .map((ch) =>
      ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
    )
    .join("");
}

/** True when this filesystem resolves a wrongly-cased spelling of a real,
 * existing path to the same file (macOS APFS by default). */
function isFilesystemCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "core-hooks-case-probe-"));
  try {
    const wrong = invertCase(probe);
    return wrong !== probe && existsSync(wrong);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const caseInsensitiveFs = isFilesystemCaseInsensitive();

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "core",
  ".claude",
  "hooks",
);

/**
 * The parent environment minus the variables git itself calls
 * repository-local (`git rev-parse --local-env-vars`: `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...). A git hook, or a session in a linked
 * worktree, can export an absolute `GIT_DIR`; a child that inherited it would
 * ignore its own `cwd` and run `git init` / `git commit` against the
 * developer's real repository instead of the fixture.
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

function run(
  script: string,
  payload: unknown,
): { status: number | null; stderr: string } {
  const result = spawnSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: envWithoutRepoLocals(),
  });
  return { status: result.status, stderr: result.stderr };
}

describe("baseline guards run through a symlinked hooks directory", () => {
  let scratch: string;
  let linkedHooks: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "core-hooks-symlink-"));
    linkedHooks = join(scratch, "linked-hooks");
    symlinkSync(hooksDir, linkedHooks, "dir");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("guard-no-commonjs still blocks a require() call", () => {
    const { status, stderr } = run(join(linkedHooks, "guard-no-commonjs.mjs"), {
      tool_name: "Write",
      tool_input: {
        file_path: join(scratch, "x.js"),
        content: 'const fs = require("fs");',
      },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("CommonJS");
  });

  it("guard-secret-writes still blocks writing a dotenv file", () => {
    const { status } = run(join(linkedHooks, "guard-secret-writes.mjs"), {
      tool_name: "Write",
      tool_input: { file_path: join(scratch, ".env"), content: "FOO=bar" },
    });
    expect(status).toBe(2);
  });

  /** Builds a throwaway repo on `main` and asks the guard, through the symlink, to allow a `src/` write. */
  function srcWriteOnMain(repoName: string): {
    status: number | null;
    stderr: string;
  } {
    const repo = join(scratch, repoName);
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...args: string[]): void => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo, encoding: "utf8", env: envWithoutRepoLocals() },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "init");

    return run(join(linkedHooks, "guard-branch-isolation.mjs"), {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "a.ts"), content: "" },
    });
  }

  it("guard-branch-isolation (which shells out to git) still blocks a src write on main", () => {
    const { status, stderr } = srcWriteOnMain("repo");
    expect(status).toBe(2);
    expect(stderr).toContain("main");
  });

  it("guard-branch-isolation still blocks a src write on main when the target directory does not exist yet", () => {
    // Deliberately does NOT pre-create src/newdir -- unlike srcWriteOnMain
    // above, which does create `src/`. `defaultGitFor` binds its git runner
    // to `dirname(resolve(filePath))`; when that directory doesn't exist,
    // every `git -C <dir> ...` call fails and returns "" (defaultGitFor's
    // catch), so `isMainOrDetachedOnMain` can't tell it's on `main` at all
    // and the hook currently falls through to allow (status 0) instead of
    // blocking.
    const repo = join(scratch, "repo-newdir");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]): void => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo, encoding: "utf8", env: envWithoutRepoLocals() },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "init");

    const { status, stderr } = run(
      join(linkedHooks, "guard-branch-isolation.mjs"),
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(repo, "src", "newdir", "a.ts"),
          content: "",
        },
      },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("main");
  });

  it.skipIf(!caseInsensitiveFs)(
    "guard-branch-isolation still blocks a src write on main when file_path is spelled with different case than the real repo directory",
    () => {
      // Same repo-on-main fixture as srcWriteOnMain (src/ IS pre-created),
      // but the hook is invoked with a wrongly-cased spelling of the repo's
      // real, canonical-case directory. `git rev-parse --show-toplevel`
      // still resolves to the CORRECT canonical case, but the hook's own
      // re-check (`isProtectedPath(scopedPath, worktreeRoot)`) resolves
      // `fileDir` with plain `realpathSync` (which does not correct case on
      // a case-insensitive filesystem), so the literal string prefix
      // comparison against the correctly-cased `worktreeRoot` fails and the
      // hook currently falls through to allow (status 0) instead of
      // blocking.
      const repo = join(scratch, "repo-case-mismatch");
      mkdirSync(join(repo, "src"), { recursive: true });
      const canonicalRepo = realpathSync.native(repo);
      const wronglyCasedRepo = invertCase(canonicalRepo);

      const git = (...args: string[]): void => {
        const result = spawnSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: repo, encoding: "utf8", env: envWithoutRepoLocals() },
        );
        expect(result.status, result.stderr).toBe(0);
      };
      git("init", "-b", "main");
      git("commit", "--allow-empty", "-m", "init");

      const { status, stderr } = run(
        join(linkedHooks, "guard-branch-isolation.mjs"),
        {
          tool_name: "Write",
          tool_input: {
            file_path: join(wronglyCasedRepo, "src", "a.ts"),
            content: "",
          },
        },
      );
      expect(status).toBe(2);
      expect(stderr).toContain("main");
    },
  );

  it("is not fooled by an inherited GIT_DIR, and never touches the repository it points at", () => {
    // A decoy stands in for "the developer's real repo": if the fixture ever
    // ran git against the inherited GIT_DIR, the damage lands here, not there.
    const decoy = join(scratch, "decoy");
    mkdirSync(decoy);
    const init = spawnSync("git", ["init", "-b", "main"], {
      cwd: decoy,
      encoding: "utf8",
      env: envWithoutRepoLocals(),
    });
    expect(init.status, init.stderr).toBe(0);

    vi.stubEnv("GIT_DIR", join(decoy, ".git"));
    const { status, stderr } = srcWriteOnMain("repo-with-inherited-git-dir");
    expect(status).toBe(2);
    expect(stderr).toContain("main");

    const commits = spawnSync(
      "git",
      ["-C", decoy, "rev-list", "--all", "--count"],
      { encoding: "utf8", env: envWithoutRepoLocals() },
    );
    expect(commits.stdout.trim()).toBe("0");
  });
});

describe("no shipped script compares process.argv[1] to import.meta.url directly", () => {
  // The behavioural tests above cover a sample; this sweep is what stops the
  // next hook, gate or pack script from reintroducing the fail-open check.
  const templatesDir = join(here, "..", "..", "..", "templates");

  function scripts(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" ? [] : scripts(path);
      }
      return entry.name.endsWith(".mjs") ? [path] : [];
    });
  }

  const files = scripts(templatesDir).filter((path) =>
    readFileSync(path, "utf8").includes("process.argv[1]"),
  );

  it("finds the scripts it is meant to police", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((path) => [relative(templatesDir, path), path]))(
    "%s resolves argv[1] with realpathSync",
    (_name, path) => {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /process\.argv\[1\]\s*===\s*fileURLToPath\(import\.meta\.url\)/,
      );
      expect(source).toContain("realpathSync(process.argv[1])");
    },
  );
});
