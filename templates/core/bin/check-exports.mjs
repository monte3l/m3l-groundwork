#!/usr/bin/env node
/**
 * Real packaging correctness: packs the target package (`--cwd <dir>`,
 * default the repo root) with `pnpm pack`, then runs publint and
 * are-the-types-wrong (attw) against the resulting tarball -- checking the
 * actual published artifact, not just the source tree. publint checks that
 * `package.json` (its `exports` map, `main`/`module`/`types` fields, and
 * which files are actually included) resolves the way consumers and
 * bundlers expect. attw checks that the package's TypeScript type
 * declarations actually match what each entry point resolves to at runtime
 * -- e.g. that an ESM import doesn't quietly get pointed at CommonJS-shaped
 * types. Skips cleanly (exit 0, one warning) when the target has no
 * `exports` field -- a project that isn't published doesn't need this gate,
 * and `/customize` removes the step entirely for non-library project kinds
 * rather than leaving a permanently-skipped one behind.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const argv = process.argv.slice(2);
const cwdIndex = argv.indexOf("--cwd");
const targetDir = cwdIndex === -1 ? "." : argv[cwdIndex + 1];

const reporter = createReporter(parseJsonFlag(argv));

const pkgPath = join(targetDir, "package.json");
if (!existsSync(pkgPath)) {
  reporter.fail(`no package.json at ${targetDir}`);
  reporter.finish();
  process.exit(process.exitCode ?? 1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (!pkg.exports) {
  reporter.warn(
    `${pkg.name ?? targetDir} declares no "exports" field -- skipping publint/attw (not a published package)`,
  );
  reporter.finish();
  process.exit(0);
}

const scratchDir = mkdtempSync(join(tmpdir(), "check-exports-"));
try {
  const packOutput = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", scratchDir],
    { cwd: targetDir, encoding: "utf8" },
  );
  const packLastLine = packOutput.trim().split("\n").pop() ?? "";
  // `pnpm pack --pack-destination <dir>` prints the tarball's ABSOLUTE path
  // as its last line, not a bare filename -- joining that onto scratchDir
  // again double-prefixes the path. Use it directly when it's already
  // absolute; only join when a filename-only form is ever printed instead.
  const tarballPath = isAbsolute(packLastLine)
    ? packLastLine
    : join(scratchDir, packLastLine);

  try {
    execFileSync("pnpm", ["exec", "publint", tarballPath], {
      stdio: "inherit",
    });
    reporter.ok("publint: package layout is correct");
  } catch {
    reporter.fail("publint reported a packaging issue (see output above)");
  }

  try {
    execFileSync(
      "pnpm",
      [
        "exec",
        "attw",
        "--pack",
        tarballPath,
        // This project is ESM-only by design (no CommonJS -- see
        // guard-no-commonjs.mjs); attw's default node16-from-CJS check
        // flags exactly the interop this package intentionally doesn't
        // support. Ignoring this one rule is attw's own documented
        // escape hatch for a deliberately ESM-only package, not a
        // suppression of a real problem.
        "--ignore-rules",
        "cjs-resolves-to-esm",
      ],
      { stdio: "inherit" },
    );
    reporter.ok("attw: type resolution matches every published entry point");
  } catch {
    reporter.fail("attw reported a type-resolution issue (see output above)");
  }
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

reporter.finish();
