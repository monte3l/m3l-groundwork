#!/usr/bin/env node
/**
 * Per-file size ratchet for `src/` and `tests/` — the file scope matches
 * `vitest.config.ts`'s `coverage.include` (`.ts` sources, excluding `index.ts`
 * barrels and `.d.ts` files), since the hazard this guards against is
 * specific to `perFile: true` v8 coverage: a large implementation file binds
 * to every test file that exercises it, and once both grow past a point,
 * retrofitting a split becomes structurally difficult to do in one PR.
 *
 * A flat ceiling is not viable once a project has real debt, so this is a
 * **ratchet**, not a cap: a committed baseline (`bin/file-budget-
 * baseline.json`) is the sparse "debt list" of files that already exceeded
 * their ceiling when this gate was adopted. A baselined file may shrink
 * freely but never **grow** past its recorded size; any file not in the
 * baseline must stay under the ceiling from the start. `--update`
 * regenerates the baseline from current sizes, dropping any entry that no
 * longer exceeds its ceiling and adding any newly-over-ceiling file — an
 * explicit, reviewed-diff social contract: a PR that baselines a new
 * oversized file is asking its reviewer to accept that debt, not silently
 * evading the gate.
 *
 * `ROOTS` defaults to this project's flat `src/`/`tests/` layout (not to be
 * confused with the "baseline" ratchet file above -- this is about where
 * your source lives, not about recorded debt). If `/customize` or a later
 * refactor moves to a `packages/*` monorepo shape, update `ROOTS` to list
 * each package's `src`/`tests` pair.
 *
 * Usage:
 *   node bin/check-file-budget.mjs            # verify (fails on growth/new-over-ceiling)
 *   node bin/check-file-budget.mjs --update    # rewrite the baseline from current sizes
 *   node bin/check-file-budget.mjs --ref <ref> # verify a committed ref instead of the working tree (no checkout/worktree required); incompatible with --update
 */
import process from "node:process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot();
const baselineRel = "bin/file-budget-baseline.json";
const baselinePath = join(root, baselineRel);

/** Each root's `src`/`tests` pair to scan, relative to the repo root. */
export const ROOTS = [{ src: "src", tests: "tests" }];

/** Ceiling for a coverage-eligible `src` file not in the baseline. */
export const SRC_CEILING_BYTES = 25_000;
/** Ceiling for a `tests` file not in the baseline. */
export const TEST_CEILING_BYTES = 60_000;

/** `error.code` for a caught filesystem error, or `undefined` if it isn't one. */
function errnoCodeOf(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(/** @type {{ code: unknown }} */ (error).code)
    : undefined;
}

/**
 * Recursively collect files under `dir` for which `matches(relPath)` is
 * true, pruning `dist`/`node_modules` subtrees. A missing `dir` yields no
 * files rather than throwing — a project without a `tests/` directory yet
 * is not an error here.
 *
 * @param {string} dir absolute directory to walk
 * @param {(relPath: string) => boolean} matches called with the path
 *   relative to the repo root
 * @returns {string[]} repo-relative paths, sorted
 */
export function walkMatching(dir, matches) {
  const results = [];
  const skipDirs = new Set(["dist", "node_modules"]);

  function recurse(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (cause) {
      if (errnoCodeOf(cause) === "ENOENT") return;
      throw cause;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        recurse(join(current, entry.name));
      } else if (entry.isFile()) {
        const rel = relative(root, join(current, entry.name));
        if (matches(rel)) results.push(rel);
      }
    }
  }

  recurse(dir);
  return results.sort();
}

/**
 * True for a `.ts` file that is part of `vitest.config.ts`'s coverage set —
 * neither a declaration file nor a barrel named exactly `index.ts`.
 *
 * @param {string} relPath repo-relative path
 * @returns {boolean}
 */
export function isCoverageEligibleSrcFile(relPath) {
  if (!relPath.endsWith(".ts") || relPath.endsWith(".d.ts")) return false;
  return !relPath.endsWith("/index.ts") && relPath !== "index.ts";
}

