#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * PostToolUse verify (Write|Edit): fast in-loop feedback on TypeScript and
 * plain-JS edits.
 *
 * Lefthook + CI already gate at commit/push time, but that feedback arrives
 * late. Two edited-file shapes get in-loop feedback here:
 *
 *   - A `.ts`/`.mts`/`.cts` file under `src/` or `tests/` (at the project
 *     root, or nested under any `packages/<pkg>/`) gets the full battery,
 *     scoped to the owning package so the signal is immediate without
 *     paying the whole-project cost:
 *       1. prettier --write   (auto-format the edited file)
 *       2. eslint              (lint the edited file; flat config from repo root)
 *       3. package typecheck   (`tsc -b` against the owning package's tsconfig)
 *       4. vitest related      (only the tests that import the edited file)
 *       5. eslint tests/       (only when a src/ file is edited -- catches stale
 *                               eslint-disable directives that went unused after
 *                               the implementation landed; skipped silently if
 *                               tests/ doesn't exist)
 *   - Any other `.mjs`/`.js` file (`bin/**`, `.claude/hooks/**`,
 *     `templates/core/bin/**`, ...) gets only steps 1-2: these live outside
 *     any `packages/<pkg>` tsconfig project and outside vitest's test glob,
 *     so typecheck/vitest have nothing to scope to. `templates/**` is
 *     formatted (Prettier covers it, same as the root `pnpm format` script)
 *     but not linted here -- the root `eslint.config.js` excludes
 *     `templates/**` entirely, since it ships its own toolchain into every
 *     bootstrapped project.
 *
 * eslint runs in-loop (not just at the hub's `pnpm lint` gate) so eslint-only
 * failures surface here, not a round later.
 *
 * On any failure it exits 2 with a concise stderr summary, which Claude Code
 * surfaces back to the model as advisory feedback. The edit has already been
 * applied -- this is a nudge, not a hard gate.
 */
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { isProtectedPath } from "../../bin/lib/protected-paths.mjs";
import {
  readHookInput,
  isExcludedHookPath,
} from "../../bin/lib/hook-input.mjs";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const input = await readHookInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

const abs = path.isAbsolute(filePath)
  ? filePath
  : path.resolve(projectDir, filePath);
const rel = path.relative(projectDir, abs).split(path.sep).join("/");

// TypeScript sources (never generated declarations) or plain ESM JS.
const isTsFamily = /\.(ts|mts|cts)$/.test(rel) && !/\.d\.ts$/.test(rel);
const isJsFamily = /\.(mjs|js)$/.test(rel);
if (!isTsFamily && !isJsFamily) process.exit(0);
if (isExcludedHookPath(rel)) process.exit(0);

const underTemplates = rel.startsWith("templates/");
// The full battery (typecheck + vitest + tests/ eslint) only makes sense for
// a TypeScript source/test file that lives inside a package's tsconfig
// project -- a plain .mjs/.js file (bin/**, .claude/hooks/**,
// templates/core/bin/**, ...) has no tsconfig project or vitest glob to
// scope those steps to.
const runsFullBattery = isTsFamily && isProtectedPath(rel);

// Walk up to the nearest package.json = the owning package root (the
// project root itself in a flat single-package layout). Only needed for the
// full battery's `pnpm -C <pkg>` steps.
function findPackageDir(startDir) {
  let dir = startDir;
  while (dir.startsWith(projectDir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const pkgDir = runsFullBattery ? findPackageDir(path.dirname(abs)) : undefined;
if (runsFullBattery && pkgDir === undefined) process.exit(0);

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: projectDir,
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
  if (res.error?.code === "ENOENT") return undefined;
  if (res.error) {
    return {
      status: 1,
      stdout: res.stdout ?? "",
      stderr: `${cmd} ${args.join(" ")} failed: ${res.error.message}\n${res.stderr ?? ""}`,
    };
  }
  return res;
}

const failures = [];

// 1. Format the edited file (best-effort; a parse error is itself signal).
// Runs for every matched file, `templates/**` included -- Prettier covers
// it the same way the root `pnpm format` script does.
const fmt = run("pnpm", ["exec", "prettier", "--write", abs]);
if (fmt && fmt.status !== 0) {
  failures.push(`prettier:\n${(fmt.stderr || fmt.stdout || "").trim()}`);
}

// 2. Lint the edited file (single file; flat config resolves from repo root
//    and honours its own `ignores`, so no per-package wrapper is needed).
//    Report-only (no --fix) so the root cause is addressed, not masked.
//    Skipped under `templates/**`: the root `eslint.config.js` excludes it
//    entirely (it ships its own toolchain into every bootstrapped project),
//    so running eslint against it here would only report "file ignored".
if (!underTemplates) {
  const lint = run("pnpm", ["exec", "eslint", abs]);
  if (lint && lint.status !== 0) {
    failures.push(`eslint:\n${(lint.stdout || lint.stderr || "").trim()}`);
  }
}

if (runsFullBattery && pkgDir !== undefined) {
  // 3. Type-check the owning package. Neither package.json defines its own
  //    `typecheck` script (only the root does, `tsc -b --force` over both
  //    projects at once) -- invoke `tsc -b` directly against the owning
  //    package's tooling tsconfig instead, so this step actually scopes to
  //    the edited package rather than failing with "Command not found".
  const tc = run("pnpm", [
    "exec",
    "tsc",
    "-b",
    "--force",
    path.join(pkgDir, "tsconfig.json"),
  ]);
  if (tc && tc.status !== 0) {
    failures.push(`typecheck:\n${(tc.stdout || tc.stderr || "").trim()}`);
  }

  // 4. Run only the tests related to the edited file.
  const vt = run("pnpm", ["exec", "vitest", "related", abs, "--run"]);
  if (vt && vt.status !== 0) {
    failures.push(`vitest related:\n${(vt.stdout || vt.stderr || "").trim()}`);
  }

  // 5. When a src/ file is implemented/updated, also lint the package's
  //    tests/ directory to surface stale eslint-disable directives that
  //    became unused once the implementation landed. Skipped under
  //    `templates/**` for the same reason step 2 is: the root
  //    `eslint.config.js` excludes it entirely, so this would only ever
  //    report a no-op against an ignored path.
  if (!underTemplates && /(^|\/)src\//.test(rel)) {
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
}

if (failures.length > 0) {
  const scope =
    pkgDir === undefined ? "." : path.relative(projectDir, pkgDir) || ".";
  process.stderr.write(
    `post-edit-verify found issues in \`${rel}\` (package: ${scope}). ` +
      `Address these before moving on:\n\n${failures.join("\n\n")}\n`,
  );
  process.exit(2);
}

process.exit(0);
