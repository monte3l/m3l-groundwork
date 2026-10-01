// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Regression coverage for issue #100: `copyCustomizeSkillFiles` (reached via
 * `installCustomizeSkill`/`installCustomizeSkillGuarded` in `../src/plugin.js`)
 * must lstat-guard every directory component it writes through and must
 * replace -- never follow -- a symlinked payload-file destination. Mirrors
 * the symlink-refusal pattern in `baseline-stage.test.ts`'s "symlink guard"
 * describe and the remove-then-`wx` pattern in `inventory.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "../src/plugin.js";
import { main } from "../src/main.js";

/** Builds the same five-file payload fixture `plugin.test.ts` uses. */
function writeSourceFixture(sourceDir: string): void {
  mkdirSync(join(sourceDir, "skills", "customize"), { recursive: true });
  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(
    join(sourceDir, "skills", "customize", "SKILL.md"),
    "---\nname: customize\n---\n# customize\n",
  );
  writeFileSync(
    join(sourceDir, "src", "kind-facet-map.ts"),
    "export const x = 1;\n",
  );
  writeFileSync(
    join(sourceDir, "src", "domain-map.ts"),
    "export const y = 2;\n",
  );
  writeFileSync(join(sourceDir, "src", "pack-map.ts"), "export const z = 3;\n");
  writeFileSync(
    join(sourceDir, "src", "plugin-map.ts"),
    "export const w = 4;\n",
  );
}

/** A pre-existing, differing `.claude/skills/customize/SKILL.md` -- forces `installCustomizeSkillGuarded` into its "groundwork" branch. */
function writeDifferingClaudeSkill(targetDir: string): void {
  mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
    recursive: true,
  });
  writeFileSync(
    join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
    "---\nname: customize\n---\n# a project-authored version\n",
  );
}

/** Asserts `thrown` is an `Error` naming a symlink refusal at exactly `offendingPath`. */
function expectSymlinkRefusal(thrown: unknown, offendingPath: string): void {
  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain("refusing to write through a symlink");
  expect(message).toContain(offendingPath);
}

describe("copyCustomizeSkillFiles directory-component symlink guard", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-outside-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  const claudePathComponents: [string, string[]][] = [
    [".claude", [".claude"]],
    [".claude/skills", [".claude", "skills"]],
    [".claude/skills/customize", [".claude", "skills", "customize"]],
  ];

  /** Replaces the final segment of `targetDir/<segments>` with a symlink to `outsideDir`, after creating any real ancestor segments. */
  function plantSymlinkAt(segments: string[]): string {
    const ancestors = segments.slice(0, -1);
    if (ancestors.length > 0) {
      mkdirSync(join(targetDir, ...ancestors), { recursive: true });
    }
    const symlinkPath = join(targetDir, ...segments);
    symlinkSync(outsideDir, symlinkPath, "dir");
    return symlinkPath;
  }

  test.each(claudePathComponents)(
    "installCustomizeSkill (fresh mode) refuses when %s is a symlink, writing nothing outside and leaving the symlink in place",
    (_label, segments) => {
      const symlinkPath = plantSymlinkAt(segments);

      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expectSymlinkRefusal(thrown, symlinkPath);
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    },
  );

  // [item 6] assertNotSymlink's own message already ends in its own
  // remediation clause ("... -- remove it and re-run the CLI"); installError
  // (the wrapper every plugin.ts failure is normalized into) appends a
  // SECOND, near-identical clause ("-- fix the cause and re-run the CLI") to
  // every wrapped cause's message unconditionally. Chained together, a
  // symlink refusal's wrapped message ends up saying "re-run the CLI" twice
  // in a row -- the final message must carry that remediation phrasing only
  // once.
  it("[no doubled remediation] a wrapped symlink refusal's message says 're-run the CLI' exactly once, not twice", () => {
    const symlinkPath = plantSymlinkAt([".claude"]);

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(symlinkPath);
    const occurrences = message.split("re-run the CLI").length - 1;
    expect(occurrences).toBe(1);
  });

  // [round-two review, item D] installCustomizeSkillGuarded no longer
  // throws when a .claude path COMPONENT (not a payload file) is a
  // symlink -- it falls back to .groundwork/customize/ instead, since a
  // symlinked .claude/skills/customize is exactly the kind of project
  // state the guarded installer must route around rather than refuse
  // outright (installCustomizeSkill, the fresh-mode entry point, keeps the
  // old throwing behaviour -- see the test.each above).
  test.each(claudePathComponents)(
    "installCustomizeSkillGuarded falls back to .groundwork/customize/ (no throw) when %s is a symlink, leaving the symlink and its target untouched",
    (_label, segments) => {
      const symlinkPath = plantSymlinkAt(segments);

      const result = installCustomizeSkillGuarded(targetDir, sourceDir);

      expect(result.location).toBe("groundwork");
      expect(typeof result.fallbackReason).toBe("string");
      expect(result.fallbackReason as string).toContain(symlinkPath);
      expect(result.filesWritten).toHaveLength(5);

      // The symlink itself, and whatever it points at, are untouched.
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readdirSync(outsideDir)).toEqual([]);

      // The skill was installed into .groundwork/customize/ instead.
      const groundworkDir = join(targetDir, ".groundwork", "customize");
      expect(readFileSync(join(groundworkDir, "SKILL.md"), "utf8")).toContain(
        "name: customize",
      );
    },
  );

  const groundworkPathComponents: [string, string[]][] = [
    [".groundwork", [".groundwork"]],
    [".groundwork/customize", [".groundwork", "customize"]],
  ];

  test.each(groundworkPathComponents)(
    "installCustomizeSkillGuarded (differs branch -> .groundwork destination) refuses when %s is a symlink",
    (_label, segments) => {
      // Force the "differs" branch first, so the destination is really
      // .groundwork/customize/ -- then plant the symlink inside it.
      writeDifferingClaudeSkill(targetDir);
      const symlinkPath = plantSymlinkAt(segments);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expectSymlinkRefusal(thrown, symlinkPath);
      expect(readdirSync(outsideDir)).toEqual([]);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      // The project's own (differing) skill under .claude/ is untouched too.
      expect(
        readFileSync(
          join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
          "utf8",
        ),
      ).toContain("a project-authored version");
    },
  );
});

describe("copyCustomizeSkillFiles payload-file symlink guard (remove-then-wx)", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-payload-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-payload-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-payload-outside-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("replaces a symlinked SKILL.md destination (installCustomizeSkill, fresh mode / .claude destination) instead of writing through it; the outside file is untouched", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    const outsideFile = join(outsideDir, "sentinel-skill.md");
    writeFileSync(outsideFile, "SENTINEL - do not touch\n");
    const destPath = join(
      targetDir,
      ".claude",
      "skills",
      "customize",
      "SKILL.md",
    );
    symlinkSync(outsideFile, destPath);

    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(outsideFile, "utf8")).toBe("SENTINEL - do not touch\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(destPath, "utf8")).toContain("name: customize");
  });

  // [round-two review, item B] Presence is now detected by lstat under ANY
  // payload name, not existsSync(SKILL.md) alone: a symlinked pack-map.ts
  // with no SKILL.md present is no longer the "absent" branch, so this
  // must now divert to .groundwork/customize/ and leave the project's
  // symlink untouched rather than replace it in place (this supersedes the
  // old "absent branch -> .claude destination" expectation below).
  it("diverts to .groundwork/customize/ (item B) when a payload file is a symlink and no SKILL.md is present, leaving the symlink and its target untouched", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    const outsideFile = join(outsideDir, "sentinel-pack-map.ts");
    writeFileSync(outsideFile, "// SENTINEL2\n");
    const destPath = join(
      targetDir,
      ".claude",
      "skills",
      "customize",
      "pack-map.ts",
    );
    symlinkSync(outsideFile, destPath);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(readFileSync(outsideFile, "utf8")).toBe("// SENTINEL2\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(true);
    expect(
      existsSync(join(targetDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
  });

  it("replaces a symlinked payload file (installCustomizeSkillGuarded, differs branch -> .groundwork destination) instead of writing through it", () => {
    writeDifferingClaudeSkill(targetDir);
    mkdirSync(join(targetDir, ".groundwork", "customize"), {
      recursive: true,
    });
    const outsideFile = join(outsideDir, "sentinel-domain-map.ts");
    writeFileSync(outsideFile, "// SENTINEL3\n");
    const destPath = join(
      targetDir,
      ".groundwork",
      "customize",
      "domain-map.ts",
    );
    symlinkSync(outsideFile, destPath);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(5);
    expect(readFileSync(outsideFile, "utf8")).toBe("// SENTINEL3\n");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(destPath, "utf8")).toBe("export const y = 2;\n");
  });
});

describe("copyCustomizeSkillFiles wraps a remove-then-wx write failure", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-write-fail-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-write-fail-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  // [round-two review, item A] the test that used to live here planted a
  // non-empty directory at SKILL.md to force its own pre-write `rmSync` to
  // throw `ERR_FS_EISDIR` after the other four payload files had already
  // been written. `assertNoDirectoryAtPayloadNames` (`../src/plugin.js`) now
  // refuses that same directory up front, before anything is removed or
  // written -- so the injection never reaches a mid-loop write failure at
  // all (see `plugin-preflight.test.ts`). The same "wraps a remove-then-wx
  // write failure" invariant, injected instead via the fs-mock seam, now
  // lives in `plugin-rollback.test.ts`'s "copyCustomizeSkillFiles wraps a
  // remove-then-wx write failure, moved from plugin-symlink.test.ts" test.

  // By design (see plugin.ts's `classifyExistingSkill`/"present" check),
  // any lstat-visible entry under a payload name now diverts this call into
  // the "differs"/.groundwork branch rather than the "absent" branch --
  // planting a non-empty directory AT a payload name (pack-map.ts, as the
  // old version of this test did) no longer reaches the absent branch's
  // .claude write at all. To reach the absent branch's own write failure
  // instead, leave `.claude/skills/customize/` genuinely empty (so the
  // "present" probe sees nothing and falls through to
  // `installCustomizeSkill`) and deny write permission on that directory
  // itself, so the first payload write fails with EACCES.
  it("installCustomizeSkillGuarded (absent branch -> .claude destination) wraps the fs error the same way", () => {
    // A root process ignores directory write-permission bits entirely, and
    // Windows has no POSIX chmod semantics -- neither can produce the EACCES
    // this test relies on, so skip rather than assert a false positive.
    if (process.getuid?.() === 0 || process.platform === "win32") {
      return;
    }

    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    // No payload-named entry exists yet: the "present" probe sees nothing,
    // so installCustomizeSkillGuarded falls through to the absent branch
    // (installCustomizeSkill -> .claude destination).
    expect(readdirSync(destDir)).toEqual([]);

    // r-xr-xr-x: readable/listable, but no write permission, so creating a
    // new directory entry (the first payload write) fails with EACCES.
    chmodSync(destDir, 0o555);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    } finally {
      // Restore write permission so afterEach's recursive rmSync can clean
      // up targetDir.
      chmodSync(destDir, 0o755);
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    // The very first payload write (kind-facet-map.ts) is what fails, so no
    // payload file -- including the four written before it in every other
    // scenario -- was ever created.
    expect(readdirSync(destDir)).toEqual([]);
  });
});

/**
 * Item 8(a)/(b): a stale entry already sitting at the CLI-owned
 * `.groundwork/customize/` destination (reached via `installCustomizeSkillGuarded`'s
 * "differs" fallback, where the `"cli-owned"` write policy's
 * `removeStaleSkillEntry` applies) is sometimes itself
 * a symlink to somewhere outside the project -- a prior run's own output
 * tampered with, or simply a stale fallback from before this guard existed.
 * Replacing it must UNLINK that symlink, never follow it and write through
 * to whatever it points at. And when removing that stale entry fails
 * outright (no permission), the whole install must fail BEFORE any data
 * file is rewritten -- the existing (stale but intact) install is left
 * exactly as it was rather than partially clobbered.
 */
describe("a stale .groundwork/customize/ entry that is itself a symlink (item 8)", () => {
  let sourceDir: string;
  let targetDir: string;
  let outsideDir: string;
  let destDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-stale-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-stale-target-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-stale-outside-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    destDir = join(targetDir, ".groundwork", "customize");
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("[8a] unlinks a symlinked stale SKILL.md rather than following it, leaving its outside target untouched", () => {
    const outsideFile = join(outsideDir, "sentinel-stale-skill.md");
    writeFileSync(outsideFile, "SENTINEL - stale, do not touch\n");
    const staleSkillMd = join(destDir, "SKILL.md");
    symlinkSync(outsideFile, staleSkillMd);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    // The symlink was unlinked (replaced by a real file), never followed.
    expect(lstatSync(staleSkillMd).isSymbolicLink()).toBe(false);
    expect(readFileSync(staleSkillMd, "utf8")).toContain("name: customize");
    // The outside target is completely untouched.
    expect(readFileSync(outsideFile, "utf8")).toBe(
      "SENTINEL - stale, do not touch\n",
    );
  });

  it("[8a] unlinks a symlinked stale data file (domain-map.ts) the same way, leaving its outside target untouched", () => {
    const outsideFile = join(outsideDir, "sentinel-stale-domain-map.ts");
    writeFileSync(outsideFile, "// SENTINEL, stale\n");
    const staleDataFile = join(destDir, "domain-map.ts");
    symlinkSync(outsideFile, staleDataFile);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(lstatSync(staleDataFile).isSymbolicLink()).toBe(false);
    expect(readFileSync(staleDataFile, "utf8")).toBe("export const y = 2;\n");
    expect(readFileSync(outsideFile, "utf8")).toBe("// SENTINEL, stale\n");
  });

  it("[8b] throws 'could not remove the stale ...' before any data write when removing the stale SKILL.md fails, leaving the old install intact", () => {
    // A root process ignores directory write-permission bits entirely, and
    // Windows has no POSIX chmod semantics -- neither can produce the
    // permission failure this test relies on.
    if (process.getuid?.() === 0 || process.platform === "win32") {
      return;
    }

    writeFileSync(join(destDir, "SKILL.md"), "OLD SKILL\n");
    writeFileSync(join(destDir, "kind-facet-map.ts"), "OLD kind-facet\n");
    writeFileSync(join(destDir, "domain-map.ts"), "OLD domain\n");
    writeFileSync(join(destDir, "pack-map.ts"), "OLD pack\n");
    writeFileSync(join(destDir, "plugin-map.ts"), "OLD plugin\n");

    // r-xr-xr-x: readable/listable, but no write permission, so unlinking
    // any entry inside destDir (including the stale SKILL.md) fails EACCES.
    chmodSync(destDir, 0o555);

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(destDir, 0o755);
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("could not remove the stale");

    // Every old file is completely untouched -- the failure happened before
    // any data write was attempted.
    expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toBe("OLD SKILL\n");
    expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
      "OLD kind-facet\n",
    );
    expect(readFileSync(join(destDir, "domain-map.ts"), "utf8")).toBe(
      "OLD domain\n",
    );
    expect(readFileSync(join(destDir, "pack-map.ts"), "utf8")).toBe(
      "OLD pack\n",
    );
    expect(readFileSync(join(destDir, "plugin-map.ts"), "utf8")).toBe(
      "OLD plugin\n",
    );
  });
});

describe("plain run (no symlinks) is unchanged by the guard", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "plugin-symlink-plain-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-symlink-plain-target-"));
    writeSourceFixture(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("writes the same filesWritten names and byte-identical content, and a second, byte-identical run over its own output is a no-op", () => {
    const expectedNames = [
      join(".claude", "skills", "customize", "SKILL.md"),
      join(".claude", "skills", "customize", "kind-facet-map.ts"),
      join(".claude", "skills", "customize", "domain-map.ts"),
      join(".claude", "skills", "customize", "pack-map.ts"),
      join(".claude", "skills", "customize", "plugin-map.ts"),
    ].sort();

    const result1 = installCustomizeSkill(targetDir, sourceDir);
    expect([...result1.filesWritten].sort()).toEqual(expectedNames);

    const destDir = join(targetDir, ".claude", "skills", "customize");
    expect(readFileSync(join(destDir, "kind-facet-map.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(destDir, "domain-map.ts"), "utf8")).toBe(
      "export const y = 2;\n",
    );

    // Re-running over its own, still byte-identical output is a no-op per
    // the overwrite policy's classify-first contract: nothing is removed or
    // rewritten, and filesWritten is empty.
    const result2 = installCustomizeSkill(targetDir, sourceDir);
    expect(result2.filesWritten).toEqual([]);
    expect(readFileSync(join(destDir, "plugin-map.ts"), "utf8")).toBe(
      "export const w = 4;\n",
    );
  });
});

describe("adopt mode (main()) and a symlinked .claude", () => {
  let workDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "plugin-symlink-adopt-work-"));
    outsideDir = mkdtempSync(join(tmpdir(), "plugin-symlink-adopt-outside-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // [round-two review, item D] a symlinked .claude no longer aborts the
  // whole adopt run: installCustomizeSkillGuarded falls back to
  // .groundwork/customize/ instead, so main() completes and explains why in
  // its console output.
  it("falls back to .groundwork/customize/ when .claude is a symlink, completing the run and explaining why in its console output", () => {
    const projectDir = join(workDir, "project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const claudeSymlink = join(projectDir, ".claude");
    symlinkSync(outsideDir, claudeSymlink, "dir");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let thrown: unknown;
    let output: string;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    } finally {
      // Read the calls BEFORE mockRestore(): mockRestore() also resets the
      // mock's call history (the same way mockReset() does), so reading
      // logSpy.mock.calls after it always sees an empty array.
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      logSpy.mockRestore();
    }

    expect(thrown).toBeUndefined();
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(lstatSync(claudeSymlink).isSymbolicLink()).toBe(true);
    expect(
      existsSync(join(projectDir, ".groundwork", "customize", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(projectDir, ".groundwork", "inventory.json"))).toBe(
      true,
    );

    expect(output).toContain(claudeSymlink);
  });
});
