// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Inventory schema 7 through `runAdopt`: every baseline file whose conflict is
 * "divergent" is staged as an inert `<path>.staged` copy under
 * `.groundwork/baseline-divergent/` (token-substituted bytes -- exactly what
 * the comparison used), recorded as `inventory.stagedDivergent` with the
 * sha256 of each staged copy. `stagedBaseline` stays absent-only. The new
 * directory is written through the same guarded staging as `baseline/`, and a
 * re-run replaces it wholesale. Adoption still writes nothing but
 * `.groundwork/` (and the guarded customize skill copy, mocked here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Out } from "../src/output.js";
import type { Inventory } from "../src/inventory.js";

vi.mock("../src/git.js", () => ({ gitInit: vi.fn(), runInstall: vi.fn() }));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: vi.fn(() => ({ filesWritten: [] })),
  installCustomizeSkillGuarded: vi.fn(() => ({
    filesWritten: [],
    location: "claude" as const,
  })),
}));

const { main } = await import("../src/main.js");

const out = {
  info: vi.fn(),
  notice: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
} satisfies Out;

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = join(here, "..", "..", "..", "templates", "core");

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The baseline's package.json with the project-name token substituted -- the bytes the comparison used. */
function substitutedPackageJson(name: string): string {
  return readFileSync(join(coreDir, "package.json"), "utf8")
    .split("__PROJECT_NAME__")
    .join(name);
}

function listFiles(root: string): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else results.push(relative(root, abs));
    }
  };
  if (existsSync(root)) visit(root);
  return results.sort();
}

