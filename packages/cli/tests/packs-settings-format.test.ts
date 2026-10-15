// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "prettier";
import { emitTemplate } from "../src/emit.js";
import { templatesCoreDir } from "../src/main.js";
import { installPack, loadPack } from "../src/packs.js";

const DENY = ["Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)"];

let targetDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "packs-settings-format-"));
  emitTemplate(templatesCoreDir(), targetDir, {});
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

function readSettingsText(): string {
  return readFileSync(join(targetDir, ".claude", "settings.json"), "utf8");
}

describe("installPack settings.json formatting", () => {
  it.each([
    ["harness-extras", "hooks and a top-level statusLine"],
    ["quality", "no settings hooks"],
    ["github", "hooks"],
  ])("%s (%s) leaves settings.json prettier-clean", async (name) => {
    installPack(loadPack(name), targetDir, {});
    const text = readSettingsText();

    expect(text).toBe(await format(text, { parser: "json" }));
  });

  it.each(["harness-extras", "quality"])(
    "%s keeps the baseline permissions.deny and key order",
    (name) => {
      installPack(loadPack(name), targetDir, {});
      const parsed = JSON.parse(readSettingsText()) as {
        permissions: { deny: string[] };
      };

      expect(parsed.permissions.deny).toEqual(DENY);
      expect(Object.keys(parsed).slice(0, 3)).toEqual([
        "$schema",
        "permissions",
        "hooks",
      ]);
    },
  );

  it("harness-extras plants statusLine after the baseline keys", () => {
    installPack(loadPack("harness-extras"), targetDir, {});

    expect(Object.keys(JSON.parse(readSettingsText()) as object)).toEqual([
      "$schema",
      "permissions",
      "hooks",
      "statusLine",
      "subagentStatusLine",
    ]);
  });
});

describe("installPack settings.json print-width boundary", () => {
  const WIDTH = 80;

  // Builds a deny array whose one-line form, as printed by prettier, is
  // exactly `columns` wide: 4-space indent + `"deny": [` + items + `]`
  // (+ `,` when a sibling key follows).
  function denyForWidth(columns: number, trailingComma: boolean): string[] {
    const fixed = ["Read(./.env)", "Read(./.env.*)"];
    const render = (items: string[]): string =>
      `    "deny": [${items.map((i) => JSON.stringify(i)).join(", ")}]${trailingComma ? "," : ""}`;
    const base = render([...fixed, "Read()"]).length;
    const pad = "x".repeat(columns - base);
    const deny = [...fixed, `Read(${pad})`];
    expect(render(deny).length).toBe(columns);
    return deny;
  }

  function seed(deny: string[], withSibling: boolean): void {
    const path = join(targetDir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    settings["permissions"] = withSibling ? { deny, allow: [] } : { deny };
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }

  it.each([
    [WIDTH, false],
    [WIDTH, true],
    [WIDTH + 1, false],
    [WIDTH + 1, true],
  ])(
    "deny line of %i columns (sibling key: %s) stays prettier-clean",
    async (columns, withSibling) => {
      const deny = denyForWidth(columns, withSibling);
      seed(deny, withSibling);

      installPack(loadPack("quality"), targetDir, {});
      const text = readSettingsText();

      expect(text).toBe(await format(text, { parser: "json" }));
      const parsed = JSON.parse(text) as { permissions: { deny: string[] } };
      expect(parsed.permissions.deny).toEqual(deny);

      const lines = text.split("\n");
      if (columns <= WIDTH) {
        const line = lines.find((l) => l.startsWith('    "deny": ['));
        expect(line).toBeDefined();
        expect((line ?? "").length).toBe(columns);
      } else {
        expect(lines).toContain('    "deny": [');
        expect(lines.filter((l) => l.startsWith('    "deny": [')).length).toBe(
          1,
        );
      }
    },
  );
});
