#!/usr/bin/env node
/**
 * PostToolUse verify (Write|Edit): fast in-loop feedback on TypeScript edits.
 *
 * Lefthook + CI already gate at commit/push time, but that feedback arrives
 * late. After an edit to a `.ts`/`.mts`/`.cts` file under `src/` or `tests/`
 * (at the project root, or nested under any `packages/<pkg>/`), this runs
 * checks scoped to the owning package so the signal is immediate without
 * paying the whole-project cost:
 *
 *   1. prettier --write   (auto-format the edited file)
 *   2. eslint              (lint the edited file; flat config from repo root)
 *   3. package typecheck   (`pnpm -C <pkg> typecheck`)
 *   4. vitest related      (only the tests that import the edited file)
 *   5. eslint tests/       (only when a src/ file is edited -- catches stale
 *                           eslint-disable directives that went unused after
 *                           the implementation landed; skipped silently if
 *                           tests/ doesn't exist)
 *
 * eslint runs in-loop (not just at the hub's `pnpm lint` gate) so eslint-only
 * failures surface here, not a round later.
 *
 * On any failure it exits 2 with a concise stderr summary, which Claude Code
 * surfaces back to the model as advisory feedback. The edit has already been
 * applied -- this is a nudge, not a hard gate.
 *
 * Worktree correctness: `CLAUDE_PROJECT_DIR` is pinned to the session's
 * ORIGINAL project root and stays there even after the session moves into a
 * worktree with `EnterWorktree` (see code.claude.com/docs/en/worktrees,
 * "Hook paths don't follow the worktree"). Resolving every path against it
 * would run every check below against the wrong tree -- or, worse, silently
 * skip the file, since a worktree lives at `<projectDir>/.claude/worktrees/
 * <name>/` and a projectDir-relative path into it starts with `.claude/`.
 * Instead this hook asks git which working tree actually contains the
 * edited file (`resolveVerifyRoot`, the same "resolve from the file, not the
 * session" approach `guard-branch-isolation.mjs` already uses for the same
 * reason) and scopes every step to that root.
 */
import process from "node:process";
import path, { dirname, resolve } from "node:path";
import fs, { existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  isProtectedPath,
} from "../../bin/lib/protected-paths.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Returns a git runner that executes every command with `git -C dir` --
 * same pattern as `guard-branch-isolation.mjs`'s `defaultGitFor`, kept as
 * its own copy here rather than a shared import: each hook stays a single
 * independent file, which keeps this project's hook count easy to reason
 * about against CLAUDE.md's hook budget.
 *
 * @param {string} dir Absolute directory path.
 * @returns {(args: string[]) => string}
 */
export function defaultGitFor(dir) {
  return function git(args) {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        // Don't let git's own stderr leak to this process's stderr (it
        // would otherwise print its "not a git repository" line even for
        // the ordinary, silent case below) -- captured and inspected
        // instead. `LC_ALL`/`LANGUAGE` pin git's message to English so the
        // pattern match below doesn't depend on the caller's locale.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
      }).trim();
    } catch (cause) {
      // "Not a git repository (or any of the parent directories)" is the
      // expected, silent case (any directory outside version control) --
      // everything else (git missing, EACCES, a `dubious ownership`
      // refusal, a corrupt worktree pointer, which prints a DIFFERENT "not
      // a git repository: <path>" form with no "(or any ...)" suffix) is a
      // real problem whose only symptom would otherwise be a confusing
      // silent fall-back to CLAUDE_PROJECT_DIR, so it gets one stderr line
      // instead. The pattern is deliberately narrow: matching bare "not a
      // git repository" would also swallow the corrupt-pointer case, which
      // is exactly the case this hint exists to surface.
      const message = String(cause?.stderr || cause?.message || "").trim();
      if (!/not a git repository \(or any /i.test(message)) {
        process.stderr.write(
          `post-edit-verify: git lookup failed in \`${dir}\` (${message.split("\n")[0]}); ` +
            "falling back to CLAUDE_PROJECT_DIR.\n",
        );
      }
      return "";
    }
  };
}

