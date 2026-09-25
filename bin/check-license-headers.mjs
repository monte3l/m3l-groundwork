#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Checks (and, with `--fix`, inserts) an SPDX copyright/license header on
 * every source file this repo's own tooling is made of -- OpenSSF Best
 * Practices' Gold-level `copyright_per_file`/`license_per_file` criteria.
 *
 * Two disjoint mechanisms cover every tracked file (`git ls-files`), never
 * both for the same file:
 *   - **An inline header** (`SPDX-FileCopyrightText` + `SPDX-License-Identifier`,
 *     as a line comment) on every `.ts`/`.mjs`/`.js`/`.sh`/`.yml`/`.yaml`
 *     file, except `templates/**` (see below) and anything a `REUSE.toml`
 *     annotation already claims (a generated file with that extension, such
 *     as the committed `pnpm-lock.yaml`, has nothing meaningful to carry a
 *     hand-written header in).
 *   - **A `REUSE.toml` annotation** for everything else: `templates/**` (THE
 *     BASELINE this CLI emits into other people's projects -- see
 *     `CLAUDE.md`'s "Repository Layout" -- deliberately ships with no inline
 *     header of its own, so a bootstrapped project never carries this
 *     repo's copyright line as if it were the new project's), plus data
 *     files and dotfiles with no comment syntax of their own (JSON,
 *     Markdown, `.gitignore`, `.npmrc`, `.node-version`, `.prettierignore`,
 *     `LICENSE`).
 *
 * `--check` (default, the `pnpm verify` gate's `license-headers` step):
 * exits 1 and lists every header-eligible file missing the header, AND every
 * tracked file that is neither header-eligible nor matched by a `REUSE.toml`
 * glob (a gap in the REUSE annotation set itself, not just a missing
 * header). `--fix`: inserts the header into every header-eligible file
 * missing one, after a shebang line if present, and leaves every other line
 * untouched.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

/** Extensions that carry an inline SPDX header via a `#`/`//` line comment. */
const HEADER_EXTENSIONS = new Set([
  ".ts",
  ".mjs",
  ".js",
  ".sh",
  ".yml",
  ".yaml",
]);

const HASH_COMMENT_EXTENSIONS = new Set([".sh", ".yml", ".yaml"]);

const COPYRIGHT_MARKER = "SPDX-FileCopyrightText:";
const LICENSE_MARKER = "SPDX-License-Identifier:";

function headerLines(ext) {
  const prefix = HASH_COMMENT_EXTENSIONS.has(ext) ? "#" : "//";
  return [
    `${prefix} SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors`,
    `${prefix} SPDX-License-Identifier: MIT`,
  ];
}

/**
 * Every path git tracks, repo-root-relative, forward-slash-separated.
 * `-z` NUL-delimits the output instead of newline-delimiting it, so a path
 * containing a character `core.quotePath` would otherwise quote/escape
 * (non-ASCII, a literal newline) comes back exactly as git stores it,
 * matching what `readFileSync`/`writeFileSync` expect.
 */
function listTrackedFiles() {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((line) => line.length > 0);
}

/**
 * A tiny, deliberately non-general glob-to-regex translator: only `**`
 * (any number of path segments, including zero) and `*` (anything but `/`)
 * are supported, which is all `REUSE.toml`'s own patterns use. Every other
 * character is treated literally.
 */
function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        pattern += "(?:.*/)?";
        i += 2;
      } else {
        pattern += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (/[.+^${}()|[\]\\?]/.test(ch)) {
      pattern += `\\${ch}`;
      continue;
    }
    pattern += ch;
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Every `path = [...]` glob string across every `[[annotations]]` block in
 * `REUSE.toml`. Only the array form (`path = ["a", "b"]`) is supported, not
 * REUSE's single-string form (`path = "a"`) or single-quoted strings -- if
 * that ever changes, a silently-dropped annotation would quietly shrink
 * REUSE.toml's coverage, so this counts `[[annotations]]` blocks against
 * blocks that actually yielded a `path` array and fails loudly on a
 * mismatch rather than trusting an empty result.
 */
function readReuseGlobs() {
  const content = readFileSync(join(repoRoot, "REUSE.toml"), "utf8");
  const blockCount = (content.match(/^\[\[annotations]]/gm) ?? []).length;
  const globs = [];
  const blockPattern = /\[\[annotations]][\s\S]*?path\s*=\s*\[([\s\S]*?)]/g;
  let parsedBlocks = 0;
  for (const match of content.matchAll(blockPattern)) {
    parsedBlocks += 1;
    const arrayBody = match[1] ?? "";
    for (const stringMatch of arrayBody.matchAll(/"([^"]*)"/g)) {
      const glob = stringMatch[1];
      if (glob !== undefined) globs.push(glob);
    }
  }
  if (parsedBlocks !== blockCount) {
    throw new Error(
      `check-license-headers: REUSE.toml has ${blockCount} [[annotations]] block(s) but only ` +
        `${parsedBlocks} had a parseable \`path = [...]\` array -- this parser only supports ` +
        "that array form; check for a single-string or single-quoted `path` value.",
    );
  }
  return globs;
}

