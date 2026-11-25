// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `--add-pack` acceptance test: runs the real built CLI against a
 * bootstrapped and an adopted project and asserts the one guarantee that
 * matters -- staging a pack writes only under `.groundwork/add-pack/<name>/`
 * and every other byte of the project stays identical. No mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
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

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "m3l-groundwork.mjs");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  const result = spawnSync("node", [binPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** relative path -> sha256 of every file under `root`. */
function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      snapshot.set(
        relative(root, absPath),
        createHash("sha256").update(readFileSync(absPath)).digest("hex"),
      );
    }
  };
  visit(root);
  return snapshot;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every path in `before` is unchanged in `after`; returns the new paths. */
function expectOnlyAdditions(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  for (const [relPath, hash] of before) {
    expect(after.get(relPath), relPath).toBe(hash);
  }
  return [...after.keys()].filter((relPath) => !before.has(relPath));
}

function buildEstablishedProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "existing-project",
        version: "1.0.0",
        scripts: { test: "jest" },
        devDependencies: { typescript: "^5.2.0", jest: "^29.7.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# existing-project\n");
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "agents", "foo.md"),
    "---\nmodel: opus\n---\n# foo\n",
  );
}

function pathsUnder(tree: Iterable<string>, prefix: string): string[] {
  return [...tree].filter((p) => p.startsWith(prefix));
}

interface Plan {
  schemaVersion: number;
  origin: { kind: string };
  requiredMode: string;
  reinstall: boolean;
  installation: { status: string };
  staged: {
    name: string;
    dir: string;
    manifest: { staged: string; sha256: string };
    files: { path: string; staged: string; sha256: string }[];
  };
  fileConflicts: { status: string }[];
}

function readPlan(projectDir: string, name: string): Plan {
  return JSON.parse(
    readFileSync(
      join(projectDir, ".groundwork", "add-pack", name, "plan.json"),
      "utf8",
    ),
  ) as Plan;
}

