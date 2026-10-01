// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pins an invariant `restoreDotfilePath`/`toPosixPath`-style rewriting
 * depends on silently: no file or directory name under the real
 * `templates/core` tree, or any `templates/packs/*\/files` tree, contains a
 * backslash. A path segment that did would be silently reinterpreted as a
 * directory separator by any POSIX-separator-normalizing walker rather than
 * erroring -- this test walks the actual trees on every run (not a fixture)
 * so a newly added offending file is caught immediately.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { templatesCoreDir } from "../src/main.js";
import { listPackNames, packsRootDir } from "../src/packs.js";

/** Every file and directory NAME (not path) found anywhere under `root`, walked recursively with no skip rules -- this check must see every real entry, not a filtered subset. */
function listAllEntryNames(root: string): string[] {
  const names: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      names.push(entry.name);
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      }
    }
  }
  if (existsSync(root)) {
    walk(root);
  }
  return names;
}

describe("template tree path segments carry no backslash", () => {
  it("templates/core has at least one file and no backslash in any entry name", () => {
    const names = listAllEntryNames(templatesCoreDir());

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name.includes("\\"))).toEqual([]);
  });

  const packNames = listPackNames(packsRootDir());

  it("templates/packs has at least one pack to check (sanity on this test's own fixture)", () => {
    expect(packNames.length).toBeGreaterThan(0);
  });

  it.each(packNames.map((name): [string] => [name]))(
    "templates/packs/%s/files has at least one file and no backslash in any entry name",
    (name) => {
      const filesDir = join(packsRootDir(), name, "files");
      const names = listAllEntryNames(filesDir);

      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => n.includes("\\"))).toEqual([]);
    },
  );
});
