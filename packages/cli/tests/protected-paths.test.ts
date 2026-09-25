/**
 * `isProtectedPath` gains an optional second `projectDir` argument that
 * scopes an ABSOLUTE `filePath` to the project before applying the
 * `src/`/`tests/` regex, and normalizes `\` separators to `/` first so a
 * Windows-style path is matched the same as a POSIX one. See
 * `bin/lib/protected-paths.mjs`'s header comment for the callers
 * (`guard-branch-isolation.mjs`, `guard-hub-src-writes.mjs`).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// eval-lib.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "protected-paths.mjs")).href
)) as {
  isProtectedPath: (filePath: string, projectDir?: string) => boolean;
  canonicalize: (path: string) => string;
};

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
 * existing path to the same file (macOS APFS by default; most Linux
 * filesystems are case-sensitive and would not). */
function isFilesystemCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "protected-paths-case-probe-"));
  try {
    const wrong = invertCase(probe);
    return wrong !== probe && existsSync(wrong);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const caseInsensitiveFs = isFilesystemCaseInsensitive();

describe("isProtectedPath", () => {
  it("matches a relative src/ path with no projectDir needed (unchanged behavior)", () => {
    expect(lib.isProtectedPath("packages/cli/src/main.ts")).toBe(true);
  });

  it("does not protect an absolute path whose own checkout happens to contain a literal /src/ segment above/unrelated to projectDir", () => {
    // The checkout itself lives under a path containing "/src/" (e.g. a
    // clone at ~/src/other-project), and that path does not even start
    // with the real project's projectDir -- it must not be treated as
    // protected just because the substring "/src/" appears somewhere in it.
    expect(
      lib.isProtectedPath(
        "/Users/dev/src/other-project/CLAUDE.md",
        "/Users/dev/my-actual-project",
      ),
    ).toBe(false);
  });

  it("protects an absolute path that starts with projectDir and lands in packages/cli/src/ once made relative", () => {
    expect(
      lib.isProtectedPath(
        "/Users/dev/my-actual-project/packages/cli/src/main.ts",
        "/Users/dev/my-actual-project",
      ),
    ).toBe(true);
  });

  it("matches a Windows-style absolute path (backslash separators) against a Windows-style projectDir", () => {
    expect(
      lib.isProtectedPath("C:\\proj\\packages\\cli\\src\\main.ts", "C:\\proj"),
    ).toBe(true);
  });

  it("does not protect an absolute path under a completely different project directory", () => {
    expect(
      lib.isProtectedPath(
        "/Users/dev/other-project/packages/cli/src/main.ts",
        "/Users/dev/my-actual-project",
      ),
    ).toBe(false);
  });

  it("does not protect a real file under the real project that is outside src/ and tests/", () => {
    expect(
      lib.isProtectedPath(
        "/Users/dev/my-actual-project/CLAUDE.md",
        "/Users/dev/my-actual-project",
      ),
    ).toBe(false);
  });
});

describe("canonicalize", () => {
  let existingRealDir: string;

  it("returns the same real, absolute path for a directory that already exists", () => {
    existingRealDir = mkdtempSync(join(tmpdir(), "canonicalize-existing-"));
    try {
      expect(lib.canonicalize(existingRealDir)).toBe(
        realpathSync.native(existingRealDir),
      );
    } finally {
      rmSync(existingRealDir, { recursive: true, force: true });
    }
  });

  it("does not throw for a non-existent multi-level tail under a real directory, and re-appends the unresolved tail unchanged", () => {
    existingRealDir = mkdtempSync(join(tmpdir(), "canonicalize-tail-"));
    try {
      const canonicalRoot = realpathSync.native(existingRealDir);
      const target = join(
        existingRealDir,
        "not-yet-created",
        "nested",
        "file.ts",
      );

      const result = lib.canonicalize(target);

      expect(result.startsWith(canonicalRoot)).toBe(true);
      expect(result.endsWith("not-yet-created/nested/file.ts")).toBe(true);
    } finally {
      rmSync(existingRealDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!caseInsensitiveFs)(
    "resolves a wrongly-cased spelling of a real existing directory to the same canonical result (Bug 1 regression)",
    () => {
      existingRealDir = mkdtempSync(join(tmpdir(), "canonicalize-case-"));
      try {
        const canonical = realpathSync.native(existingRealDir);
        const wronglyCased = invertCase(canonical);

        expect(lib.canonicalize(wronglyCased)).toBe(canonical);
      } finally {
        rmSync(existingRealDir, { recursive: true, force: true });
      }
    },
  );
});
