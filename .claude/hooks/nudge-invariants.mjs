#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * PostToolUse advisory (Write|Edit): reminds about this repo's cross-file
 * invariants that a `pnpm verify` step or a parity test only catches one
 * round later, never in-loop:
 *
 *   - `packages/cli/src/harness/**` <-> `templates/core/bin/lib/{frontmatter,
 *     harness-rules}.mjs` must change together (CLAUDE.md's "two
 *     implementations that must not drift"; `harness-parity.test.ts`).
 *   - `packages/cli/src/toolchain/**` <-> `templates/core/bin/lib/
 *     toolchain-rules.mjs`, same shape (`toolchain-parity.test.ts`).
 *   - A newly created file under `templates/core/**` needs a glob in
 *     `packages/plugin/src/domain-map.ts` (`domain-map.test.ts`) and a
 *     re-check of the baseline's caps (`packages/cli/src/caps.ts`).
 *   - `design/source/**` changed -> regenerate `design/tokens.css`
 *     (`node bin/build-design-tokens.mjs`).
 *   - A newly created file whose extension matches `check-license-headers.mjs`'s
 *     own `HEADER_EXTENSIONS`, with no SPDX header yet -> `node
 *     bin/check-license-headers.mjs --fix`. This mirrors that script's
 *     extension set exactly (not `REUSE.toml`'s fuller glob list, which also
 *     covers non-extension dotfiles) -- the `license-headers` verify step
 *     remains the authoritative gate.
 *
 * Advisory only: this hook only runs PostToolUse, after the edit has already
 * been applied, so its exit-2 stderr is feedback for the next step, never a
 * block on this one. It only speaks up when a rule's path pattern actually
 * matches -- silent on every other edit, same contract as
 * `post-edit-verify.mjs`. A grader-twin rule also stays silent once the
 * *other* twin already shows as changed in `git status` -- once both sides
 * of a pair are being edited in the same working-tree session, repeating
 * "update the other twin too" on every further edit would be exactly the
 * cry-wolf noise `.claude/rules/agent-dispatch.md` warns against.
 *
 * `computeInvariantNotes` (and the git-status/SPDX helpers it calls) are
 * exported for unit testing, same convention as `guard-hub-src-writes.mjs`'s
 * `shouldBlockHubSrcWrite` -- the actual stdin-read-and-exit side effects
 * only run behind the `isEntryPoint()` guard below, so importing this module
 * for a test never reads stdin or calls `process.exit`.
 */
import process from "node:process";
import path from "node:path";
import fs, { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readHookInput,
  isExcludedHookPath,
} from "../../bin/lib/hook-input.mjs";

export { isExcludedHookPath };

/**
 * `git status --porcelain` for a single path, or `undefined` if git itself
 * couldn't be asked (not a repo, git missing, ...). A `git status` failure
 * silently disables every rule below that depends on it (new-file and
 * already-dirty detection) rather than reporting a false positive -- the
 * authoritative gates (`domain-map.test.ts`, the `license-headers` verify
 * step) still catch what this advisory nudge misses.
 *
 * @param {string} target Absolute or cwd-relative path to ask git about.
 * @param {string} cwd Directory to run `git status` from (the project root
 *   in production; a test's own temp git repo in a test).
 * @param {NodeJS.ProcessEnv} [env] Environment for the `git` child process --
 *   defaults to this process's own `process.env` in production. A test
 *   pointed at its own throwaway repo must override this to a repo-local-
 *   variable-free environment (`GIT_DIR`, `GIT_INDEX_FILE`, ...): those
 *   inherited from a git hook or a linked worktree would otherwise redirect
 *   this `git status` call at the REAL repository instead of the fixture,
 *   same hazard `packages/cli/tests/templates/core-hooks.test.ts`'s `envWithoutRepoLocals()` guards
 *   against for its own subprocess-under-test.
 */
export function statusLine(target, cwd, env = process.env) {
  const res = spawnSync("git", ["status", "--porcelain", "--", target], {
    cwd,
    encoding: "utf8",
    env,
  });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout.trim();
}

/** True when `target` has no committed history yet -- untracked or a staged add. */
export function isNewFile(target, cwd, env = process.env) {
  const line = statusLine(target, cwd, env);
  return line !== undefined && (line.startsWith("??") || line.startsWith("A"));
}

/** True when `target` already shows as changed (any status) in the working tree. */
export function isDirty(target, cwd, env = process.env) {
  const line = statusLine(target, cwd, env);
  return line !== undefined && line.length > 0;
}

/** True when any of `targets` (project-root-relative paths) already shows as changed. */
export function anyDirty(targets, projectDir, env = process.env) {
  return targets.some((target) =>
    isDirty(path.join(projectDir, target), projectDir, env),
  );
}

export function hasSpdxHeader(target) {
  try {
    const head = fs.readFileSync(target, "utf8").slice(0, 2000);
    return head.includes("SPDX-FileCopyrightText");
  } catch {
    return false;
  }
}

// Must match `bin/check-license-headers.mjs`'s own `HEADER_EXTENSIONS`
// exactly -- a broader set here would nudge `--fix` for an extension that
// script doesn't actually header, a false positive rather than an
// approximation.
export const HEADER_ELIGIBLE_EXT = /\.(ts|mjs|js|sh|yml|yaml)$/;

export const HARNESS_TS_GLOB = /^packages\/cli\/src\/harness\//;
// The full pairing per CLAUDE.md's "two implementations that must not
// drift": every file on one side must be checked, not one arbitrary
// representative -- otherwise editing the *actual* twin first (say
// `harness-rules.mjs`) while a different, unrelated file on the same side
// (say `frontmatter.mjs`) stays clean still nags on the next edit.
export const HARNESS_JS_TWINS = [
  "templates/core/bin/lib/frontmatter.mjs",
  "templates/core/bin/lib/harness-rules.mjs",
];
// Derived from `HARNESS_JS_TWINS` rather than spelled out separately -- two
// literal encodings of the same file set could drift if a third twin file
// is ever added and only one of them is updated.
export const HARNESS_TWIN_GLOB = new RegExp(
  `^(${HARNESS_JS_TWINS.map((twin) => twin.replace(/[.]/g, "\\$&")).join("|")})$`,
);
export const HARNESS_TS_TWINS = [
  "packages/cli/src/harness/frontmatter.ts",
  "packages/cli/src/harness/rules.ts",
  "packages/cli/src/harness/grade.ts",
];

export const TOOLCHAIN_TS_GLOB = /^packages\/cli\/src\/toolchain\//;
export const TOOLCHAIN_TWIN = "templates/core/bin/lib/toolchain-rules.mjs";
export const TOOLCHAIN_TS_TWINS = [
  "packages/cli/src/toolchain/rules.ts",
  "packages/cli/src/toolchain/grade.ts",
];

/**
 * Pure(ish) decision function -- exported for unit testing. Computes the
 * advisory notes for one edited file, given its project-relative path,
 * absolute path, and project root. Returns an empty array when no rule
 * matches; the caller decides what "no notes" means (production: exit 0).
 *
 * @param {string} rel Project-root-relative path, `/`-joined.
 * @param {string} abs Absolute path to the same file.
 * @param {string} projectDir Absolute project root (`git status` runs here).
 * @param {NodeJS.ProcessEnv} [env] Environment for every `git` child process
 *   this function spawns -- see `statusLine`'s own doc comment. Defaults to
 *   `process.env` for production; a test overrides this to isolate its
 *   throwaway fixture repo from the real one.
 */
export function computeInvariantNotes(rel, abs, projectDir, env = process.env) {
  const notes = [];

  // Harness grader twin. Silent once the *other* side already shows as
  // changed -- both halves being edited in the same session means the
  // pairing is already being honoured, not ignored.
  if (
    HARNESS_TS_GLOB.test(rel) &&
    !anyDirty(HARNESS_JS_TWINS, projectDir, env)
  ) {
    notes.push(
      "This is the TypeScript harness grader. If this rule changed, update its " +
        "emitted JS twin in the same commit: `templates/core/bin/lib/{frontmatter,harness-rules}.mjs` " +
        "(`tests/harness/harness-parity.test.ts` asserts both grade identically).",
    );
  }
  if (
    HARNESS_TWIN_GLOB.test(rel) &&
    !anyDirty(HARNESS_TS_TWINS, projectDir, env)
  ) {
    notes.push(
      "This is the emitted harness grader twin. If this rule changed, update its " +
        "TypeScript source in the same commit: `packages/cli/src/harness/{frontmatter,rules}.ts` " +
        "(`tests/harness/harness-parity.test.ts` asserts both grade identically).",
    );
  }

  // Toolchain grader twin, same shape.
  if (
    TOOLCHAIN_TS_GLOB.test(rel) &&
    !isDirty(path.join(projectDir, TOOLCHAIN_TWIN), projectDir, env)
  ) {
    notes.push(
      "This is the TypeScript toolchain grader. If this rule changed, update its " +
        "emitted JS twin in the same commit: `templates/core/bin/lib/toolchain-rules.mjs` " +
        "(`tests/toolchain/toolchain-parity.test.ts` asserts both grade identically).",
    );
  }
  if (
    rel === TOOLCHAIN_TWIN &&
    !anyDirty(TOOLCHAIN_TS_TWINS, projectDir, env)
  ) {
    notes.push(
      "This is the emitted toolchain grader twin. If this rule changed, update its " +
        "TypeScript source in the same commit: `packages/cli/src/toolchain/{rules,grade}.ts` " +
        "(`tests/toolchain/toolchain-parity.test.ts` asserts both grade identically).",
    );
  }

  // A new baseline file needs a domain-map glob and a caps re-check.
  if (/^templates\/core\//.test(rel) && isNewFile(abs, projectDir, env)) {
    notes.push(
      "New file under `templates/core/`: add a glob to `packages/plugin/src/domain-map.ts` " +
        "so `domain-map.test.ts` still claims it under exactly one guidance sweep, and re-check " +
        "the baseline's caps (`packages/cli/src/caps.ts`'s `CAP_LIMITS`) if this is a new " +
        "agent/skill/hook/workflow/script.",
    );
  }

  // Design tokens regen. The generator emits `design/tokens.css` and
  // `packages/cli/src/palette.ts` -- `term.ts` only *consumes* palette.ts
  // and is hand-written, so it is deliberately not named here.
  if (/^design\/source\//.test(rel)) {
    notes.push(
      "`design/source/**` changed: re-run `node bin/build-design-tokens.mjs` and commit the " +
        "regenerated `design/tokens.css` and `packages/cli/src/palette.ts` in the same change.",
    );
  }

  // SPDX header on a new file.
  if (
    !rel.startsWith("templates/") &&
    HEADER_ELIGIBLE_EXT.test(rel) &&
    isNewFile(abs, projectDir, env) &&
    !hasSpdxHeader(abs)
  ) {
    notes.push(
      "New file with no SPDX header detected: run `node bin/check-license-headers.mjs --fix`, " +
        "or add a glob to `REUSE.toml` if this file type is meant to be exempt.",
    );
  }

  return notes;
}

// Kept as a duplicated, self-contained block in every hook file rather than
// imported from a shared helper -- see `guard-hub-src-writes.mjs`'s own copy
// of this comment for why. `import.meta.url` is symlink-resolved but
// `process.argv[1]` is not, so comparing them directly would be false under
// a symlinked invocation path -- and the guard below would then never run,
// i.e. silently fail open (exit 0) instead of nudging.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked directly, not when imported for testing.
if (isEntryPoint()) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const input = await readHookInput();
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectDir, filePath);
  const rel = path.relative(projectDir, abs).split(path.sep).join("/");

  if (isExcludedHookPath(rel)) process.exit(0);

  const notes = computeInvariantNotes(rel, abs, projectDir);

  if (notes.length > 0) {
    process.stderr.write(
      `Invariant reminder for \`${rel}\`:\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`,
    );
    process.exit(2);
  }

  process.exit(0);
}