function hasHeader(content) {
  const firstLines = content.split("\n", 6).join("\n");
  return (
    firstLines.includes(COPYRIGHT_MARKER) && firstLines.includes(LICENSE_MARKER)
  );
}

function withHeaderInserted(content, ext) {
  const lines = content.split("\n");
  const hasShebang = lines[0]?.startsWith("#!") ?? false;
  const insertAt = hasShebang ? 1 : 0;
  lines.splice(insertAt, 0, ...headerLines(ext), "");
  return lines.join("\n");
}

function main() {
  const fix = process.argv.includes("--fix");
  const tracked = listTrackedFiles();
  const reuseGlobs = readReuseGlobs().map(globToRegExp);
  const isReuseExempt = (path) => reuseGlobs.some((re) => re.test(path));

  const headerEligible = tracked.filter(
    (path) =>
      !path.startsWith("templates/") &&
      HEADER_EXTENSIONS.has(extname(path)) &&
      !isReuseExempt(path),
  );
  const uncovered = tracked.filter(
    (path) =>
      !path.startsWith("templates/") &&
      !HEADER_EXTENSIONS.has(extname(path)) &&
      !isReuseExempt(path),
  );

  if (uncovered.length > 0) {
    console.error(
      `check-license-headers: ${uncovered.length} tracked file(s) are neither header-eligible ` +
        "nor matched by a REUSE.toml annotation -- add a glob to REUSE.toml or an extension to " +
        "HEADER_EXTENSIONS:",
    );
    for (const path of uncovered) console.error(`  ${path}`);
    process.exit(1);
  }

  let fixedCount = 0;
  const missing = [];

  for (const path of headerEligible) {
    const absolute = join(repoRoot, path);
    const content = readFileSync(absolute, "utf8");
    if (hasHeader(content)) continue;
    if (fix) {
      writeFileSync(absolute, withHeaderInserted(content, extname(path)));
      fixedCount += 1;
    } else {
      missing.push(path);
    }
  }

  if (fix) {
    console.log(`check-license-headers: fixed ${fixedCount} file(s)`);
    return;
  }

  if (missing.length > 0) {
    console.error(
      `check-license-headers: ${missing.length} file(s) missing an SPDX header ` +
        "(SPDX-FileCopyrightText + SPDX-License-Identifier):",
    );
    for (const path of missing) console.error(`  ${path}`);
    console.error(
      "Run `node bin/check-license-headers.mjs --fix` to insert them.",
    );
    process.exit(1);
  }

  console.log(
    `check-license-headers: ok -- ${headerEligible.length} file(s) carry an SPDX header, ` +
      `${tracked.length - headerEligible.length} covered by REUSE.toml`,
  );
}

main();
