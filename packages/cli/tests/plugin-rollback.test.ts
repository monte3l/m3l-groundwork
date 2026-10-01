// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Coverage for two `../src/plugin.js` branches `plugin-install.test.ts` and
 * `plugin-symlink.test.ts` cannot reach with a real filesystem alone:
 *
 * - `rollBack`'s own `catch` (its `rmSync` call failing while undoing a
 *   write failure) -- the "could not remove: <path>" clause appended to the
 *   wrapper message, and the file genuinely left behind on disk.
 * - `installError`'s non-`Error` `cause` arm (`String(cause)` rather than
 *   `cause.message`) -- real `fs` calls only ever throw `Error` subclasses,
 *   so this needs a collaborator that deliberately throws something else.
 *
 * Both need a seam `rmSync`/`writeFileSync` cannot provide while behaving
 * like real `fs`, so this file mocks `node:fs` (the same `vi.hoisted`
 * partial-mock pattern `git.test.ts` uses for `node:child_process`),
 * preserving every real implementation except the two functions under test
 * -- which, by default, delegate to the real implementation too, and only
 * misbehave for the one path/call each test targets.
 *
 * Every import of `rmSync`/`writeFileSync` from "node:fs" in THIS file
 * resolves to the mock (vi.mock replaces the whole module for every
 * importer, including this file's own top-level import) -- so the "real"
 * fallback a passthrough needs is captured once, inside the mock factory,
 * from `importOriginal`, never re-imported by name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";

// vi.mock(...) is hoisted above every other statement in this file,
// including a plain top-level `let` -- so the real implementations this
// file's "passthrough" default needs are captured into a vi.hoisted() ref
// object instead, mutated once from inside the mock factory below.
const { rmSyncMock, writeFileSyncMock, real } = vi.hoisted(() => ({
  rmSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  real: {} as {
    rmSync: typeof NodeFs.rmSync;
    writeFileSync: typeof NodeFs.writeFileSync;
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  real.rmSync = actual.rmSync;
  real.writeFileSync = actual.writeFileSync;
  return { ...actual, rmSync: rmSyncMock, writeFileSync: writeFileSyncMock };
});

const { installCustomizeSkill } = await import("../src/plugin.js");

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
}

describe("installCustomizeSkill rollback and error-normalization edge cases", () => {
  let sourceDir: string;
  let targetDir: string;
  let destDir: string;

  beforeEach(() => {
    // Default: delegate to the real implementation. Only a test that layers
    // its own mockImplementation on top changes behavior, and only for the
    // path(s)/call(s) it names.
    rmSyncMock.mockImplementation((...args: Parameters<typeof NodeFs.rmSync>) =>
      real.rmSync(...args),
    );
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>) =>
        real.writeFileSync(...args),
    );

    sourceDir = mkdtempSync(join(tmpdir(), "plugin-rollback-source-"));
    targetDir = mkdtempSync(join(tmpdir(), "plugin-rollback-target-"));
    writeSourceFixture(sourceDir);
    destDir = join(targetDir, ".claude", "skills", "customize");
  });

  afterEach(() => {
    real.rmSync(sourceDir, { recursive: true, force: true });
    real.rmSync(targetDir, { recursive: true, force: true });
    // A plain vi.fn() created inside a top-level vi.mock(...)/vi.hoisted(...)
    // factory is not cleared by vi.restoreAllMocks() (that only undoes
    // vi.spyOn spies) -- reset call history and any per-test
    // mockImplementation explicitly.
    rmSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("[rollback can't-remove] names a file rollback itself failed to remove, which is genuinely left behind, while the other rolled-back files are removed", () => {
    const kindFacetDest = join(destDir, "kind-facet-map.ts");
    const domainMapDest = join(destDir, "domain-map.ts");
    const packMapDest = join(destDir, "pack-map.ts");
    const pluginMapDest = join(destDir, "plugin-map.ts");

    // Plant a non-empty directory at plugin-map.ts's destination (the 4th
    // file in write order) so its own pre-write `rmSync(dest, { force:
    // true })` -- called without `recursive`, like the real write path --
    // throws ERR_FS_EISDIR, the natural failure that triggers a rollback of
    // the three files written before it.
    mkdirSync(pluginMapDest, { recursive: true });
    writeFileSync(join(pluginMapDest, "blocks-the-rm.txt"), "occupied\n");

    // domain-map.ts's rmSync is called twice: once as part of its own
    // pre-write cleanup (must succeed, so the real write proceeds and the
    // file is added to `written`), and once during rollback after
    // plugin-map.ts's write fails (made to fail here). Count per-path calls
    // so only the SECOND call against this exact path misbehaves.
    const callCounts = new Map<string, number>();
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.rmSync>): void => {
        const [target] = args;
        const key = String(target);
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (key === domainMapDest && count === 2) {
          throw new Error("EACCES: permission denied, unlink (simulated)");
        }
        real.rmSync(...args);
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
    expect(message).toContain(pluginMapDest);
    expect(message).toContain("removed the 2 file(s) already written");
    expect(message).toContain(`could not remove: ${domainMapDest}`);
    expect((thrown as Error).cause).toBeInstanceOf(Error);

    // Rolled back successfully: removed by this run's own rollback.
    expect(existsSync(kindFacetDest)).toBe(false);
    expect(existsSync(packMapDest)).toBe(false);
    // Rollback's own rmSync failed for this one: genuinely left behind.
    expect(existsSync(domainMapDest)).toBe(true);
  });

  // The intentional non-Error throw below exercises installError's
  // `cause instanceof Error ? cause.message : String(cause)` fallback arm --
  // real `fs` calls never throw a non-Error, so only a deliberately
  // misbehaving collaborator reaches it.
  it("[non-Error cause] normalizes a non-Error thrown value via String(cause), and preserves the raw value as cause", () => {
    const kindFacetDest = join(destDir, "kind-facet-map.ts");
    mkdirSync(destDir, { recursive: true });

    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof NodeFs.writeFileSync>): void => {
        const [target] = args;
        if (String(target) === kindFacetDest) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to verify installError's String(cause) normalization
          throw "disk full (simulated)";
        }
        real.writeFileSync(...args);
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
    expect(message).toContain(kindFacetDest);
    // The non-Error cause was stringified into the wrapper's own message...
    expect(message).toContain("disk full (simulated)");
    // ...but preserved RAW (not re-wrapped) as the Error's `cause`.
    expect((thrown as Error).cause).toBe("disk full (simulated)");
    // kind-facet-map.ts is the first file written; nothing had been written
    // yet when it failed, so the rollback had nothing to do.
    expect(message).toContain("removed the 0 file(s) already written");
  });
});
