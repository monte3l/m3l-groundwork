// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// Pins the two template edits that keep the `.groundwork/` record out of the
// emitted project's own gates: Prettier must not reformat it, and the
// licensing pack's REUSE.toml must cover the `.base` copies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "..", "..", "..", "..", "templates");

describe("the .groundwork/ record in the emitted templates", () => {
  it("core .prettierignore ignores .groundwork/", () => {
    const lines = readFileSync(
      join(templates, "core", ".prettierignore"),
      "utf8",
    )
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain(".groundwork/");
  });

  it("the licensing pack's REUSE.toml annotates .groundwork/base/**", () => {
    const toml = readFileSync(
      join(templates, "packs", "licensing", "files", "REUSE.toml"),
      "utf8",
    );
    expect(toml).toContain('".groundwork/base/**"');
  });
});
