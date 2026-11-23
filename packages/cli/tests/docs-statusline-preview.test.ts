// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for `bin/docs-statusline-preview.mjs`, the docs-kit generator that
 * turns the statusline pack's SGR output into `<span class="sl-<role>">` HTML.
 * Plain ESM under bin/, outside every tsconfig -- loaded by URL.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const mod = (await import(
  pathToFileURL(join(repoRoot, "bin", "docs-statusline-preview.mjs")).href
)) as {
  sgrToHtml: (text: string, palette: Record<string, string>) => string;
  default: () => Promise<
    { out: string; group: string; label: string; html: string }[]
  >;
};
const { sgrToHtml } = mod;

const PALETTE = {
  success: "\x1b[38;2;1;2;3m",
  danger: "\x1b[38;2;4;5;6m",
  muted: "\x1b[2m",
  reset: "\x1b[0m",
};

describe("sgrToHtml", () => {
  it("wraps a colored run in a role span that the reset closes", () => {
    expect(sgrToHtml(`a${PALETTE.success}ok${PALETTE.reset}b`, PALETTE)).toBe(
      'a<span class="sl-success">ok</span>b',
    );
  });

  it("closes a span before opening the next and keeps spans balanced", () => {
    const html = sgrToHtml(
      `${PALETTE.success}x${PALETTE.danger}y${PALETTE.reset}`,
      PALETTE,
    );
    expect(html).toBe(
      '<span class="sl-success">x</span><span class="sl-danger">y</span>',
    );
  });

  it("closes a span left open at the end of the text", () => {
    expect(sgrToHtml(`${PALETTE.muted}dim`, PALETTE)).toBe(
      '<span class="sl-muted">dim</span>',
    );
  });

  it("HTML-escapes text inside and outside spans", () => {
    const html = sgrToHtml(
      `<a & "b">${PALETTE.success}<i> & "q"${PALETTE.reset}`,
      PALETTE,
    );
    expect(html).toBe(
      '&lt;a &amp; &quot;b&quot;&gt;<span class="sl-success">&lt;i&gt; &amp; &quot;q&quot;</span>',
    );
  });

  it("throws on an SGR escape that is not a palette role", () => {
    expect(() => sgrToHtml("\x1b[1mbold\x1b[0m", PALETTE)).toThrow(
      /no palette role/,
    );
  });

  it.each([
    ["an OSC-8 link", "\x1b]8;;http://x\x07link"],
    ["a bare BEL", "ding\x07"],
  ])("throws on %s left in the text", (_n, text) => {
    expect(() => sgrToHtml(text, PALETTE)).toThrow(/control sequence/);
  });

  it("does not throw on tab and newline", () => {
    expect(sgrToHtml("a\tb\nc", PALETTE)).toBe("a\tb\nc");
  });

  it("throws when two roles share one escape", () => {
    expect(() =>
      sgrToHtml("x", { ...PALETTE, danger: PALETTE.success }),
    ).toThrow(/share one escape/);
  });

  it("ignores empty-string roles (a NO_COLOR palette) instead of mapping them", () => {
    const empty = { success: "", danger: "", muted: "", reset: "" };
    expect(sgrToHtml("plain text", empty)).toBe("plain text");
  });
});

describe("the generator's default export", () => {
  it("returns exactly the Start-group status line page with a sanitized preview", async () => {
    const pages = await mod.default();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.out).toBe("docs/statusline.html");
    expect(pages[0]?.group).toBe("Start");
    expect(pages[0]?.html).toContain('class="sl-preview"');
    expect(pages[0]?.html).not.toContain("\x1b");
  });
});
