// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Backfill tests for `bin/lib/hook-input.mjs`'s shared stdin-parsing helper
 * and path-exclusion predicate -- the plumbing both `.claude/hooks/
 * post-edit-verify.mjs` and `.claude/hooks/nudge-invariants.mjs` use to read
 * their PreToolUse/PostToolUse payload and decide which paths to ignore.
 * `readHookInput` is exercised in-process by temporarily replacing
 * `process.stdin` with a `Readable.from(...)` stream (Node allows this via
 * `Object.defineProperty` since the property is `configurable`), restored in
 * `afterEach` -- faster and more reliable in a Vitest worker than a real
 * subprocess, and this module never calls `process.exit` so there is no
 * safety reason to prefer one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// protected-paths.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "hook-input.mjs")).href
)) as {
  readHookInput: () => Promise<unknown>;
  isExcludedHookPath: (rel: string) => boolean;
};

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "stdin",
);

/** Temporarily stands a `Readable` in for `process.stdin` so `readHookInput`
 * can be exercised in-process without a real subprocess. */
function stubStdin(raw: string): void {
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(raw, "utf8")]),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalStdinDescriptor) {
    Object.defineProperty(process, "stdin", originalStdinDescriptor);
  }
});

describe("readHookInput", () => {
  it("round-trips a valid JSON object payload", async () => {
    stubStdin(JSON.stringify({ tool_input: { file_path: "src/a.ts" } }));

    await expect(lib.readHookInput()).resolves.toEqual({
      tool_input: { file_path: "src/a.ts" },
    });
  });

  it("returns undefined for malformed JSON", async () => {
    stubStdin("{not valid json");

    await expect(lib.readHookInput()).resolves.toBeUndefined();
  });

  it("returns undefined for JSON literal null", async () => {
    stubStdin("null");

    await expect(lib.readHookInput()).resolves.toBeUndefined();
  });

  it("returns undefined for a bare JSON number", async () => {
    stubStdin("42");

    await expect(lib.readHookInput()).resolves.toBeUndefined();
  });

  it("returns undefined for a bare JSON string", async () => {
    stubStdin('"hello"');

    await expect(lib.readHookInput()).resolves.toBeUndefined();
  });

  it("returns undefined for empty stdin", async () => {
    stubStdin("");

    await expect(lib.readHookInput()).resolves.toBeUndefined();
  });

  // `typeof parsed === "object" && parsed !== null` is true for an array
  // too (`typeof [] === "object"`), so a JSON array payload round-trips
  // rather than being treated as "no usable payload" -- pinning the real
  // behavior, not the behavior a stricter object-only check would have.
  it("round-trips a JSON array payload (typeof array is object, not excluded)", async () => {
    stubStdin(JSON.stringify([1, 2, 3]));

    await expect(lib.readHookInput()).resolves.toEqual([1, 2, 3]);
  });
});

describe("isExcludedHookPath", () => {
  it("does not exclude an ordinary in-project path", () => {
    expect(lib.isExcludedHookPath("packages/cli/src/main.ts")).toBe(false);
  });

  it("excludes a path that escapes the project root (.. prefix)", () => {
    expect(lib.isExcludedHookPath("../outside/file.ts")).toBe(true);
  });

  it("excludes a path containing a node_modules/ segment", () => {
    expect(
      lib.isExcludedHookPath("packages/cli/node_modules/pkg/index.js"),
    ).toBe(true);
  });

  it("excludes a path with a dist/ segment at the root", () => {
    expect(lib.isExcludedHookPath("dist/foo.js")).toBe(true);
  });

  it("excludes a path with a nested dist/ segment", () => {
    expect(lib.isExcludedHookPath("nested/dist/foo.js")).toBe(true);
  });

  it("excludes a path with a coverage/ segment", () => {
    expect(lib.isExcludedHookPath("coverage/lcov-report/index.html")).toBe(
      true,
    );
  });

  it("does not exclude a path that merely contains the substring 'dist' without a path-segment boundary", () => {
    expect(lib.isExcludedHookPath("mydist/foo.js")).toBe(false);
  });
});
