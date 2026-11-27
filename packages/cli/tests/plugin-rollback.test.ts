// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Coverage for `../src/plugin.js` branches a real filesystem alone cannot
 * reach: the pre-flight probes, the classification of what is already
 * installed, and the entry-point error wrapping, each through a mock of
 * `node:fs` that delegates to the real implementation except for the one
 * path/call a test targets (the same `vi.hoisted` partial-mock pattern
 * `git.test.ts` uses for `node:child_process`).
 *
 * The swap itself -- never missing, never truncated, rollback, a killed
 * run, a second run -- is covered in `plugin-atomic.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import { CUSTOMIZE_SKILL_FILE_NAMES } from "../src/customize-paths.js";

// vi.mock(...) is hoisted above every other statement in this file,
// including a plain top-level `let` -- so the real implementations this
// file's "passthrough" default needs are captured into a vi.hoisted() ref
// object instead, mutated once from inside the mock factory below.
const { rmSyncMock, writeFileSyncMock, lstatSyncMock, readFileSyncMock, real } =
  vi.hoisted(() => ({
    rmSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    lstatSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    real: {} as {
      rmSync: typeof NodeFs.rmSync;
      writeFileSync: typeof NodeFs.writeFileSync;
      lstatSync: typeof NodeFs.lstatSync;
      readFileSync: typeof NodeFs.readFileSync;
    },
  }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  real.rmSync = actual.rmSync;
  real.writeFileSync = actual.writeFileSync;
  real.lstatSync = actual.lstatSync;
  real.readFileSync = actual.readFileSync;
  return {
    ...actual,
    rmSync: rmSyncMock,
    writeFileSync: writeFileSyncMock,
    lstatSync: lstatSyncMock,
    readFileSync: readFileSyncMock,
  };
});

const { installCustomizeSkill, installCustomizeSkillGuarded } =
  await import("../src/plugin.js");

// File-level default for lstatSyncMock/readFileSyncMock: every test in this
// file delegates to the real implementation unless it layers its own
// mockImplementation on top for one specific path -- the same
// passthrough-by-default pattern each describe below already uses for
// rmSyncMock/writeFileSyncMock. Registered at file scope (not inside any one
// describe's own beforeEach) so it runs for every test regardless of which
// describe it lives in.
beforeEach(() => {
  lstatSyncMock.mockImplementation(
    (...args: Parameters<typeof NodeFs.lstatSync>) => real.lstatSync(...args),
  );
  readFileSyncMock.mockImplementation(
    (...args: Parameters<typeof NodeFs.readFileSync>) =>
      real.readFileSync(...args),
  );
});

afterEach(() => {
  lstatSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

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

/** Builds the same five-file payload fixture `plugin-symlink.test.ts` uses. */
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
  for (const stepName of [
    "step-0-reconcile.md",
    "step-3-round-1.md",
    "pack-install.md",
    "add-pack.md",
    "update.md",
  ]) {
    writeFileSync(
      join(sourceDir, "skills", "customize", stepName),
      `# ${stepName}\n`,
    );
  }
}

describe("a missing source payload file is wrapped the same way as every other failure (item 6)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("wraps the missing-source error as 'could not install the /customize skill ...'", () => {
    const sourceDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-missing-src-"),
    );
    const targetDir = mkdtempSync(
      join(tmpdir(), "plugin-rollback-missing-tgt-"),
    );
    writeSourceFixture(sourceDir);
    // Remove one source payload file after the fixture was written.
    real.rmSync(join(sourceDir, "src", "pack-map.ts"), { force: true });

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain("is missing");
    expect(message).toContain(join(sourceDir, "src", "pack-map.ts"));

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 3: `installCustomizeSkill` (fresh mode's "overwrite" policy) today
 * never classifies what is already at the destination before writing --
 * every re-run unconditionally removes and rewrites every payload file, even
 * when the destination is already byte-for-byte identical to what this run
 * would write (a plain re-run of the CLI over its own output, with no
 * `--force`-driven change at all). The fix this suite is written against:
 * classify first (the same byte-for-byte comparison
 * `installCustomizeSkillGuarded`'s `classifyExistingSkill` already performs
 * for adopt mode), and when every payload file is already current, return
 * without removing or rewriting anything -- mirroring the adopt-mode
 * `"already-present"` result's own `filesWritten: []` convention for "we
 * verified it, we touched nothing".
 *
 * `plugin-symlink.test.ts`'s "plain run (no symlinks) is unchanged by the
 * guard" suite's second-run test was updated alongside this one (renamed to
 * "...is a no-op") to assert `filesWritten: []` on a second, byte-identical
 * run rather than the full five-name list again -- the two suites agree on
 * this contract.
 */
