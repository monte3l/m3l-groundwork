// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `buildTheirsTree`: the project the running CLI would bootstrap, in a
 * private temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTemplate } from "../src/emit.js";
import { templatesCoreDir } from "../src/main.js";
import { installPack, loadPack } from "../src/packs.js";
import { installCustomizeSkill } from "../src/plugin.js";
import { buildTheirsTree } from "../src/theirs-tree.js";
import { snapshotTree } from "./add-pack-fixtures.js";
import { TOKENS } from "./update-classify-fixtures.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "theirs-tree-test-"));
  // os.tmpdir() reads TMPDIR on POSIX: the tree is built in a private dir,
  // so a leftover check cannot race other test files.
  vi.stubEnv("TMPDIR", scratch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function leftovers(): string[] {
  return readdirSync(scratch).filter((name) => name.startsWith("m3l-theirs-"));
}

describe.skipIf(process.platform === "win32")("buildTheirsTree", () => {
  it.each([[[]], [["quality"]], [["quality", "statusline"]]] as string[][][])(
    "holds exactly the bytes a fresh bootstrap writes for packs %j",
    (packs) => {
      const expected = join(scratch, "expected");
      emitTemplate(templatesCoreDir(), expected, TOKENS);
      for (const name of packs) installPack(loadPack(name), expected, TOKENS);
      installCustomizeSkill(expected);

      const theirs = buildTheirsTree({ tokens: TOKENS, packNames: packs });
      try {
        expect(theirs.dir.startsWith(join(scratch, "m3l-theirs-"))).toBe(true);
        expect(snapshotTree(theirs.dir)).toEqual(snapshotTree(expected));
        expect(theirs.missingPacks).toEqual([]);
      } finally {
        theirs.cleanup();
      }
    },
  );

  it("attributes each file to core, skill or its pack", () => {
    const theirs = buildTheirsTree({ tokens: TOKENS, packNames: ["quality"] });
    try {
      expect(theirs.sources.get("eslint.config.js")).toBe("core");
      expect(theirs.sources.get("package.json")).toBe("core");
      expect(theirs.sources.get(".claude/skills/customize/SKILL.md")).toBe(
        "skill",
      );
      expect(theirs.sources.get("bin/check-file-budget.mjs")).toBe(
        "pack:quality",
      );
    } finally {
      theirs.cleanup();
    }
  });

  it("merges pack wiring into the three JSON files", () => {
    const plain = buildTheirsTree({ tokens: TOKENS, packNames: [] });
    const withPack = buildTheirsTree({
      tokens: TOKENS,
      packNames: ["quality"],
    });
    try {
      const wiring = "bin/lib/verify-steps.packs.json";
      expect(snapshotTree(withPack.dir)[wiring]).not.toBe(
        snapshotTree(plain.dir)[wiring],
      );
    } finally {
      plain.cleanup();
      withPack.cleanup();
    }
  });

  it("reports a pack the CLI no longer ships instead of throwing", () => {
    const theirs = buildTheirsTree({
      tokens: TOKENS,
      packNames: ["quality", "long-gone-pack"],
    });
    try {
      expect(theirs.missingPacks).toEqual(["long-gone-pack"]);
      expect(theirs.sources.get("bin/check-file-budget.mjs")).toBe(
        "pack:quality",
      );
    } finally {
      theirs.cleanup();
    }
  });

  it("cleanup removes the directory and is idempotent", () => {
    const theirs = buildTheirsTree({ tokens: TOKENS, packNames: [] });
    expect(existsSync(theirs.dir)).toBe(true);
    theirs.cleanup();
    expect(existsSync(theirs.dir)).toBe(false);
    expect(() => {
      theirs.cleanup();
    }).not.toThrow();
    expect(leftovers()).toEqual([]);
  });

  it("leaves no m3l-theirs-* directory behind when the build fails", () => {
    expect(() =>
      buildTheirsTree({
        tokens: TOKENS,
        packNames: [],
        coreDir: join(scratch, "no-such-core"),
      }),
    ).toThrow();
    expect(leftovers()).toEqual([]);
  });
});