/**
 * @param {string} relPath repo-relative path
 * @returns {boolean}
 */
export function isTestFile(relPath) {
  return relPath.endsWith(".test.ts");
}

/**
 * Classify a `git ls-tree`-reported path the same way
 * {@link collectBudgetEntries}'s walk classifies a filesystem path — but
 * from a bare repo-relative string, since `--ref` mode has no directory to
 * walk.
 *
 * @param {string} relPath repo-relative path
 * @returns {"src" | "test" | null}
 */
export function classifyRefPath(relPath) {
  for (const { src, tests } of ROOTS) {
    if (relPath.startsWith(`${src}/`) && isCoverageEligibleSrcFile(relPath))
      return "src";
    if (relPath.startsWith(`${tests}/`) && isTestFile(relPath)) return "test";
  }
  return null;
}

/**
 * @typedef {Object} BudgetEntry
 * @property {string} path repo-relative
 * @property {number} bytes current size
 * @property {"src" | "test"} category
 */

/**
 * @param {BudgetEntry} entry
 * @returns {number} the ceiling that applies when `entry.path` is not baselined
 */
function ceilingFor(entry) {
  return entry.category === "src" ? SRC_CEILING_BYTES : TEST_CEILING_BYTES;
}

/**
 * Collect every file this gate scopes, with its current byte size.
 *
 * @returns {BudgetEntry[]}
 */