describe("installCustomizeSkill classifies before writing: a byte-identical re-run is a no-op (item 3)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("removes and rewrites nothing on a second install over an already byte-identical .claude/skills/customize/", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-noop-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-noop-tgt-"));
    writeSourceFixture(sourceDir);

    const first = installCustomizeSkill(targetDir, sourceDir);
    expect(first.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);

    const destDir = join(targetDir, ".claude", "skills", "customize");
    const skillMdPath = join(destDir, "SKILL.md");
    const mtimeBefore = statSync(skillMdPath).mtimeMs;

    rmSyncMock.mockClear();
    writeFileSyncMock.mockClear();

    const second = installCustomizeSkill(targetDir, sourceDir);

    expect(second.filesWritten).toEqual([]);
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(statSync(skillMdPath).mtimeMs).toBe(mtimeBefore);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * Item 4: `assertNoDirectoryAtPayloadNames` (`../src/plugin.js`) today
 * silently swallows ANY `lstat` failure against a payload name (not just a
 * missing entry) and leaves the obstacle "to its own remove/write" -- for a
 * policy that REPLACES existing entries (`"overwrite"`, `"cli-owned"`), that
 * means a transient `lstat` failure (e.g. a permissions race, an `EIO`) is
 * never reported as a pre-flight refusal at all; the run proceeds to
 * remove-then-rewrite past an obstacle it never actually judged. The fix
 * this suite is written against: under a replacing policy, a pre-flight
 * `lstat` failure refuses the whole install up front ("could not inspect
 * <path>; nothing was removed or written", the raw error as `cause`),
 * before anything is removed or written. The purely-additive policy keeps
 * today's behavior unchanged (continues, left to the real write).
 *
 * NOTE for the hub: the exact call-site this fix lands in may also be
 * touched by item 3's classify-first change for the "overwrite" policy --
 * if a future unified classify+preflight pass calls `lstat` more than once
 * per payload name before any write is attempted, the single unconditional
 * failure this test injects would surface during whichever call reaches it
 * first. The assertions below are intentionally about the OUTER contract
 * (the wrapper message's wording, the cause, nothing written) rather than
 * which internal call produced it, so they should hold either way; flagging
 * the coupling here rather than guessing at an implementation it doesn't
 * own.
 */
describe("a pre-flight lstat failure refuses a replacing-policy install, and nothing is touched (item 4)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("[overwrite, fresh mode] refuses the whole install, naming the path and leaving nothing written", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-io-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-io-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const kindFacetDest = join(destDir, "kind-facet-map.ts");

    const probeFailure = new Error(
      "EIO: some I/O error (simulated)",
    ) as NodeJS.ErrnoException;
    probeFailure.code = "EIO";
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          throw probeFailure;
        }
        return real.lstatSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkill(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(`could not inspect ${kindFacetDest}`);
    expect(message).toContain("nothing was removed or written");
    expect((thrown as Error).cause).toBe(probeFailure);

    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[cli-owned, .groundwork fallback] refuses the whole install the same way", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-gw-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-gw-tgt-"));
    writeSourceFixture(sourceDir);
    // Forces installCustomizeSkillGuarded's "differs" -> groundwork branch.
    writeDifferingClaudeSkill(targetDir);
    const destDir = join(targetDir, ".groundwork", "customize");
    const kindFacetDest = join(destDir, "kind-facet-map.ts");

    const probeFailure = new Error(
      "EIO: some I/O error (simulated)",
    ) as NodeJS.ErrnoException;
    probeFailure.code = "EIO";
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          throw probeFailure;
        }
        return real.lstatSync(...args);
      },
    );

    let thrown: unknown;
    try {
      installCustomizeSkillGuarded(targetDir, sourceDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect(message).toContain(`could not inspect ${kindFacetDest}`);
    expect(message).toContain("nothing was removed or written");
    expect((thrown as Error).cause).toBe(probeFailure);

    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    // The project's own differing .claude/ SKILL.md is untouched.
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toContain("a project-authored version");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  // [regression guard] the additive policy must keep today's behavior: a
  // pre-flight lstat failure is left to the real write, not refused. This
  // already passes under today's code (assertNoDirectoryAtPayloadNames
  // swallows every policy's lstat failure); item 4 must not change that for
  // "additive".
  it("[additive, first-time adopt install] still continues past its own lstat failure, leaving the failure to the real write", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-preflight-add-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-preflight-add-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    const domainMapDest = join(destDir, "domain-map.ts");

    // The first lstat call against this path is classifyExistingSkill's own
    // probe (must succeed -- the file genuinely does not exist yet); the
    // second is assertNoDirectoryAtPayloadNames's own probe for the SAME
    // name, since "installable" classification over a brand-new install
    // leaves `alreadyCurrent` empty.
    let calls = 0;
    lstatSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.lstatSync>) => {
        const [target] = args;
        if (String(target) === domainMapDest) {
          calls += 1;
          if (calls >= 2) {
            throw new Error("EIO: preflight probe failure (simulated)");
          }
        }
        return real.lstatSync(...args);
      },
    );

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("claude");
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(domainMapDest, "utf8")).toBe("export const y = 2;\n");
    expect(calls).toBeGreaterThanOrEqual(2);

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * [NIT] `installCustomizeSkill`/`installCustomizeSkillGuarded`'s `sourceDir`
 * parameter defaults to `pluginDir()` (`../src/plugin.js`), which calls
 * `resolveAsset` (`../src/assets.js`). A default parameter value is
 * evaluated as part of entering the function body, BEFORE
 * `withRemediation`'s own `try` runs -- so a `pluginDir()` failure today
 * propagates completely raw: no "could not install the /customize skill: "
 * prefix, no chained `cause`, no remediation at all. Every other failure
 * path in this module gets that treatment; this one is a gap.
 */
