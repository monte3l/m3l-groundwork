// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers bin/lib/markdown.mjs -- a zero-dependency, restricted GFM-to-HTML
 * renderer, plain ESM under bin/ outside every tsconfig, loaded by URL (see
 * design-tokens.test.ts for the same pattern). Exercises `slugifyHeading`,
 * `extractHeadings` and `renderMarkdown` against small synthetic fixtures
 * shaped after the exact constructs `bin/build-docs.mjs`'s site pages use.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface Heading {
  level: number;
  text: string;
  slug: string;
}

interface RenderResult {
  html: string;
  headings: Heading[];
  italics: string[];
}

interface RenderOptions {
  resolveLink?: (href: string) => string;
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// design-tokens.test.ts / eval-lib.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "markdown.mjs")).href
)) as {
  MarkdownError: new (message?: string, options?: { cause?: unknown }) => Error;
  slugifyHeading: (text: string) => string;
  extractHeadings: (source: string) => Heading[];
  renderMarkdown: (source: string, options?: RenderOptions) => RenderResult;
  escapeHtml: (text: string) => string;
};

describe("slugifyHeading", () => {
  it("lowercases and hyphenates a plain heading", () => {
    expect(lib.slugifyHeading("Two modes")).toBe("two-modes");
  });

  it("strips leading punctuation instead of turning it into a hyphen", () => {
    expect(lib.slugifyHeading("/customize")).toBe("customize");
  });

  it("flattens inline code syntax to its plain visible text first", () => {
    expect(lib.slugifyHeading("`CLAUDE.md`")).toBe("claudemd");
  });

  it("drops parentheses without inserting a hyphen in their place", () => {
    expect(
      lib.slugifyHeading("Known gaps (deliberately out of scope so far)"),
    ).toBe("known-gaps-deliberately-out-of-scope-so-far");
  });
});

describe("extractHeadings", () => {
  it("returns level/text/slug in document order", () => {
    const source = ["# One", "", "## Two", "", "### Three", ""].join("\n");
    expect(lib.extractHeadings(source)).toEqual([
      { level: 1, text: "One", slug: "one" },
      { level: 2, text: "Two", slug: "two" },
      { level: 3, text: "Three", slug: "three" },
    ]);
  });

  it("does not treat a '#'-shaped line inside a fenced code block as a heading", () => {
    const source = [
      "# Real Heading",
      "",
      "```",
      "# not a heading",
      "```",
      "",
      "## Another Heading",
      "",
    ].join("\n");
    expect(lib.extractHeadings(source)).toEqual([
      { level: 1, text: "Real Heading", slug: "real-heading" },
      { level: 2, text: "Another Heading", slug: "another-heading" },
    ]);
  });

  it("suffixes duplicate heading text on the same page with -1, -2, ...", () => {
    const source = [
      "# Scope",
      "",
      "text",
      "",
      "## Scope",
      "",
      "text",
      "",
      "### Scope",
      "",
    ].join("\n");
    expect(lib.extractHeadings(source)).toEqual([
      { level: 1, text: "Scope", slug: "scope" },
      { level: 2, text: "Scope", slug: "scope-1" },
      { level: 3, text: "Scope", slug: "scope-2" },
    ]);
  });

  // The module's own HEADING_RE matches ATX headings h1-h6 uniformly;
  // extractHeadings (via scanHeadingLines) applies no level<=3 filter of its
  // own, so a h4+ heading IS reported here -- only renderMarkdown's block
  // parser rejects it. Verified against the real source rather than assumed.
  it("reports a heading level above 3 rather than silently dropping it", () => {
    expect(lib.extractHeadings("#### Four\n")).toEqual([
      { level: 4, text: "Four", slug: "four" },
    ]);
  });
});

