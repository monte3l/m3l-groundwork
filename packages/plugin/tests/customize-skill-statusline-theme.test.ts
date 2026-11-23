// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Guards the statusline theme sentence in Step 3 of the `/customize` skill:
 * the m3l-design theme is offered through `GROUNDWORK_STATUSLINE_THEME` and is
 * never enabled by default.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(
  join(here, "..", "skills", "customize", "step-3-round-1.md"),
  "utf8",
).replace(/\s+/g, " ");

describe("step-3-round-1.md statusline theme", () => {
  it("names GROUNDWORK_STATUSLINE_THEME", () => {
    expect(text).toContain("GROUNDWORK_STATUSLINE_THEME");
  });

  it("states the theme is never on by default", () => {
    expect(text).toMatch(
      /never by default|not by default|never enabled by default/i,
    );
  });
});