describe("runAdopt -- stagedDivergent (inventory schema 7)", () => {
  let root: string;
  let project: string;
  const groundwork = () => join(project, ".groundwork");
  const divergentDir = () => join(groundwork(), "baseline-divergent");
  const readInventory = () =>
    JSON.parse(
      readFileSync(join(groundwork(), "inventory.json"), "utf8"),
    ) as Inventory;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "main-adopt-divergent-"));
    project = join(root, "project");
    mkdirSync(project);
    // package.json and tsconfig.json diverge (key-level); .node-version is
    // byte-identical to the baseline's; everything else is absent.
    writeFileSync(
      join(project, "package.json"),
      '{\n  "name": "acme",\n  "type": "commonjs"\n}\n',
    );
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    writeFileSync(
      join(project, ".node-version"),
      readFileSync(join(coreDir, ".node-version")),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe.each([[[]], [["--json"]]] as [string[]][])(
    "with extra flags %j",
    (flags) => {
      const run = () =>
        main([project, "--name", "acme", ...flags], "linux", out);

      it("records stagedDivergent as { dir, suffix, files } with exactly the divergent conflicts, key-level JSON files included", () => {
        run();
        const inventory = readInventory();
        expect(inventory.schemaVersion).toBe(7);
        expect(inventory.stagedDivergent.dir).toBe(
          ".groundwork/baseline-divergent",
        );
        expect(inventory.stagedDivergent.suffix).toBe(".staged");
        const divergentPaths = inventory.conflicts
          .filter((c) => c.status === "divergent")
          .map((c) => c.relPath)
          .sort();
        expect(divergentPaths).toEqual(["package.json", "tsconfig.json"]);
        expect(
          inventory.stagedDivergent.files.map((f) => f.path).sort(),
        ).toEqual(divergentPaths);
        for (const file of inventory.stagedDivergent.files) {
          expect(file.staged).toBe(`${file.path}.staged`);
        }
      });

      it("stages the token-substituted baseline bytes (what the comparison used), with each entry's sha256 equal to the staged copy's bytes", () => {
        run();
        const inventory = readInventory();
        const pkg = inventory.stagedDivergent.files.find(
          (f) => f.path === "package.json",
        );
        expect(pkg).toBeDefined();
        const stagedBytes = readFileSync(
          join(divergentDir(), "package.json.staged"),
        );
        expect(stagedBytes.toString("utf8")).toBe(
          substitutedPackageJson("acme"),
        );
        expect(stagedBytes.toString("utf8")).not.toContain("__PROJECT_NAME__");
        expect(pkg?.sha256).toBe(sha256Hex(stagedBytes));

        for (const file of inventory.stagedDivergent.files) {
          const bytes = readFileSync(join(divergentDir(), file.staged));
          expect(file.sha256).toBe(sha256Hex(bytes));
        }
        expect(
          readFileSync(join(divergentDir(), "tsconfig.json.staged")),
        ).toEqual(readFileSync(join(coreDir, "tsconfig.json")));
      });

      it("writes only the inert .staged names: no bare divergent file lands in baseline-divergent/", () => {
        run();
        const files = listFiles(divergentDir());
        expect(files).toEqual(["package.json.staged", "tsconfig.json.staged"]);
      });

      it("never lists an identical or an absent file in stagedDivergent, and leaves stagedBaseline absent-only and unchanged", () => {
        run();
        const inventory = readInventory();
        const divergentPaths = inventory.stagedDivergent.files.map(
          (f) => f.path,
        );
        expect(
          inventory.conflicts.find((c) => c.relPath === ".node-version")
            ?.status,
        ).toBe("identical");
        expect(divergentPaths).not.toContain(".node-version");
        const absentPaths = inventory.conflicts
          .filter((c) => c.status === "absent")
          .map((c) => c.relPath)
          .sort();
        expect(absentPaths.length).toBeGreaterThan(0);
        for (const path of absentPaths) {
          expect(divergentPaths).not.toContain(path);
        }
        expect(inventory.stagedBaseline.dir).toBe(".groundwork/baseline");
        expect(
          inventory.stagedBaseline.files.map((f) => f.path).sort(),
        ).toEqual(absentPaths);
        expect(
          existsSync(join(groundwork(), "baseline", "package.json.staged")),
        ).toBe(false);
      });

      it("records targetSha256 as the sha256 of the real project file's bytes for identical and divergent files, null for absent, on conflicts and on every pack's fileConflicts", () => {
        run();
        const inventory = readInventory();
        for (const c of inventory.conflicts) {
          if (c.status === "absent") {
            expect(c.targetSha256).toBeNull();
          } else {
            expect(c.targetSha256).toBe(
              sha256Hex(readFileSync(join(project, c.relPath))),
            );
          }
        }
        expect(
          inventory.conflicts.find((c) => c.relPath === "package.json")
            ?.targetSha256,
        ).toBe(sha256Hex('{\n  "name": "acme",\n  "type": "commonjs"\n}\n'));
        expect(inventory.packs.length).toBeGreaterThan(0);
        for (const pack of inventory.packs) {
          for (const c of pack.fileConflicts) {
            expect(c).toHaveProperty("targetSha256");
            if (c.status === "absent") {
              expect(c.targetSha256).toBeNull();
            } else {
              expect(c.targetSha256).toBe(
                sha256Hex(readFileSync(join(project, c.relPath))),
              );
            }
          }
        }
      });

      it("changes no pre-existing project file and adds nothing outside .groundwork/", () => {
        const before = new Map(
          listFiles(project).map((p) => [
            p,
            sha256Hex(readFileSync(join(project, p))),
          ]),
        );
        run();
        const after = listFiles(project);
        for (const [path, hash] of before) {
          expect(sha256Hex(readFileSync(join(project, path)))).toBe(hash);
        }
        for (const path of after) {
          if (before.has(path)) continue;
          expect(path.startsWith(".groundwork/")).toBe(true);
        }
      });

      it("replaces a previous baseline-divergent/ wholesale on a re-run: no stale file lingers", () => {
        mkdirSync(join(divergentDir(), "old"), { recursive: true });
        writeFileSync(
          join(divergentDir(), "old", "gone.txt.staged"),
          "stale\n",
        );
        writeFileSync(join(divergentDir(), "package.json.staged"), "stale\n");
        run();
        expect(listFiles(divergentDir())).toEqual([
          "package.json.staged",
          "tsconfig.json.staged",
        ]);
        expect(
          readFileSync(join(divergentDir(), "package.json.staged"), "utf8"),
        ).toBe(substitutedPackageJson("acme"));
      });

      it("removes a previous baseline-divergent/ entirely when nothing diverges any more", () => {
        mkdirSync(divergentDir(), { recursive: true });
        writeFileSync(join(divergentDir(), "package.json.staged"), "stale\n");
        writeFileSync(
          join(project, "package.json"),
          substitutedPackageJson("acme"),
        );
        writeFileSync(
          join(project, "tsconfig.json"),
          readFileSync(join(coreDir, "tsconfig.json")),
        );
        run();
        const inventory = readInventory();
        expect(inventory.conflicts.some((c) => c.status === "divergent")).toBe(
          false,
        );
        expect(inventory.stagedDivergent).toEqual({
          dir: ".groundwork/baseline-divergent",
          suffix: ".staged",
          files: [],
        });
        expect(existsSync(divergentDir())).toBe(false);
      });

      it("sweeps a stale .baseline-divergent-* work directory a crashed earlier run left", () => {
        const stale = join(groundwork(), ".baseline-divergent-ABC123");
        mkdirSync(join(stale, "baseline-divergent"), { recursive: true });
        writeFileSync(join(stale, "baseline-divergent", "x.staged"), "x\n");
        run();
        expect(existsSync(stale)).toBe(false);
        expect(
          readdirSync(groundwork()).filter((n) =>
            n.startsWith(".baseline-divergent-"),
          ),
        ).toEqual([]);
      });

      it("refuses a symlinked baseline-divergent/ before deleting or writing anything: the previous inventory survives and the link target is untouched", () => {
        mkdirSync(groundwork(), { recursive: true });
        const outside = join(root, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel.txt"), "keep\n");
        symlinkSync(outside, divergentDir());
        const inventoryPath = join(groundwork(), "inventory.json");
        writeFileSync(inventoryPath, "previous inventory\n");

        expect(() => run()).toThrow(/symlink/i);

        expect(readFileSync(inventoryPath, "utf8")).toBe(
          "previous inventory\n",
        );
        expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
        expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe(
          "keep\n",
        );
      });
    },
  );
});