describe("renderMarkdown: headings", () => {
  it("renders an h1-h3 with a GitHub-compatible id and a heading-N class", () => {
    expect(lib.renderMarkdown("# Title\n").html).toBe(
      '<h1 id="title" class="heading-1">Title</h1>',
    );
  });

  it("throws MarkdownError for a heading level above 3", () => {
    let thrown: unknown;
    try {
      lib.renderMarkdown("#### Four\n");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });
});

describe("renderMarkdown: paragraphs and emphasis", () => {
  it("wraps plain text in a body paragraph", () => {
    expect(lib.renderMarkdown("Just text.\n").html).toBe(
      '<p class="body">Just text.</p>',
    );
  });

  it("renders both ** and __ bold delimiters as <strong>", () => {
    expect(lib.renderMarkdown("**a** and __b__\n").html).toBe(
      '<p class="body"><strong>a</strong> and <strong>b</strong></p>',
    );
  });

  it("renders both * and _ italic delimiters as <em> and records each span in italics", () => {
    const result = lib.renderMarkdown("*a* and _b_\n");
    expect(result.html).toBe('<p class="body"><em>a</em> and <em>b</em></p>');
    expect(result.italics).toEqual(["*a*", "_b_"]);
  });

  // GFM's intraword-underscore rule: `_` (and `__`) is only emphasis when
  // NOT flanked by a word character on both outer sides. An earlier version
  // of INLINE_TOKEN_RE had no such boundary check and misread this as
  // `snake<em>case</em>name`.
  it("does not misread an intraword underscore run as italic ('snake_case_name')", () => {
    const result = lib.renderMarkdown("See snake_case_name here.\n");
    expect(result.html).toBe('<p class="body">See snake_case_name here.</p>');
    expect(result.italics).toEqual([]);
  });

  it("still renders genuine italic right next to word characters when the underscores sit at a word boundary", () => {
    const result = lib.renderMarkdown("a _real italic_ span\n");
    expect(result.html).toBe('<p class="body">a <em>real italic</em> span</p>');
    expect(result.italics).toEqual(["_real italic_"]);
  });

  it("applies the same intraword guard to the __bold__ delimiter ('dunder__method__name')", () => {
    expect(lib.renderMarkdown("dunder__method__name\n").html).toBe(
      '<p class="body">dunder__method__name</p>',
    );
  });
});

describe("renderMarkdown: a heading inside a blockquote or list item", () => {
  it("throws MarkdownError for a heading inside a blockquote", () => {
    let thrown: unknown;
    try {
      lib.renderMarkdown("> # Heading inside quote\n");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });

  it("throws MarkdownError for a heading inside a list item", () => {
    let thrown: unknown;
    try {
      lib.renderMarkdown("- item\n  # nested heading\n");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });
});

describe("renderMarkdown: code spans", () => {
  it("HTML-escapes code span content and never reinterprets it as bold/italic ('__proto__')", () => {
    expect(lib.renderMarkdown("`__proto__`\n").html).toBe(
      '<p class="body"><code class="code m3l-code-inline">__proto__</code></p>',
    );
  });

  it("never reinterprets a code span's asterisks as italic ('survey/*.ts')", () => {
    expect(lib.renderMarkdown("`survey/*.ts`\n").html).toBe(
      '<p class="body"><code class="code m3l-code-inline">survey/*.ts</code></p>',
    );
  });

  it("HTML-escapes angle brackets and ampersands inside a code span", () => {
    expect(lib.renderMarkdown("Some `<a & b>` code.\n").html).toBe(
      '<p class="body">Some <code class="code m3l-code-inline">&lt;a &amp; b&gt;</code> code.</p>',
    );
  });
});

describe("renderMarkdown: links and images", () => {
  it("renders a link whose text is a code span as a single <a> wrapping a <code>, with no literal brackets", () => {
    const html = lib.renderMarkdown("[`CLAUDE.md`](CLAUDE.md)\n", {
      resolveLink: (href) => href,
    }).html;
    expect(html).toBe(
      '<p class="body"><a class="m3l-link" href="CLAUDE.md"><code class="code m3l-code-inline">CLAUDE.md</code></a></p>',
    );
    expect(html).not.toContain("[");
    expect(html).not.toContain("]");
  });

  it("renders a link wrapping a badge image as an <a> containing an <img>", () => {
    const html = lib.renderMarkdown("[![CI](badge.svg)](https://ci-url)\n", {
      resolveLink: (href) => href,
    }).html;
    expect(html).toBe(
      '<p class="body"><a class="m3l-link" href="https://ci-url"><img src="badge.svg" alt="CI"></a></p>',
    );
  });

  it("renders a plain image as a self-contained <img>", () => {
    expect(lib.renderMarkdown("![alt](src)\n").html).toBe(
      '<p class="body"><img src="src" alt="alt"></p>',
    );
  });

  it("calls resolveLink for every link and image href, including a bare #fragment anchor", () => {
    const calls: string[] = [];
    lib.renderMarkdown("[anchor](#section)\n", {
      resolveLink: (href) => {
        calls.push(href);
        return href;
      },
    });
    expect(calls).toEqual(["#section"]);
  });

  it("uses a custom resolveLink's transformed href/src in the emitted attribute", () => {
    const html = lib.renderMarkdown("[text](/path) and ![alt](/img)\n", {
      resolveLink: (href) => href.toUpperCase(),
    }).html;
    expect(html).toBe(
      '<p class="body"><a class="m3l-link" href="/PATH">text</a> and <img src="/IMG" alt="alt"></p>',
    );
  });

  it("defaults resolveLink to the identity function when no option is given", () => {
    expect(lib.renderMarkdown("[t](/x)\n").html).toBe(
      '<p class="body"><a class="m3l-link" href="/x">t</a></p>',
    );
  });
});

describe("renderMarkdown: tables", () => {
  it("renders a header row, separator row and data row, inline-rendering each cell", () => {
    const source = ["| A | B |", "|---|---|", "| `code` | **bold** |", ""].join(
      "\n",
    );
    expect(lib.renderMarkdown(source).html).toBe(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead>" +
        '<tbody><tr><td><code class="code m3l-code-inline">code</code></td>' +
        "<td><strong>bold</strong></td></tr></tbody></table>",
    );
  });
});

describe("renderMarkdown: fenced code blocks", () => {
  it("renders a tagged fence as a figure/figcaption/pre with the language, escaped and not inline-processed", () => {
    const source = ["```bash", "echo **not bold**", "```", ""].join("\n");
    const html = lib.renderMarkdown(source).html;
    expect(html).toBe(
      '<figure class="m3l-code-block">' +
        '<figcaption class="m3l-code-block__header caption">' +
        '<span class="m3l-code-block__lang">bash</span></figcaption>' +
        '<pre tabindex="0" aria-label="bash">' +
        '<code class="code">echo **not bold**</code></pre></figure>',
    );
    expect(html).toContain("**not bold**");
    expect(html).not.toContain("<strong>");
  });

  it("defaults an untagged fence's language label to 'text'", () => {
    const source = ["```", "plain", "```", ""].join("\n");
    expect(lib.renderMarkdown(source).html).toBe(
      '<figure class="m3l-code-block">' +
        '<figcaption class="m3l-code-block__header caption">' +
        '<span class="m3l-code-block__lang">text</span></figcaption>' +
        '<pre tabindex="0" aria-label="text">' +
        '<code class="code">plain</code></pre></figure>',
    );
  });

  // Regression test: an earlier version silently swallowed the rest of the
  // document into one code block instead of rejecting a fence with no
  // matching close.
  it("throws MarkdownError for an unclosed code fence", () => {
    let thrown: unknown;
    try {
      lib.renderMarkdown("```bash\necho hi\n");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });
});

describe("renderMarkdown: lists", () => {
  it("renders a simple unordered list", () => {
    expect(lib.renderMarkdown("- a\n- b\n").html).toBe(
      "<ul><li>a</li><li>b</li></ul>",
    );
  });

  it("renders a simple ordered list", () => {
    expect(lib.renderMarkdown("1. a\n2. b\n").html).toBe(
      "<ol><li>a</li><li>b</li></ol>",
    );
  });

  it("renders a nested list inside the parent item's <li>", () => {
    expect(lib.renderMarkdown("- Parent\n  - Child\n").html).toBe(
      '<ul><li><p class="body">Parent</p><ul><li>Child</li></ul></li></ul>',
    );
  });

  // Regression test: an earlier version of the list-item parser only
  // stripped leading spaces, not the marker text itself ("- ", "1. "),
  // and a wrapped/indented continuation line triggered infinite recursion.
  // This must both complete quickly and produce no leftover marker text.
  it("strips a list item's own marker and joins a wrapped continuation line, without hanging", () => {
    const source = [
      "- item one",
      "  continued",
      "- item two",
      "  continued too",
      "",
    ].join("\n");
    const html = lib.renderMarkdown(source).html;
    expect(html).toBe(
      "<ul><li>item one continued</li><li>item two continued too</li></ul>",
    );
    expect(html).not.toContain("- ");
  });

  // Regression test: an earlier version of listContinues treated any line
  // indented at or past the list's own indent as a continuation, which for
  // a top-level list (indent 0) is every remaining line in the document --
  // silently absorbing a following paragraph and heading into the list's
  // last <li> instead of closing the list first.
  it("closes the list before a following paragraph and heading, rather than absorbing them into the last item", () => {
    const source = "- a\n- b\n\nAfter para\n\n## Next\n\ntext\n";
    expect(lib.renderMarkdown(source).html).toBe(
      "<ul><li>a</li><li>b</li></ul>" +
        '<p class="body">After para</p>' +
        '<h2 id="next" class="heading-2">Next</h2>' +
        '<p class="body">text</p>',
    );
  });

  it("closes the list before a following paragraph even with no blank line separating them", () => {
    const source = "- a\nAfter para without blank line\n";
    expect(lib.renderMarkdown(source).html).toBe(
      '<ul><li>a</li></ul><p class="body">After para without blank line</p>',
    );
  });
});

describe("renderMarkdown: blockquotes and GitHub alerts", () => {
  it("renders a plain blockquote as a neutral aside with no data-status and no title", () => {
    const html = lib.renderMarkdown("> Just a note.\n").html;
    expect(html).toBe(
      '<aside class="m3l-callout" role="note" aria-label="Note">' +
        '<div class="m3l-callout__content"><p class="body">Just a note.</p></div></aside>',
    );
    expect(html).not.toContain("data-status");
    expect(html).not.toContain("m3l-callout__title");
  });

  it("maps [!NOTE] to data-status=info with a capitalized title and an inline icon", () => {
    const source = ["> [!NOTE]", "> Something.", ""].join("\n");
    expect(lib.renderMarkdown(source).html).toBe(
      '<aside class="m3l-callout" data-status="info" role="note" aria-label="Note">' +
        '<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true">' +
        '<circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6.5v.01"/></svg>' +
        '<div class="m3l-callout__content"><p class="m3l-callout__title label">Note</p>' +
        '<p class="body">Something.</p></div></aside>',
    );
  });

  it("maps [!WARNING] to data-status=warning", () => {
    const source = ["> [!WARNING]", "> Careful.", ""].join("\n");
    const html = lib.renderMarkdown(source).html;
    expect(html).toContain('data-status="warning"');
    expect(html).toContain('aria-label="Warning"');
    expect(html).toContain('<p class="m3l-callout__title label">Warning</p>');
  });

  it("maps [!CAUTION] to data-status=danger", () => {
    const source = ["> [!CAUTION]", "> Danger.", ""].join("\n");
    const html = lib.renderMarkdown(source).html;
    expect(html).toContain('data-status="danger"');
    expect(html).toContain('aria-label="Caution"');
    expect(html).toContain('<p class="m3l-callout__title label">Caution</p>');
  });
});

describe("renderMarkdown: thematic breaks and HTML comments", () => {
  it("renders a standalone --- line as <hr>", () => {
    const source = ["text", "", "---", "", "more", ""].join("\n");
    expect(lib.renderMarkdown(source).html).toBe(
      '<p class="body">text</p><hr><p class="body">more</p>',
    );
  });

  it("strips an HTML comment, including one spanning multiple lines, producing no output", () => {
    const source = ["before", "<!-- a", "comment -->", "after", ""].join("\n");
    expect(lib.renderMarkdown(source).html).toBe(
      '<p class="body">before</p><p class="body">after</p>',
    );
  });

  it("strips two separate, non-nested HTML comments in the same document", () => {
    expect(lib.renderMarkdown("<!--a-->x<!--b-->y\n").html).toBe(
      '<p class="body">xy</p>',
    );
  });

  it("throws MarkdownError for a malformed, nested-looking HTML comment instead of leaking a dangling --> fragment", () => {
    const source = "before<!-- outer <!-- inner --> still-outer -->after\n";
    let thrown: unknown;
    try {
      lib.renderMarkdown(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });
});

describe("renderMarkdown: footnotes", () => {
  it("numbers footnotes in order of first reference, not definition order, and renders the back-link section", () => {
    const source = [
      "First ref [^b] then second ref [^a].",
      "",
      "[^a]:",
      "    Definition A.",
      "",
      "[^b]:",
      "    Definition B.",
      "",
    ].join("\n");
    const result = lib.renderMarkdown(source);
    expect(result.html).toBe(
      '<p class="body">First ref <sup id="fnref-b"><a href="#fn-b">1</a></sup>' +
        ' then second ref <sup id="fnref-a"><a href="#fn-a">2</a></sup>.</p>' +
        '<section class="m3l-footnotes"><hr><ol>' +
        '<li id="fn-b" value="1"><p class="body">Definition B.</p> ' +
        '<a class="m3l-link" href="#fnref-b">↩</a></li>' +
        '<li id="fn-a" value="2"><p class="body">Definition A.</p> ' +
        '<a class="m3l-link" href="#fnref-a">↩</a></li>' +
        "</ol></section>",
    );
  });

  it("throws MarkdownError for a reference to an unknown footnote label", () => {
    let thrown: unknown;
    try {
      lib.renderMarkdown("A ref [^missing].\n");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });

  it("throws MarkdownError for a duplicate definition of the same footnote label", () => {
    const source = [
      "Ref [^a].",
      "",
      "[^a]:",
      "    First.",
      "",
      "[^a]:",
      "    Second.",
      "",
    ].join("\n");
    let thrown: unknown;
    try {
      lib.renderMarkdown(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });

  it("throws MarkdownError for a footnote definition whose body is empty", () => {
    const source = ["Ref [^a].", "", "[^a]:", "", "More text.", ""].join("\n");
    let thrown: unknown;
    try {
      lib.renderMarkdown(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });

  it("throws MarkdownError for a footnote definition never referenced anywhere in the document", () => {
    const source = ["No refs here.", "", "[^a]:", "    Body text.", ""].join(
      "\n",
    );
    let thrown: unknown;
    try {
      lib.renderMarkdown(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lib.MarkdownError);
  });

  // Regression test: a footnote referenced ONLY from inside another
  // footnote's own body previously got a <sup> link with no matching <li>
  // for it to land on, because footnote bodies were rendered from a single
  // snapshot of ctx.footnoteOrder taken before any body was rendered.
  it("resolves a footnote referenced only from inside another footnote's body", () => {
    const source = [
      "Main text [^a].",
      "",
      "[^a]:",
      "    Body references [^b] here.",
      "",
      "[^b]:",
      "    Second body.",
      "",
    ].join("\n");
    const html = lib.renderMarkdown(source).html;
    expect(html).toContain('<li id="fn-a" value="1">');
    expect(html).toContain('<li id="fn-b" value="2">');
    expect(html).toContain('<sup id="fnref-b"><a href="#fn-b">2</a></sup>');
    expect(html).toContain('id="fn-b"');
  });
});

describe("escapeHtml", () => {
  it("escapes &, <, >, \" and ' as HTML entities", () => {
    expect(lib.escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });
});

describe("MarkdownError", () => {
  it("is a named Error subclass", () => {
    const error = new lib.MarkdownError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MarkdownError");
    expect(error.message).toBe("boom");
  });

  it("chains a cause passed via the standard Error options argument", () => {
    const inner = new Error("inner");
    const error = new lib.MarkdownError("outer", { cause: inner });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toBe(inner);
    expect((error.cause as Error).message).toBe("inner");
  });
});