/**
 * Resolves the git working-tree root that actually contains `absFile` --
 * the worktree root when the file lives inside a linked worktree, the main
 * checkout root otherwise -- falling back to `fallback` when `absFile` is
 * outside any git repository (or git isn't available).
 *
 * Walks up to the nearest EXISTING ancestor of `absFile` before shelling
 * out, the same way `guard-branch-isolation.mjs` does: a Write creating a
 * brand-new nested directory means `git -C <that dir>` would otherwise fail
 * outright ("cannot change to ... No such file or directory").
 *
 * @param {string} absFile Absolute path to the edited file.
 * @param {string} fallback Used when no git root can be resolved.
 * @param {(dir: string) => (args: string[]) => string} [gitFactory]
 * @returns {string}
 */
export function resolveVerifyRoot(
  absFile,
  fallback,
  gitFactory = defaultGitFor,
) {
  let probeDir = dirname(resolve(absFile));
  while (!existsSync(probeDir)) {
    const parent = dirname(probeDir);
    if (parent === probeDir) break; // filesystem root; give up climbing
    probeDir = parent;
  }
  const git = gitFactory(probeDir);
  const root = git(["rev-parse", "--show-toplevel"]);
  return root === "" ? fallback : root;
}

// Kept as a duplicated, self-contained block rather than a shared helper --
// see the comment on `defaultGitFor` above. `import.meta.url` is
// symlink-resolved by Node's ESM loader but `process.argv[1]` is not, so
// comparing them directly would be false under a symlinked invocation path,
// and this guard exists precisely so the pure helpers above stay importable
// (for testing) without the script's side-effecting body running too.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

  // A relative file_path is resolved against the hook's `cwd` input field
  // when present -- unlike CLAUDE_PROJECT_DIR, `cwd` follows the session
  // into a worktree (see the worktree-correctness note above) -- falling
  // back to projectDir otherwise.
  const baseDir =
    typeof input.cwd === "string" && input.cwd.length > 0
      ? input.cwd
      : projectDir;
  // Canonicalized (case-correct, symlinks resolved) so it's in the SAME form
  // `resolveVerifyRoot` returns (`git rev-parse --show-toplevel` already
  // resolves symlinks) -- comparing an un-resolved `abs` against a resolved
  // `root` would make `path.relative` produce a bogus `../..` on any
  // symlinked project path (macOS's `/tmp` -> `/private/tmp`, `/var` ->
  // `/private/var`, a symlinked home directory), which is exactly the
  // silent-skip failure mode this file exists to close.
  const abs = canonicalize(
    path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath),
  );

  const root = resolveVerifyRoot(abs, canonicalize(projectDir));
  const rel = path.relative(root, abs).split(path.sep).join("/");

  // Only TypeScript sources; never generated declarations.
  if (!/\.(ts|mts|cts)$/.test(rel) || /\.d\.ts$/.test(rel)) process.exit(0);
  if (
    rel.startsWith("..") ||
    rel.includes("node_modules/") ||
    /(^|\/)dist\//.test(rel)
  ) {
    process.exit(0);
  }

  if (!isProtectedPath(rel)) process.exit(0);

  // Walk up to the nearest package.json = the owning package root (the
  // worktree/project root itself in a flat single-package layout). Bounded
  // by `root`, not `projectDir` -- if this project is itself checked out
  // inside a larger git repository, `root` (the git toplevel) can sit ABOVE
  // the actual package; walking up from the edited file finds the real
  // owning package first regardless.
  function findPackageDir(startDir) {
    let dir = startDir;
    while (dir.startsWith(root)) {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }

  const pkgDir = findPackageDir(path.dirname(abs));
  if (pkgDir === undefined) process.exit(0);

  // A worktree (or nested checkout) with no dependencies installed yet would
  // fail every step below for a reason that has nothing to do with the edit.
  // Checked against `pkgDir`, not `root`: those differ whenever this project
  // is a subdirectory of a larger repo, and `root`'s own node_modules (if it
  // even has one) says nothing about whether THIS package can resolve its
  // tools. Exits 2 (not 0) so this reaches the model the same way a real
  // failure does -- "install dependencies" is actionable feedback, and a
  // silent exit 0 here would just be a quieter version of the bug this file
  // exists to fix.
  if (!fs.existsSync(path.join(pkgDir, "node_modules"))) {
    process.stderr.write(
      `post-edit-verify: no node_modules under \`${pkgDir}\` -- run ` +
        "`pnpm install` there before this edit can be verified.\n",
    );
    process.exit(2);
  }

  let toolMissing = false;

  function run(cmd, args) {
    const res = spawnSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      // `spawnSync`'s default 1 MiB `maxBuffer` can be exceeded by a real
      // failure's own output (a large `tsc -b --force` or `eslint tests/`
      // error list) -- raised well above what any of this hook's steps
      // realistically emit so a genuine failure's output is never itself
      // the reason it gets treated as unreportable.
      maxBuffer: 16 * 1024 * 1024,
    });
    // Only a missing binary (e.g. pnpm itself absent) skips silently -- any
    // other `res.error` (a killed process, `maxBuffer` exceeded, ...) is a
    // real failure and must be reported, not swallowed as if the step never
    // ran.
    if (res.error?.code === "ENOENT") {
      toolMissing = true;
      return undefined;
    }
    if (res.error) {
      const why = `${cmd} ${args.join(" ")} failed: ${res.error.message}\n`;
      // Prepended to BOTH streams, not just stderr: every failure below is
      // reported via `(x.stdout || x.stderr)`, so a step whose partial
      // stdout is non-empty would otherwise hide this cause behind it.
      return {
        status: 1,
        stdout: why + (res.stdout ?? ""),
        stderr: why + (res.stderr ?? ""),
      };
    }
    return res;
  }

  const failures = [];

  // 1. Format the edited file (best-effort; a parse error is itself signal).
  const fmt = run("pnpm", ["exec", "prettier", "--write", abs]);
  if (fmt && fmt.status !== 0) {
    failures.push(`prettier:\n${(fmt.stderr || fmt.stdout || "").trim()}`);
  }

  // 2. Lint the edited file (single file; flat config resolves from repo root
  //    and honours its own `ignores`, so no per-package wrapper is needed).
  //    Report-only (no --fix) so the root cause is addressed, not masked.
  const lint = run("pnpm", ["exec", "eslint", abs]);
  if (lint && lint.status !== 0) {
    failures.push(`eslint:\n${(lint.stdout || lint.stderr || "").trim()}`);
  }

  // 3. Type-check the owning package.
  const tc = run("pnpm", ["-C", pkgDir, "typecheck"]);
  if (tc && tc.status !== 0) {
    failures.push(`typecheck:\n${(tc.stdout || tc.stderr || "").trim()}`);
  }

  // 4. Run only the tests related to the edited file.
  const vt = run("pnpm", ["exec", "vitest", "related", abs, "--run"]);
  if (vt && vt.status !== 0) {
    failures.push(`vitest related:\n${(vt.stdout || vt.stderr || "").trim()}`);
  }

  // 5. When a src/ file is implemented/updated, also lint the package's tests/
  //    directory to surface stale eslint-disable directives that became unused
  //    once the implementation landed.
  if (/(^|\/)src\//.test(rel)) {
    const testsDir = path.join(pkgDir, "tests");
    if (fs.existsSync(testsDir)) {
      const testLint = run("pnpm", ["exec", "eslint", testsDir]);
      if (testLint && testLint.status !== 0) {
        failures.push(
          `eslint (tests/ -- scanned because a src/ file was edited; fix the file(s) listed below):\n${(testLint.stdout || testLint.stderr || "").trim()}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `post-edit-verify found issues in \`${rel}\` (package: ` +
        `${path.relative(root, pkgDir) || "."}). Address these before ` +
        `moving on:\n\n${failures.join("\n\n")}\n`,
    );
    process.exit(2);
  }

  if (toolMissing) {
    process.stderr.write(
      "post-edit-verify: `pnpm` was not found on PATH -- checks skipped.\n",
    );
    process.exit(2);
  }

  process.exit(0);
}
