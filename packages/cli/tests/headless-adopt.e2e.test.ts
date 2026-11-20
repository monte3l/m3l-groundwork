// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * End-to-end `--adopt --json` pending document through the real bin script:
 * the report's `pending` and `artifacts.pending` match
 * `.groundwork/headless/pending.json` on disk, the document passes the
 * shipped validator as `partial` (never `complete`), is bound to
 * inventory.json's bytes, and the survey stays read-only for project files.
 * Needs `pnpm build` first; run via `pnpm test:e2e`.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateAnswers, type AnswersV1 } from "../src/headless/contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");
const PENDING_REL = ".groundwork/headless/pending.json";

function run(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      snapshot.set(
        relative(root, abs).split("\\").join("/"),
        createHash("sha256").update(readFileSync(abs)).digest("hex"),
      );
    }
  };
  visit(root);
  return snapshot;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** One baseline file the project has but differs from (tsconfig.json); eslint.config.js is absent. */
function buildProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "legacy", type: "module" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: false } }),
  );
}

function withProject<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hl-adopt-pending-"));
  try {
    buildProject(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Report {
  status: string;
  exitCode: number;
  artifacts: { inventory: string | null; pending: string | null };
  pending: unknown[];
}

describe("adopt --json pending document (bin)", () => {
  it("reports the pending entries and path, matching pending.json on disk, and changes no project file", () => {
    withProject((dir) => {
      const before = snapshotTree(dir);

      const { status, stdout } = run([dir, "--json"]);

      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report).toMatchObject({ status: "ok", exitCode: 0 });
      expect(report.artifacts.pending).toBe(PENDING_REL);

      const text = readFileSync(join(dir, PENDING_REL), "utf8");
      const doc = JSON.parse(text) as AnswersV1;
      expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`);
      expect(report.pending).toEqual(doc.pending);

      // The shipped validator: partial yes, complete no.
      expect(validateAnswers(doc, "partial").ok).toBe(true);
      expect(validateAnswers(doc, "complete").ok).toBe(false);

      expect(doc.basis).toEqual({
        inventorySha256: sha256(join(dir, ".groundwork", "inventory.json")),
      });
      expect(doc.interview.kind).toBeNull();
      expect(doc.interview.runtime).toBeNull();
      const pointers = doc.pending.map((p) => p.pointer);
      expect(pointers).toContain("/interview/kind");
      expect(pointers).toContain("/interview/runtime");

      const index = (doc.adopt?.conflicts ?? []).findIndex(
        (c) => c.path === "tsconfig.json",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(doc.adopt?.conflicts[index]?.resolution).toBeNull();
      expect(pointers).toContain(
        `/adopt/conflicts/${String(index)}/resolution`,
      );
      expect(doc.adopt?.additions).toContainEqual({
        path: "eslint.config.js",
        action: "add",
      });

      // Read-only invariant: every pre-existing file is byte-identical, and
      // every new file is under .groundwork/ or the guarded skill copy.
      const after = snapshotTree(dir);
      for (const [path, hash] of before) expect(after.get(path)).toBe(hash);
      for (const path of after.keys()) {
        if (before.has(path)) continue;
        expect(
          path.startsWith(".groundwork/") ||
            path.startsWith(".claude/skills/customize/"),
        ).toBe(true);
      }
      expect(
        [...after.keys()].filter((p) => p.startsWith(".groundwork/headless/")),
      ).toEqual([PENDING_REL]);
    });
  });

  it("a second run after a project file changed replaces pending.json with a new basis hash", () => {
    withProject((dir) => {
      run([dir, "--json"]);
      const first = JSON.parse(
        readFileSync(join(dir, PENDING_REL), "utf8"),
      ) as AnswersV1;
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, target: "es2022" } }),
      );

      const { status } = run([dir, "--json"]);

      expect(status).toBe(0);
      const second = JSON.parse(
        readFileSync(join(dir, PENDING_REL), "utf8"),
      ) as AnswersV1;
      expect(second.basis).toEqual({
        inventorySha256: sha256(join(dir, ".groundwork", "inventory.json")),
      });
      expect(second.basis).not.toEqual(first.basis);
    });
  });

  it("adopt without --json creates no .groundwork/headless/ directory and reports nothing pending", () => {
    withProject((dir) => {
      const { status, stdout } = run([dir]);
      expect(status).toBe(0);
      expect(stdout).not.toContain("groundwork.report");
      expect(existsSync(join(dir, ".groundwork", "headless"))).toBe(false);
    });
  });

  it("a non-json re-run removes the previous pending.json", () => {
    withProject((dir) => {
      run([dir, "--json"]);
      expect(existsSync(join(dir, PENDING_REL))).toBe(true);
      run([dir]);
      expect(existsSync(join(dir, PENDING_REL))).toBe(false);
    });
  });

  it("creates headless on demand when .groundwork/ already exists", () => {
    withProject((dir) => {
      mkdirSync(join(dir, ".groundwork"), { recursive: true });
      const { status } = run([dir, "--json"]);
      expect(status).toBe(0);
      expect(existsSync(join(dir, PENDING_REL))).toBe(true);
    });
  });

  it("under --json stderr announces pending.json and stdout is exactly one JSON document line", () => {
    withProject((dir) => {
      const { status, stdout, stderr } = run([dir, "--json"]);

      expect(status).toBe(0);
      expect(stderr).toContain(`wrote ${PENDING_REL}`);
      expect(stdout).not.toContain(`wrote ${PENDING_REL}`);
      expect(stdout.endsWith("\n")).toBe(true);
      const lines = stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        schema: "groundwork.report",
      });
    });
  });

  it("without --json no line announces pending.json", () => {
    withProject((dir) => {
      const { status, stdout, stderr } = run([dir]);

      expect(status).toBe(0);
      expect(stdout).not.toContain(PENDING_REL);
      expect(stderr).not.toContain(PENDING_REL);
    });
  });
});