describe("--add-pack end-to-end", () => {
  let root: string;
  let bootstrappedBase: string;
  let bootstrappedWithQuality: string;
  let adoptedBase: string;
  let counter = 0;

  /** A private copy of a base fixture, removed with `root` in afterAll. */
  function copyOf(base: string): string {
    const dir = join(root, `case-${String(counter++)}`);
    cpSync(base, dir, { recursive: true });
    return dir;
  }

  function emptyDir(): string {
    const dir = join(root, `case-${String(counter++)}`);
    mkdirSync(dir);
    return dir;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "m3l-groundwork-add-pack-e2e-"));

    bootstrappedBase = join(root, "bootstrapped");
    expect(
      run([
        bootstrappedBase,
        "--name",
        "boot-proj",
        "--pack",
        "harness-extras",
        "--skip-install",
      ]).status,
    ).toBe(0);

    bootstrappedWithQuality = join(root, "bootstrapped-quality");
    expect(
      run([
        bootstrappedWithQuality,
        "--name",
        "boot-quality",
        "--pack",
        "quality",
        "--skip-install",
      ]).status,
    ).toBe(0);

    adoptedBase = join(root, "adopted");
    mkdirSync(adoptedBase);
    buildEstablishedProject(adoptedBase);
    expect(run([adoptedBase, "--name", "existing-project"]).status).toBe(0);
    // State later slices own: planted so "byte-identical" has teeth.
    writeFileSync(
      join(adoptedBase, ".groundwork", "adoption-decisions.json"),
      '{"schemaVersion":1,"decisions":[]}\n',
    );
    writeFileSync(
      join(adoptedBase, ".groundwork", "customization-report.md"),
      "# Customization report\n",
    );
    writeFileSync(
      join(adoptedBase, ".groundwork", "installed-packs.json"),
      '{"schemaVersion":1,"packs":[{"name":"harness-extras"}]}\n',
    );
  }, 300_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("a bootstrapped project", () => {
    it("stages the pack under .groundwork/add-pack/<name>/ and leaves every other file byte-identical", () => {
      const dir = copyOf(bootstrappedBase);
      const before = snapshotTree(dir);
      // The files the contract names, so the guard cannot pass vacuously.
      expect(
        before.has(join(".claude", "skills", "customize", "SKILL.md")),
      ).toBe(true);
      expect(before.has(join(".claude", "settings.json"))).toBe(true);
      expect(before.has(join("bin", "lib", "verify-steps.packs.json"))).toBe(
        true,
      );

      const result = run([dir, "--add-pack", "quality"]);
      expect(result.status, result.stderr).toBe(0);

      const added = expectOnlyAdditions(before, snapshotTree(dir));
      expect(added.length).toBeGreaterThan(0);
      for (const relPath of added) {
        expect(
          relPath.startsWith(join(".groundwork", "add-pack", "quality") + "/"),
          relPath,
        ).toBe(true);
      }

      const plan = readPlan(dir, "quality");
      expect(plan.schemaVersion).toBe(1);
      expect(plan.origin.kind).toBe("bootstrapped");
      expect(plan.requiredMode).toBe("fresh");
      expect(plan.reinstall).toBe(false);
      expect(plan.staged.name).toBe("quality");
      expect(plan.staged.dir).toBe(".groundwork/add-pack/quality");

      const packDir = join(dir, ".groundwork", "add-pack", "quality");
      expect(existsSync(join(packDir, plan.staged.manifest.staged))).toBe(true);
      expect(existsSync(join(packDir, "pack.json"))).toBe(false);
      expect(plan.staged.manifest.sha256).toBe(
        sha256Of(join(packDir, plan.staged.manifest.staged)),
      );
      expect(plan.staged.files.length).toBeGreaterThan(0);
      for (const file of plan.staged.files) {
        expect(file.staged.endsWith(".staged"), file.staged).toBe(true);
        const stagedAbs = join(packDir, "files", file.staged);
        expect(existsSync(stagedAbs), file.staged).toBe(true);
        expect(file.sha256, file.path).toBe(sha256Of(stagedAbs));
      }
    });

    it("prints a staged line whose counts match the plan, the project caps, and a next: line", () => {
      const dir = copyOf(bootstrappedBase);

      const result = run([dir, "--add-pack", "quality"]);
      expect(result.status, result.stderr).toBe(0);

      const plan = readPlan(dir, "quality");
      const divergent = plan.fileConflicts.filter(
        (c) => c.status === "divergent",
      ).length;
      expect(result.stdout).toContain(
        `add-pack quality: staged .groundwork/add-pack/quality/ (not installed; ${String(plan.staged.files.length)} file(s), ${String(divergent)} conflict(s))`,
      );
      expect(result.stdout).toMatch(/^project:/m);
      expect(result.stdout).toMatch(
        /^next: run \/customize add-pack quality$/m,
      );
    });

    it("stages several packs named in one run, in one directory each", () => {
      const dir = copyOf(bootstrappedBase);
      const before = snapshotTree(dir);

      const result = run([
        dir,
        "--add-pack",
        "quality",
        "--add-pack",
        "github",
      ]);
      expect(result.status, result.stderr).toBe(0);

      const added = expectOnlyAdditions(before, snapshotTree(dir));
      for (const relPath of added) {
        expect(
          relPath.startsWith(".groundwork/add-pack/quality/") ||
            relPath.startsWith(".groundwork/add-pack/github/"),
          relPath,
        ).toBe(true);
      }
      expect(readPlan(dir, "quality").staged.name).toBe("quality");
      expect(readPlan(dir, "github").staged.name).toBe("github");
      expect(result.stdout).toMatch(/^add-pack github: staged /m);
      expect(result.stdout).toMatch(/^add-pack quality: staged /m);
      expect(result.stdout).toMatch(
        /^next: run \/customize add-pack github quality$/m,
      );
    });

    it("staging a second pack leaves the first pack's directory byte-identical", () => {
      const dir = copyOf(bootstrappedBase);
      expect(run([dir, "--add-pack", "quality"]).status).toBe(0);
      const before = snapshotTree(dir);

      const result = run([dir, "--add-pack", "github"]);
      expect(result.status, result.stderr).toBe(0);

      const added = expectOnlyAdditions(before, snapshotTree(dir));
      expect(added.length).toBeGreaterThan(0);
      for (const relPath of added) {
        expect(
          relPath.startsWith(".groundwork/add-pack/github/"),
          relPath,
        ).toBe(true);
      }
    });

    it("restaging a pack replaces only that pack's directory", () => {
      const dir = copyOf(bootstrappedBase);
      expect(
        run([dir, "--add-pack", "quality", "--add-pack", "github"]).status,
      ).toBe(0);
      // A stray file in quality's dir proves it was replaced, not merged into.
      const stray = join(
        dir,
        ".groundwork",
        "add-pack",
        "quality",
        "stray.txt",
      );
      writeFileSync(stray, "left over\n");
      const before = snapshotTree(dir);

      const result = run([dir, "--add-pack", "quality"]);
      expect(result.status, result.stderr).toBe(0);

      const after = snapshotTree(dir);
      expect(existsSync(stray)).toBe(false);
      const quality = ".groundwork/add-pack/quality/";
      for (const [relPath, hash] of before) {
        if (relPath.startsWith(quality)) continue;
        expect(after.get(relPath), relPath).toBe(hash);
      }
      // Quality's own staged files are all still there.
      const staged = readPlan(dir, "quality").staged.files;
      expect(
        pathsUnder(after.keys(), quality).length,
        "quality files",
      ).toBeGreaterThan(staged.length);
      expect(
        existsSync(join(dir, ".groundwork", "add-pack", "github", "plan.json")),
      ).toBe(true);
    });

    it("succeeds for a pack the project installed when --reinstall is given, and refuses without it", () => {
      const refusedDir = copyOf(bootstrappedWithQuality);
      const before = snapshotTree(refusedDir);

      const refused = run([refusedDir, "--add-pack", "quality"]);
      expect(refused.status).toBe(2);
      expect(refused.stderr).not.toContain("unrecognized option");
      expect(refused.stderr).toContain("quality");
      expect(refused.stderr).toContain("--reinstall");
      expect(snapshotTree(refusedDir)).toEqual(before);

      const dir = copyOf(bootstrappedWithQuality);
      const beforeReinstall = snapshotTree(dir);
      const result = run([dir, "--add-pack", "quality", "--reinstall"]);
      expect(result.status, result.stderr).toBe(0);
      const added = expectOnlyAdditions(beforeReinstall, snapshotTree(dir));
      expect(added.length).toBeGreaterThan(0);
      const plan = readPlan(dir, "quality");
      expect(plan.reinstall).toBe(true);
      expect(plan.installation.status).toBe("installed");
    });

    it("lists the installed pack as [installed] with --list-packs <dir> and writes nothing", () => {
      const dir = copyOf(bootstrappedWithQuality);
      const before = snapshotTree(dir);

      const result = run(["--list-packs", dir]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^quality \(modes: .*\) \[installed\]/m);
      expect(result.stdout).toMatch(/^github \(modes: .*\) \[not installed\]/m);
      expect(snapshotTree(dir)).toEqual(before);
    });
  });

  describe("an adopted project", () => {
    it("stages the pack and leaves every other file, including all adopt state and decisions, byte-identical", () => {
      const dir = copyOf(adoptedBase);
      const before = snapshotTree(dir);
      for (const planted of [
        "inventory.json",
        "adoption-decisions.json",
        "customization-report.md",
        "installed-packs.json",
      ]) {
        expect(before.has(join(".groundwork", planted)), planted).toBe(true);
      }
      expect(
        pathsUnder(before.keys(), ".groundwork/packs/").length,
      ).toBeGreaterThan(0);
      expect(
        pathsUnder(before.keys(), ".groundwork/baseline/").length,
      ).toBeGreaterThan(0);

      const result = run([dir, "--add-pack", "github"]);
      expect(result.status, result.stderr).toBe(0);

      const added = expectOnlyAdditions(before, snapshotTree(dir));
      expect(added.length).toBeGreaterThan(0);
      for (const relPath of added) {
        expect(
          relPath.startsWith(".groundwork/add-pack/github/"),
          relPath,
        ).toBe(true);
      }
      const plan = readPlan(dir, "github");
      expect(plan.origin.kind).toBe("adopted");
      expect(plan.requiredMode).toBe("adopt");
      expect(result.stdout).toMatch(/^add-pack github: staged /m);
      expect(result.stdout).toMatch(/^next: .*\/customize add-pack github$/m);
    });

    it("refuses a fresh-only pack (publishing) and leaves the tree byte-identical", () => {
      const dir = copyOf(adoptedBase);
      const before = snapshotTree(dir);

      const result = run([dir, "--add-pack", "publishing"]);

      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("unrecognized option");
      expect(result.stderr).toContain("publishing");
      expect(snapshotTree(dir)).toEqual(before);
    });
  });

  describe("refusals exit 2 and leave the tree byte-identical", () => {
    const needsEstablished = (dir: string): void => {
      buildEstablishedProject(dir);
    };
    const interruptedAdopt = (dir: string): void => {
      buildEstablishedProject(dir);
      mkdirSync(join(dir, ".groundwork", "packs", "github"), {
        recursive: true,
      });
      writeFileSync(
        join(dir, ".groundwork", "packs", "github", "pack.json.staged"),
        "{}\n",
      );
    };
    const missingRequiredPath = (dir: string): void => {
      cpSync(bootstrappedBase, dir, { recursive: true });
      rmSync(join(dir, "bin", "lib", "report.mjs"));
    };
    const bootstrapped = (dir: string): void => {
      cpSync(bootstrappedBase, dir, { recursive: true });
    };

    it.each<[string, (dir: string) => void, string[], string]>([
      [
        "an empty directory",
        () => undefined,
        ["--add-pack", "quality"],
        "bootstrap",
      ],
      [
        "a plain project that is neither adopted nor bootstrapped",
        needsEstablished,
        ["--add-pack", "quality"],
        "m3l-groundwork",
      ],
      [
        "an interrupted adopt (.groundwork/packs without an inventory)",
        interruptedAdopt,
        ["--add-pack", "github"],
        "adopt",
      ],
      [
        "an unknown pack name",
        bootstrapped,
        ["--add-pack", "no-such-pack"],
        "no-such-pack",
      ],
      [
        "a pack whose required path is missing from a bootstrapped project",
        missingRequiredPath,
        ["--add-pack", "quality"],
        "report.mjs",
      ],
      [
        "--add-pack with --pack",
        bootstrapped,
        ["--add-pack", "quality", "--pack", "github"],
        "--pack",
      ],
      [
        "--add-pack with --adopt",
        bootstrapped,
        ["--add-pack", "quality", "--adopt"],
        "--adopt",
      ],
      [
        "--add-pack with --fresh",
        bootstrapped,
        ["--add-pack", "quality", "--fresh"],
        "--fresh",
      ],
      [
        "--add-pack with --force",
        bootstrapped,
        ["--add-pack", "quality", "--force"],
        "--force",
      ],
      [
        "--add-pack with --skip-install",
        bootstrapped,
        ["--add-pack", "quality", "--skip-install"],
        "--skip-install",
      ],
      [
        "--reinstall without --add-pack",
        bootstrapped,
        ["--reinstall"],
        "--reinstall",
      ],
    ])("%s", (_label, setup, flags, expectedInMessage) => {
      const dir = emptyDir();
      setup(dir);
      const before = snapshotTree(dir);

      const result = run([dir, ...flags]);

      expect(result.status, result.stdout).toBe(2);
      // A CLI that does not know --add-pack also exits 2: rule that out.
      expect(result.stderr).not.toContain("unrecognized option");
      expect(result.stderr).toContain(expectedInMessage);
      expect(snapshotTree(dir)).toEqual(before);
    });

    it("a missing directory: exits 2, names the path and does not create it", () => {
      const dir = join(root, "does-not-exist");

      const result = run([dir, "--add-pack", "quality"]);

      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("unrecognized option");
      expect(result.stderr).toContain(dir);
      expect(existsSync(dir)).toBe(false);
    });
  });
});
