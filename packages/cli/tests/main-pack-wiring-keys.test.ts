// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * End-to-end proof of issue #97: loadPack's prototype-sensitive wiring-key
 * guard must stop BOTH CLI modes before either does any damage -- fresh
 * mode must never create the target directory at all, and adopt mode must
 * never touch `.groundwork/`'s pre-existing contents. (Field-by-field unit
 * coverage of the guard itself lives in packages/cli/tests/packs.test.ts's
 * own "loadPack wiring-key prototype guard (#97)" describe block.)
 *
 * packs.js is mocked (importOriginal-preserving) so a single pack name,
 * "proto-bad", resolves to a pack.json written under a temp packs root with
 * a literal own "__proto__" key inside wiring.settings -- built via
 * JSON.parse, never an object-literal `{ __proto__: ... }` (which would
 * invoke the Annex B exotic setter and never create a real own key at all,
 * making this a vacuous fixture). git.js and plugin.js are mocked the same
 * way main-run.test.ts mocks them, so a RED-phase run (where the guard does
 * not exist yet and fresh mode runs to completion) never spawns a real
 * `git init`/`pnpm install`.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PacksModule from "../src/packs.js";

/** Same rationale as packs.test.ts's identically-named helper: JSON.parse creates a genuine own "__proto__" data property; an object literal would not. */
function buildOwnKeyFragment<T>(key: string, value: T): Record<string, T> {
  return JSON.parse(`{"${key}":${JSON.stringify(value)}}`) as Record<string, T>;
}

const badPacksRoot = mkdtempSync(join(tmpdir(), "main-proto-bad-pack-root-"));
mkdirSync(join(badPacksRoot, "proto-bad", "files"), { recursive: true });
writeFileSync(
  join(badPacksRoot, "proto-bad", "pack.json"),
  JSON.stringify({
    schemaVersion: 1,
    name: "proto-bad",
    description: 'a pack whose wiring.settings carries an own "__proto__" key',
    modes: ["fresh", "adopt"],
    budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
    wiring: {
      settings: buildOwnKeyFragment("__proto__", [
        { hooks: [{ type: "command", command: "node malicious.mjs" }] },
      ]),
      packageScripts: {},
      verifySteps: [],
    },
  }),
);

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));
const installCustomizeSkillGuardedMock = vi.fn(() => ({
  filesWritten: [],
  location: "claude" as const,
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: installCustomizeSkillGuardedMock,
}));
vi.mock("../src/packs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PacksModule>();
  return {
    ...actual,
    listPackNames: () => ["proto-bad"],
    loadPack: (name: string) => actual.loadPack(name, badPacksRoot),
  };
});

const { main, CliUsageError } = await import("../src/main.js");

afterAll(() => {
  rmSync(badPacksRoot, { recursive: true, force: true });
});

describe("prototype-sensitive wiring key stops both CLI modes before any write (#97)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-proto-bad-target-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  describe("fresh mode", () => {
    it("rejects the pack as loadPack's own failure (exit 1, not a usage error) and leaves the target directory unwritten", () => {
      const target = join(targetDir, "never-written");

      let thrown: unknown;
      try {
        main([target, "--pack", "proto-bad"]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      // Not just "an Error was thrown" -- the SPECIFIC failure this test
      // names: loadPack's own prototype-sensitive-key rejection, propagated
      // unchanged by resolveFreshPack, naming the actual offending key.
      expect((thrown as Error).message).toContain("prototype-sensitive key");
      expect((thrown as Error).message).toContain('"__proto__"');
      expect(existsSync(target)).toBe(false);
      expect(gitInitMock).not.toHaveBeenCalled();
    });
  });

  describe("adopt mode", () => {
    it("fails before .groundwork/ is touched -- a pre-existing inventory.json survives the failed run byte-for-byte, and the bad pack is never staged", () => {
      const projectDir = join(targetDir, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "acme", type: "module" }),
      );
      const groundworkDir = join(projectDir, ".groundwork");
      mkdirSync(groundworkDir, { recursive: true });
      const inventoryPath = join(groundworkDir, "inventory.json");
      const priorInventory = JSON.stringify({
        schemaVersion: 0,
        marker: "pre-existing",
      });
      writeFileSync(inventoryPath, priorInventory);

      let thrown: unknown;
      try {
        main([projectDir]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      // Same discrimination as the fresh-mode test above: the run must fail
      // on THIS specific guard, not merely fail for some other reason that
      // happens to also leave inventory.json untouched.
      expect((thrown as Error).message).toContain("prototype-sensitive key");
      expect((thrown as Error).message).toContain('"__proto__"');
      expect(existsSync(inventoryPath)).toBe(true);
      expect(readFileSync(inventoryPath, "utf8")).toBe(priorInventory);
      expect(existsSync(join(groundworkDir, "packs", "proto-bad"))).toBe(false);
    });
  });
});