describe("[NIT] a pluginDir()/resolveAsset() failure (the sourceDir default) gets the same install-prefix and remediation as every other failure", () => {
  afterEach(() => {
    vi.doUnmock("../src/assets.js");
    vi.resetModules();
  });

  it("wraps a resolveAsset() failure reached through installCustomizeSkill's default sourceDir the same way as any other failure", async () => {
    const assetFailure = new Error(
      "simulated resolveAsset failure: no source checkout or vendored copy found",
    );
    vi.doMock("../src/assets.js", () => ({
      resolveAsset: vi.fn(() => {
        throw assetFailure;
      }),
    }));
    vi.resetModules();
    const { installCustomizeSkill: installCustomizeSkillFreshImport } =
      await import("../src/plugin.js");

    const targetDir = mkdtempSync(join(tmpdir(), "plugin-nit-plugindir-tgt-"));

    let thrown: unknown;
    try {
      // No sourceDir argument: forces the pluginDir() default to run.
      installCustomizeSkillFreshImport(targetDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("could not install the /customize skill");
    expect((thrown as Error).cause).toBe(assetFailure);
    expect(message).toContain("--fresh --force");

    real.rmSync(targetDir, { recursive: true, force: true });
  });
});

/**
 * `classifyExistingSkill` (`../src/plugin.js`, via `regularFileMatches`)
 * reads an existing payload entry with `readFileSync` and today treats ANY
 * read failure, regardless of its errno code, the same way: "unreadable" ->
 * "foreign" (fresh mode then replaces it like any other stale copy; adopt
 * mode falls back to `.groundwork/customize/`). Only `EACCES`/`EPERM` -- a
 * genuine permission denial -- should keep that leave-it-alone-and-route-
 * around treatment (see the regression-pin suite below). Every other code
 * is not something either mode should guess past:
 *
 * - `EMFILE`/`EIO`: the entry is a plain regular file (its `lstat` already
 *   confirmed that), but something about the environment or the file itself
 *   makes it unreadable right now in a way no "stale project copy" story
 *   explains.
 * - `ENOENT`/`ELOOP` raised by the READ itself, after the preceding `lstat`
 *   already confirmed a regular file: a race -- the entry vanished, or
 *   became a symlink loop, in the window between the two calls.
 *
 * The fix this suite is written against: those codes throw the same "could
 * not install the /customize skill: ... could not read <path>" shape every
 * other failure in this module uses, with the raw errno error chained as
 * `cause`, before anything is removed or written -- for BOTH
 * `installCustomizeSkill` (fresh mode) and `installCustomizeSkillGuarded`
 * (adopt mode).
 */
describe("a non-EACCES/EPERM read failure against an existing payload entry throws, rather than being treated as foreign/replaced", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  /** Makes `readFileSync` against exactly `path` throw an errno-coded failure, passing every other path through to the real implementation. */
  function mockReadFailure(path: string, code: string): void {
    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.readFileSync>) => {
        const [target] = args;
        if (String(target) === path) {
          const failure = new Error(
            `${code}: simulated read failure`,
          ) as NodeJS.ErrnoException;
          failure.code = code;
          throw failure;
        }
        return real.readFileSync(...args);
      },
    );
  }

  describe.each([
    ["EMFILE", "too many open files"],
    ["EIO", "a hardware/filesystem fault"],
    ["ENOENT", "the entry vanished after lstat (a race)"],
    ["ELOOP", "the entry became a symlink loop after lstat (a race)"],
  ])("%s (%s)", (code) => {
    it(`[fresh mode] throws naming the path, chains the raw ${code} error, and leaves the destination untouched`, () => {
      const sourceDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-fresh-${code}-src-`),
      );
      const targetDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-fresh-${code}-tgt-`),
      );
      writeSourceFixture(sourceDir);
      const destDir = join(targetDir, ".claude", "skills", "customize");
      mkdirSync(destDir, { recursive: true });
      const domainMapDest = join(destDir, "domain-map.ts");
      // A pre-existing entry, lstat-visible as a regular file; only its
      // READ is made to fail.
      writeFileSync(domainMapDest, "export const y = 2;\n");
      const entriesBefore = readdirSync(destDir).toSorted();
      mockReadFailure(domainMapDest, code);

      let thrown: unknown;
      try {
        installCustomizeSkill(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith("could not install the /customize skill")).toBe(
        true,
      );
      expect(message).toContain(`could not read ${domainMapDest}`);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as NodeJS.ErrnoException).code).toBe(code);

      // Nothing removed or written: the directory holds exactly what it
      // did before the call, and the targeted entry's own bytes (read via
      // the REAL implementation, bypassing the still-active mock override)
      // are unchanged.
      expect(readdirSync(destDir).toSorted()).toEqual(entriesBefore);
      expect(real.readFileSync(domainMapDest, "utf8")).toBe(
        "export const y = 2;\n",
      );

      real.rmSync(sourceDir, { recursive: true, force: true });
      real.rmSync(targetDir, { recursive: true, force: true });
    });

    it(`[adopt mode] throws naming the path, chains the raw ${code} error, and installs nothing to .groundwork/`, () => {
      const sourceDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-adopt-${code}-src-`),
      );
      const targetDir = mkdtempSync(
        join(tmpdir(), `plugin-unreadable-adopt-${code}-tgt-`),
      );
      writeSourceFixture(sourceDir);
      const destDir = join(targetDir, ".claude", "skills", "customize");
      mkdirSync(destDir, { recursive: true });
      const domainMapDest = join(destDir, "domain-map.ts");
      writeFileSync(domainMapDest, "export const y = 2;\n");
      const entriesBefore = readdirSync(destDir).toSorted();
      mockReadFailure(domainMapDest, code);

      let thrown: unknown;
      try {
        installCustomizeSkillGuarded(targetDir, sourceDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith("could not install the /customize skill")).toBe(
        true,
      );
      expect(message).toContain(`could not read ${domainMapDest}`);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as NodeJS.ErrnoException).code).toBe(code);

      expect(readdirSync(destDir).toSorted()).toEqual(entriesBefore);
      expect(real.readFileSync(domainMapDest, "utf8")).toBe(
        "export const y = 2;\n",
      );
      // Adopt mode's today's fallback (.groundwork/customize/, five files)
      // must NOT have been taken: this failure refuses the whole install
      // instead of routing around it.
      expect(existsSync(join(targetDir, ".groundwork"))).toBe(false);

      real.rmSync(sourceDir, { recursive: true, force: true });
      real.rmSync(targetDir, { recursive: true, force: true });
    });
  });
});

/**
 * Regression pin, using the same fs-mock seam as the suite above: `EACCES`
 * and `EPERM` are the one pair of errno codes that must KEEP today's
 * behaviour once the fix above lands -- fresh mode still replaces the
 * unreadable entry like any other stale copy, and adopt mode still falls
 * back to `.groundwork/customize/`, naming the errno code in
 * `fallbackReason`. `EACCES` is already covered end-to-end via real `chmod`
 * in `plugin-existing-unreadable.test.ts`; this covers `EPERM`
 * specifically (which `chmod` alone cannot reliably reproduce) via the mock
 * seam instead.
 */
describe("EACCES/EPERM keep today's behaviour: fresh mode replaces, adopt mode falls back (EPERM, mock-seam regression pin)", () => {
  beforeEach(() => {
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  function mockEpermRead(path: string): void {
    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.readFileSync>) => {
        const [target] = args;
        if (String(target) === path) {
          const failure = new Error(
            "EPERM: operation not permitted (simulated)",
          ) as NodeJS.ErrnoException;
          failure.code = "EPERM";
          throw failure;
        }
        return real.readFileSync(...args);
      },
    );
  }

  it("[fresh mode] replaces the unreadable entry like any other stale copy, rather than throwing", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-eperm-fresh-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-eperm-fresh-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const domainMapDest = join(destDir, "domain-map.ts");
    writeFileSync(domainMapDest, "STALE\n");
    mockEpermRead(domainMapDest);

    const result = installCustomizeSkill(targetDir, sourceDir);

    expect(result.filesWritten).toContain(
      join(".claude", "skills", "customize", "domain-map.ts"),
    );
    expect(real.readFileSync(domainMapDest, "utf8")).toBe(
      "export const y = 2;\n",
    );

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });

  it("[adopt mode] falls back to .groundwork/customize/, naming the errno code in fallbackReason, rather than throwing", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "plugin-eperm-adopt-src-"));
    const targetDir = mkdtempSync(join(tmpdir(), "plugin-eperm-adopt-tgt-"));
    writeSourceFixture(sourceDir);
    const destDir = join(targetDir, ".claude", "skills", "customize");
    mkdirSync(destDir, { recursive: true });
    const domainMapDest = join(destDir, "domain-map.ts");
    writeFileSync(domainMapDest, "STALE\n");
    mockEpermRead(domainMapDest);

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("entry");
    expect(result.fallbackReason).toContain("EPERM");
    // The project's own (unreadable) entry is left exactly as it was.
    expect(readdirSync(destDir).toSorted()).toEqual(["domain-map.ts"]);
    expect(real.readFileSync(domainMapDest, "utf8")).toBe("STALE\n");

    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
  });
});