export function collectBudgetEntries() {
  /** @type {BudgetEntry[]} */
  const entries = [];

  for (const { src, tests } of ROOTS) {
    for (const rel of walkMatching(
      join(root, src),
      isCoverageEligibleSrcFile,
    )) {
      entries.push({
        path: rel,
        bytes: Buffer.byteLength(readFileSync(join(root, rel)), "utf8"),
        category: "src",
      });
    }
    for (const rel of walkMatching(join(root, tests), isTestFile)) {
      entries.push({
        path: rel,
        bytes: Buffer.byteLength(readFileSync(join(root, rel)), "utf8"),
        category: "test",
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * {@link collectBudgetEntries}'s equivalent for a committed ref, read via
 * `git` plumbing instead of `node:fs` — no checkout or worktree required.
 *
 * @param {string} ref a ref resolvable by `git` (branch, tag, SHA, `origin/*`)
 * @returns {BudgetEntry[]}
 * @throws {Error} if `ref` cannot be resolved, or `git` fails for any reason
 */
export function collectBudgetEntriesAtRef(ref) {
  const pathspecs = ROOTS.flatMap(({ src, tests }) => [`${src}/`, `${tests}/`]);
  const listing = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", ref, "--", ...pathspecs],
    { cwd: root, encoding: "utf8" },
  );

  /** @type {BudgetEntry[]} */
  const entries = [];
  for (const relPath of listing.split("\n")) {
    if (relPath === "") continue;
    const category = classifyRefPath(relPath);
    if (category === null) continue;
    const size = execFileSync("git", ["cat-file", "-s", `${ref}:${relPath}`], {
      cwd: root,
      encoding: "utf8",
    });
    entries.push({ path: relPath, bytes: Number(size.trim()), category });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * {@link readFileSync}/`JSON.parse` of `bin/file-budget-baseline.json`, but
 * against a committed ref instead of the working tree. A baseline absent at
 * `ref` yields `{}`; a present-but-invalid baseline's `JSON.parse` failure
 * propagates uncaught, same as the working-tree path.
 *
 * @param {string} ref a ref resolvable by `git`
 * @returns {Record<string, number>}
 */
export function readBaselineAtRef(ref) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${baselineRel}`], {
      cwd: root,
      encoding: "utf8",
    });
  } catch {
    return {};
  }
  const text = execFileSync("git", ["show", `${ref}:${baselineRel}`], {
    cwd: root,
    encoding: "utf8",
  });
  return JSON.parse(text);
}

/**
 * Read `--ref <value>` out of an argv array.
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function parseRefArg(argv) {
  const i = argv.indexOf("--ref");
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Compare current entries against the committed baseline.
 *
 * @param {BudgetEntry[]} entries
 * @param {Record<string, number>} baseline path -> recorded byte ceiling
 * @returns {{ violations: Array<{ path: string, bytes: number, limit: number, baselined: boolean }> }}
 */
export function checkBudget(entries, baseline) {
  const violations = [];
  for (const entry of entries) {
    const recorded = baseline[entry.path];
    if (recorded !== undefined) {
      if (entry.bytes > recorded) {
        violations.push({
          path: entry.path,
          bytes: entry.bytes,
          limit: recorded,
          baselined: true,
        });
      }
      continue;
    }
    const ceiling = ceilingFor(entry);
    if (entry.bytes > ceiling) {
      violations.push({
        path: entry.path,
        bytes: entry.bytes,
        limit: ceiling,
        baselined: false,
      });
    }
  }
  return { violations };
}

/**
 * Build the regenerated baseline: every entry currently over its ceiling,
 * keyed to its exact current size. Entries that no longer exceed their
 * ceiling (shrunk, or deleted) are dropped — the baseline only ever tracks
 * live debt.
 *
 * @param {BudgetEntry[]} entries
 * @returns {Record<string, number>} key-sorted
 */
export function buildBaseline(entries) {
  /** @type {Record<string, number>} */
  const next = {};
  for (const entry of entries) {
    if (entry.bytes > ceilingFor(entry)) next[entry.path] = entry.bytes;
  }
  return Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// `import.meta.url` is symlink-resolved but `process.argv[1]` is not, so
// comparing them directly is false under any symlinked path and the gate would
// never run -- exiting 0, a green check that checked nothing.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const argv = process.argv.slice(2);
  const reporter = createReporter(parseJsonFlag(argv));
  const ref = parseRefArg(argv);

  if (ref !== undefined && argv.includes("--update")) {
    reporter.fail(
      "--update cannot be combined with --ref -- there is no committed " +
        "blob to write a regenerated baseline into. Run --update on a " +
        "checked-out working tree instead.",
    );
    reporter.finish();
    process.exit(1);
  }

  let entries;
  try {
    entries = ref ? collectBudgetEntriesAtRef(ref) : collectBudgetEntries();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    reporter.fail(
      ref
        ? `Could not scan the tracked roots at ${ref}: ${message}`
        : `Could not scan ${relative(root, root)}: ${message}`,
    );
    reporter.finish();
    process.exit(1);
  }

  if (argv.includes("--update")) {
    const next = buildBaseline(entries);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const count = Object.keys(next).length;
    reporter.ok(
      `updated ${baselineRel} (${count} ${count === 1 ? "entry" : "entries"})`,
    );
    reporter.finish();
    process.exit(0);
  }

  /** @type {Record<string, number>} */
  let baseline = {};
  if (ref !== undefined) {
    try {
      baseline = readBaselineAtRef(ref);
    } catch (cause) {
      reporter.fail(
        `Could not parse ${baselineRel} at ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      reporter.finish();
      process.exit(1);
    }
  } else if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch (cause) {
      reporter.fail(
        `Could not parse ${baselineRel}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      reporter.finish();
      process.exit(1);
    }
  }

  const { violations } = checkBudget(entries, baseline);
  for (const v of violations) {
    if (v.baselined) {
      reporter.fail(
        `${v.path}: ${v.bytes} bytes -- grew past its baselined ceiling of ${v.limit} ` +
          `(bin/file-budget-baseline.json). Split the file before adding more to it.`,
      );
    } else {
      reporter.fail(
        `${v.path}: ${v.bytes} bytes -- exceeds the ${v.limit}-byte ceiling and is not in the ` +
          `baseline. Split it, or if the size is deliberate, run ` +
          `\`node bin/check-file-budget.mjs --update\` and explain why in the PR body.`,
      );
    }
  }

  if (violations.length > 0) {
    reporter.finish();
    process.exit(1);
  }

  reporter.ok(
    `${entries.length} file(s) checked against the size ratchet -- none exceed their limit.`,
  );
  reporter.finish();
}
