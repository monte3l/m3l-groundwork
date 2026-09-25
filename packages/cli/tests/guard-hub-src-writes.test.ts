// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for `shouldBlockHubSrcWrite`, the pure decision function
 * `.claude/hooks/guard-hub-src-writes.mjs` exports. Nothing here tested this
 * function directly before -- this file covers the case-insensitive
 * filesystem bypass shared with `guard-branch-isolation.mjs`: `isProtectedPath`
 * compares `filePath` to `projectDir` with a literal string prefix check, so
 * a `file_path` payload spelled with different case than `projectDir` (which,
 * on macOS's default case-insensitive-but-case-preserving APFS, still
 * denotes the exact same real file) fails that prefix check and the hook
 * wrongly allows a hub-authored write into a guarded `src/`/`tests/` path.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const hookPath = join(repoRoot, ".claude", "hooks", "guard-hub-src-writes.mjs");

// Plain ESM under .claude/hooks/, outside every tsconfig -- loaded by URL
// (see protected-paths.test.ts / eval-lib.test.ts for the same pattern).
// The hook's own relative imports (`../../bin/lib/protected-paths.mjs`,
// `../../bin/lib/agent-roster.mjs`) resolve against its real location in
// the checkout, so no temp-directory mirroring is needed here.
const hook = (await import(
  pathToFileURL(join(repoRoot, ".claude", "hooks", "guard-hub-src-writes.mjs"))
    .href
)) as {
  shouldBlockHubSrcWrite: (
    filePath: string | undefined,
    agentType: unknown,
    projectDir?: string,
  ) => boolean;
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
  const probe = mkdtempSync(join(tmpdir(), "hub-guard-case-probe-"));
  try {
    const wrong = invertCase(realpathSync.native(probe));
    return wrong !== probe && existsSync(wrong);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const caseInsensitiveFs = isFilesystemCaseInsensitive();

describe("shouldBlockHubSrcWrite", () => {
  it.skipIf(!caseInsensitiveFs)(
    "blocks a hub write whose file_path is spelled with different case than projectDir but denotes the same real project on a case-insensitive filesystem",
    () => {
      const projectDir = "/Users/dev/My-Project";
      // Same path as projectDir + packages/cli/src/main.ts, but with the
      // shared prefix portion wrongly cased -- on a case-insensitive
      // filesystem this is the exact same real file.
      const filePath = "/USERS/DEV/my-project/packages/cli/src/main.ts";

      expect(hook.shouldBlockHubSrcWrite(filePath, undefined, projectDir)).toBe(
        true,
      );
    },
  );

  it("blocks a hub write into packages/cli/src when file_path and projectDir share identical case (sanity pin)", () => {
    expect(
      hook.shouldBlockHubSrcWrite(
        "/Users/dev/my-project/packages/cli/src/main.ts",
        undefined,
        "/Users/dev/my-project",
      ),
    ).toBe(true);
  });

  it("does not block a file_path genuinely outside projectDir (sanity pin)", () => {
    expect(
      hook.shouldBlockHubSrcWrite(
        "/some/other/project/packages/cli/src/x.ts",
        undefined,
        "/Users/x/my-project",
      ),
    ).toBe(false);
  });

  it("blocks a hub write whose file_path is RELATIVE, regardless of projectDir -- isProtectedPath matches a relative path as-is", () => {
    expect(
      hook.shouldBlockHubSrcWrite(
        "packages/cli/src/x.ts",
        undefined,
        "/Users/dev/my-project",
      ),
    ).toBe(true);
  });
});

/**
 * Regression test for the actual bug: the pure `shouldBlockHubSrcWrite`
 * above was never broken by it -- the bug lived in this hook's entry-point
 * wrapper, which used to canonicalize `filePath` unconditionally
 * (`canonicalize()` internally calls `resolve()`, anchoring a RELATIVE path
 * at the hook process's `cwd`) before comparing it against `projectDir`
 * (itself derived from `CLAUDE_PROJECT_DIR`, a DIFFERENT anchor than `cwd`
 * in general). A relative `file_path` payload therefore resolved against the
 * wrong root and could wrongly compare as outside the project, allowing a
 * write that should have been blocked. The fix only canonicalizes an
 * ABSOLUTE `filePath` (see `isAbsoluteLike` in protected-paths.mjs) and
 * leaves a relative one unresolved, which is exactly what these subprocess
 * runs pin: a mismatched `cwd`/`CLAUDE_PROJECT_DIR` pair must not change the
 * verdict for a relative `file_path`.
 */
describe("guard-hub-src-writes entry point (subprocess)", () => {
  function run(
    cwd: string,
    projectDir: string,
  ): { status: number | null; stderr: string } {
    const result = spawnSync("node", [hookPath], {
      input: JSON.stringify({
        tool_input: { file_path: "packages/cli/src/x.ts" },
      }),
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr };
  }

  it("blocks a hub write with a RELATIVE file_path when cwd differs from CLAUDE_PROJECT_DIR", () => {
    const fakeProject = mkdtempSync(
      join(tmpdir(), "guard-hub-src-writes-project-"),
    );
    const elsewhere = mkdtempSync(
      join(tmpdir(), "guard-hub-src-writes-elsewhere-"),
    );
    try {
      mkdirSync(join(fakeProject, "packages", "cli", "src"), {
        recursive: true,
      });

      const { status, stderr } = run(elsewhere, fakeProject);

      expect(status).toBe(2);
      expect(stderr).toContain("guard-hub-src-writes");
    } finally {
      rmSync(fakeProject, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("still blocks a hub write with a RELATIVE file_path when cwd matches CLAUDE_PROJECT_DIR (no regression in the common case)", () => {
    const fakeProject = mkdtempSync(
      join(tmpdir(), "guard-hub-src-writes-project-"),
    );
    try {
      mkdirSync(join(fakeProject, "packages", "cli", "src"), {
        recursive: true,
      });

      const { status, stderr } = run(fakeProject, fakeProject);

      expect(status).toBe(2);
      expect(stderr).toContain("guard-hub-src-writes");
    } finally {
      rmSync(fakeProject, { recursive: true, force: true });
    }
  });
});
