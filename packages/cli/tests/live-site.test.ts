// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers bin/lib/live-site.mjs -- pure helpers for comparing the deployed docs
 * site against what the repo builds: parsing the Cloudflare `_headers` file,
 * resolving which headers apply to a URL path, diffing them against a live
 * response, mapping built files to public URL paths, locating the first
 * differing line of two texts, and diffing package.json metadata against the
 * GitHub repo settings. Plain ESM under bin/ outside every tsconfig, loaded by
 * URL (same pattern as site-headers.test.ts).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

interface HeaderBlock {
  pattern: string;
  headers: [string, string][];
}

interface FirstDifference {
  line: number;
  expected: string;
  actual: string;
}

interface PkgMeta {
  description?: string | undefined;
  homepage?: string | undefined;
  keywords?: string[] | undefined;
}

interface RepoMeta {
  description?: string | null;
  homepage?: string | null;
  topics?: string[];
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "live-site.mjs")).href
)) as {
  HeadersParseError: new (message: string) => Error;
  parseHeadersFile: (text: string) => HeaderBlock[];
  expectedHeadersFor: (
    blocks: HeaderBlock[],
    urlPath: string,
  ) => Record<string, string>;
  diffHeaders: (
    expected: Record<string, string>,
    actual: { get(name: string): string | null },
  ) => string[];
  pageUrlPath: (outPath: string) => string;
  firstDifference: (expected: string, actual: string) => FirstDifference | null;
  diffMetadata: (pkg: PkgMeta, repo: RepoMeta) => string[];
};

const siteHeaders = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "site-headers.mjs")).href
)) as {
  buildHeadersFile: (options: {
    scriptHash: string;
    imageHosts: string[];
  }) => string;
};

describe("parseHeadersFile", () => {
  it("parses a pattern with indented headers in order", () => {
    const text = "/*\n  X-A: one\n  X-B: two\n";
    expect(lib.parseHeadersFile(text)).toEqual([
      {
        pattern: "/*",
        headers: [
          ["X-A", "one"],
          ["X-B", "two"],
        ],
      },
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(lib.parseHeadersFile("")).toEqual([]);
  });

  it("parses several blocks separated by blank lines", () => {
    const text = "/*\n  X-A: 1\n\n/assets/*\n  X-B: 2\n";
    expect(lib.parseHeadersFile(text)).toEqual([
      { pattern: "/*", headers: [["X-A", "1"]] },
      { pattern: "/assets/*", headers: [["X-B", "2"]] },
    ]);
  });

  it("yields headers: [] for a pattern with no headers", () => {
    expect(lib.parseHeadersFile("/lonely\n/*\n  X-A: 1\n")).toEqual([
      { pattern: "/lonely", headers: [] },
      { pattern: "/*", headers: [["X-A", "1"]] },
    ]);
  });

  it("splits on the first ': ' so values may contain colons, commas, quotes and semicolons", () => {
    const value = `default-src 'self'; img-src "a:b", c: d`;
    const parsed = lib.parseHeadersFile(
      `/*\n  Content-Security-Policy: ${value}\n`,
    );
    expect(parsed[0]?.headers).toEqual([["Content-Security-Policy", value]]);
  });

  it("preserves unicode in values", () => {
    const parsed = lib.parseHeadersFile("/*\n  X-Note: caffè ☕ 日本\n");
    expect(parsed[0]?.headers).toEqual([["X-Note", "caffè ☕ 日本"]]);
  });

  it("trims surrounding whitespace from name and value", () => {
    const parsed = lib.parseHeadersFile("/*\n\t  X-A:   padded value   \n");
    expect(parsed[0]?.headers).toEqual([["X-A", "padded value"]]);
  });

  it("throws naming the 1-based line when an indented line precedes any pattern", () => {
    expect(() => lib.parseHeadersFile("\n  X-A: 1\n/*\n")).toThrowError(
      /\b2\b/,
    );
    expect(() => lib.parseHeadersFile("\n  X-A: 1\n/*\n")).toThrowError(
      lib.HeadersParseError,
    );
  });

  it("exports HeadersParseError as a named Error subclass", () => {
    const error = new lib.HeadersParseError("m");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HeadersParseError");
  });

  describe("constructs this tool cannot evaluate", () => {
    it.each([
      ["/a/*/b/*", "/*\n  X-A: 1\n\n/a/*/b/*\n  X-B: 2\n", 4, /\*|splat/i],
      [
        "a placeholder",
        "/*\n  X-A: 1\n/blog/:slug\n  X-B: 2\n",
        3,
        /:|placeholder/i,
      ],
      [
        "a host pattern",
        "https://:sub.example.com/*\n  X-B: 2\n",
        1,
        /:|host|placeholder/i,
      ],
      [
        "a detach header",
        "/*\n  X-A: 1\n  ! Content-Security-Policy\n",
        3,
        /!|detach/i,
      ],
      [
        "a :splat value",
        "/*\n  X-A: 1\n  Link: </x/:splat>; rel=preload\n",
        3,
        /:splat|splat/i,
      ],
    ] as [string, string, number, RegExp][])(
      "throws a HeadersParseError for %s naming the 1-based line",
      (_label, text, line, construct) => {
        let thrown: unknown;
        try {
          lib.parseHeadersFile(text);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(lib.HeadersParseError);
        const message = (thrown as Error).message;
        expect(message).toMatch(new RegExp(`\\b${String(line)}\\b`));
        expect(message).toMatch(construct);
      },
    );

    it("still parses a single-star pattern and ordinary headers", () => {
      expect(() =>
        lib.parseHeadersFile("/*.jpg\n  Cache-Control: public\n"),
      ).not.toThrow();
    });
  });

  it("throws naming the 1-based line when an indented line has no ': ' separator", () => {
    const text = "/*\n  X-A: 1\n  broken-line\n";
    expect(() => lib.parseHeadersFile(text)).toThrowError(/\b3\b/);
  });

  it("treats 'Name:value' without a space as a missing separator", () => {
    expect(() => lib.parseHeadersFile("/*\n  X-A:1\n")).toThrowError(/\b2\b/);
  });
});

describe("expectedHeadersFor", () => {
  const blocks: HeaderBlock[] = [
    {
      pattern: "/*",
      headers: [
        ["X-Global", "g"],
        ["Cache-Control", "no"],
      ],
    },
    {
      pattern: "/assets/source/fonts/*",
      headers: [["Cache-Control", "immutable"]],
    },
    { pattern: "/exact", headers: [["X-Exact", "e"]] },
  ];

  it("matches /* against the root path and lower-cases keys", () => {
    expect(lib.expectedHeadersFor(blocks, "/")).toEqual({
      "x-global": "g",
      "cache-control": "no",
    });
  });

  it("joins values of the same header from several blocks in file order with ', '", () => {
    const got = lib.expectedHeadersFor(blocks, "/assets/source/fonts/a.woff2");
    expect(got).toEqual({
      "x-global": "g",
      "cache-control": "no, immutable",
    });
  });

  it("joins same-named headers case-insensitively", () => {
    const joined: HeaderBlock[] = [
      { pattern: "/*", headers: [["cache-control", "no-cache"]] },
      {
        pattern: "/assets/*",
        headers: [["Cache-Control", "public, max-age=60"]],
      },
    ];
    expect(lib.expectedHeadersFor(joined, "/assets/x.css")).toEqual({
      "cache-control": "no-cache, public, max-age=60",
    });
    expect(lib.expectedHeadersFor(joined, "/")).toEqual({
      "cache-control": "no-cache",
    });
  });

  it("does not match a prefix pattern for a path outside it", () => {
    const got = lib.expectedHeadersFor(blocks, "/assets/other.css");
    expect(got["cache-control"]).toBe("no");
  });

  describe("single-star pattern matching", () => {
    const match = (pattern: string, path: string): boolean =>
      "x-m" in
      lib.expectedHeadersFor([{ pattern, headers: [["X-M", "1"]] }], path);

    it.each([
      ["/*", "/", true],
      ["/*", "/a/b/c", true],
      ["/assets/*", "/assets/a/b.css", true],
      ["/assets/*", "/assets/", true],
      ["/assets/*", "/other/a.css", false],
      ["/*.jpg", "/a/b.jpg", true],
      ["/*.jpg", "/.jpg", true],
      ["/*.jpg", "/a/b.png", false],
      ["/*.jpg", "/a/b.jpg.txt", false],
      ["/docs/*/index", "/docs/x/index", true],
      ["/docs/*/index", "/docs//index", true],
      ["/docs/*/index", "/docs/x/y/index", true],
      ["/docs/*/index", "/docs/x/other", false],
      ["/exact", "/exact", true],
      ["/exact", "/exactly", false],
      ["/a.b", "/axb", false],
      ["/a.b", "/a.b", true],
      ["/a+b*", "/a+bcd", true],
      ["/a+b*", "/aab", false],
      ["/(x)*", "/(x)y", true],
      ["/(x)*", "/xy", false],
      ["/*.(js)", "/a.(js)", true],
      ["/*.(js)", "/a.js", false],
    ])("pattern %s against %s -> %s", (pattern, path, expected) => {
      expect(match(pattern, path)).toBe(expected);
    });

    it("does not let a prefix and suffix overlap on a short path", () => {
      expect(match("/ab*bc", "/abc")).toBe(false);
      expect(match("/ab*bc", "/abbc")).toBe(true);
    });
  });

  it("matches a no-star pattern only against the identical path", () => {
    expect(lib.expectedHeadersFor(blocks, "/exact")["x-exact"]).toBe("e");
    expect(
      lib.expectedHeadersFor(blocks, "/exact/")["x-exact"],
    ).toBeUndefined();
    expect(
      lib.expectedHeadersFor(blocks, "/exact2")["x-exact"],
    ).toBeUndefined();
  });

  it("distinguishes the prefix path with and without a trailing slash", () => {
    const fonts = [
      { pattern: "/assets/source/fonts/*", headers: [["X-F", "1"]] },
    ] as HeaderBlock[];
    expect(lib.expectedHeadersFor(fonts, "/assets/source/fonts/")).toEqual({
      "x-f": "1",
    });
    expect(lib.expectedHeadersFor(fonts, "/assets/source/fonts")).toEqual({});
  });

  it("returns an empty record for no blocks", () => {
    expect(lib.expectedHeadersFor([], "/")).toEqual({});
  });

  it("skips a matching block that has no headers", () => {
    expect(
      lib.expectedHeadersFor([{ pattern: "/*", headers: [] }], "/x"),
    ).toEqual({});
  });
});

describe("diffHeaders", () => {
  it("returns [] when every expected header matches exactly", () => {
    const actual = new Headers({ "X-A": "1", "x-b": "two" });
    expect(lib.diffHeaders({ "x-a": "1", "x-b": "two" }, actual)).toEqual([]);
  });

  it("ignores extra headers on the actual side", () => {
    const actual = new Headers({ "x-a": "1", server: "cloudflare" });
    expect(lib.diffHeaders({ "x-a": "1" }, actual)).toEqual([]);
  });

  it("returns [] for no expectations", () => {
    expect(lib.diffHeaders({}, new Headers())).toEqual([]);
  });

  it("reports a missing header naming it and the word 'missing'", () => {
    const out = lib.diffHeaders({ "x-a": "1" }, new Headers());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("x-a");
    expect(out[0]).toContain("missing");
  });

  it("reports a differing value naming header, expected and actual", () => {
    const out = lib.diffHeaders(
      { "x-a": "expected-v" },
      new Headers({ "x-a": "actual-v" }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("x-a");
    expect(out[0]).toContain("expected-v");
    expect(out[0]).toContain("actual-v");
  });

  it("uses exact string equality (case and whitespace matter)", () => {
    expect(
      lib.diffHeaders({ "x-a": "Value" }, new Headers({ "x-a": "value" })),
    ).toHaveLength(1);
  });

  it("returns one message per mismatched header", () => {
    const out = lib.diffHeaders(
      { "x-a": "1", "x-b": "2", "x-c": "3" },
      new Headers({ "x-a": "1", "x-b": "nope" }),
    );
    expect(out).toHaveLength(2);
  });

  it("flags a drifted strict-transport-security (preload / 15552000)", () => {
    const out = lib.diffHeaders(
      { "strict-transport-security": "max-age=31536000; includeSubDomains" },
      new Headers({
        "Strict-Transport-Security":
          "max-age=15552000; includeSubDomains; preload",
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("strict-transport-security");
    expect(out[0]).toContain("max-age=31536000; includeSubDomains");
    expect(out[0]).toContain("max-age=15552000; includeSubDomains; preload");
  });
});

describe("pageUrlPath", () => {
  it.each([
    ["index.html", "/"],
    ["CONTRIBUTING.html", "/CONTRIBUTING"],
    ["docs/glossary.html", "/docs/glossary"],
    ["assets/tokens.css", "/assets/tokens.css"],
    ["docs\\glossary.html", "/docs/glossary"],
    ["assets\\fonts\\a.woff2", "/assets/fonts/a.woff2"],
    ["/docs/glossary.html", "/docs/glossary"],
  ])("maps %s to %s", (input, expected) => {
    expect(lib.pageUrlPath(input)).toBe(expected);
  });
});

describe("firstDifference", () => {
  it("returns null for identical strings", () => {
    expect(lib.firstDifference("a\nb\n", "a\nb\n")).toBeNull();
    expect(lib.firstDifference("", "")).toBeNull();
  });

  it("reports the 1-based first differing line with both texts", () => {
    expect(lib.firstDifference("a\nb\nc", "a\nX\nc")).toEqual({
      line: 2,
      expected: "b",
      actual: "X",
    });
  });

  it("reports the first line when it differs", () => {
    expect(lib.firstDifference("a", "b")).toEqual({
      line: 1,
      expected: "a",
      actual: "b",
    });
  });

  it("reports the first line past the shorter text with an empty missing side", () => {
    expect(lib.firstDifference("a\nb", "a\nb\nc")).toEqual({
      line: 3,
      expected: "",
      actual: "c",
    });
    expect(lib.firstDifference("a\nb\nc", "a\nb")).toEqual({
      line: 3,
      expected: "c",
      actual: "",
    });
  });

  it("counts a trailing-newline-only difference as a difference", () => {
    const diff = lib.firstDifference("a\n", "a");
    expect(diff).not.toBeNull();
    expect(diff?.line).toBe(2);
  });

  it("truncates long lines to at most 120 characters plus '...'", () => {
    const long = "x".repeat(300);
    const diff = lib.firstDifference(long, "short");
    expect(diff?.expected).toBe(`${"x".repeat(120)}...`);
    expect(diff?.actual).toBe("short");
  });

  it("does not truncate a line of exactly 120 characters", () => {
    const exact = "y".repeat(120);
    const diff = lib.firstDifference(exact, "z");
    expect(diff?.expected).toBe(exact);
  });
});

describe("diffMetadata", () => {
  const agree: [PkgMeta, RepoMeta] = [
    { description: "d", homepage: "https://h", keywords: ["a", "b"] },
    { description: "d", homepage: "https://h", topics: ["b", "a"] },
  ];

  it("returns [] when all three fields agree (keywords order-insensitive)", () => {
    expect(lib.diffMetadata(...agree)).toEqual([]);
  });

  it("ignores duplicates when comparing keywords as sets", () => {
    expect(
      lib.diffMetadata(
        { description: "d", keywords: ["a", "a", "b"] },
        { description: "d", topics: ["b", "a"] },
      ),
    ).toEqual([]);
  });

  it("treats null, undefined and empty homepage as equal", () => {
    expect(lib.diffMetadata({ homepage: "" }, { homepage: null })).toEqual([]);
    expect(lib.diffMetadata({}, { homepage: "" })).toEqual([]);
    expect(
      lib.diffMetadata({ homepage: undefined }, { homepage: null }),
    ).toEqual([]);
  });

  it("reports a description mismatch naming the field only", () => {
    const out = lib.diffMetadata(
      { description: "one", keywords: [] },
      { description: "two", topics: [] },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("description");
  });

  it("reports a homepage mismatch, including one side empty", () => {
    const out = lib.diffMetadata({ homepage: "https://h" }, { homepage: null });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("homepage");
  });

  it("reports keywords entries present on only one side", () => {
    const out = lib.diffMetadata(
      { keywords: ["shared", "pkg-only"] },
      { topics: ["shared", "repo-only"] },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("keywords");
    expect(out[0]).toContain("pkg-only");
    expect(out[0]).toContain("repo-only");
    expect(out[0]).not.toContain("shared");
  });

  it("returns one message per differing field", () => {
    const out = lib.diffMetadata(
      { description: "a", homepage: "h", keywords: ["k"] },
      { description: "b", homepage: "i", topics: ["t"] },
    );
    expect(out).toHaveLength(3);
    expect(out.some((m) => m.includes("description"))).toBe(true);
    expect(out.some((m) => m.includes("homepage"))).toBe(true);
    expect(out.some((m) => m.includes("keywords"))).toBe(true);
  });

  it("treats missing keywords/topics as empty sets", () => {
    expect(lib.diffMetadata({}, {})).toEqual([]);
  });
});

describe("integration with buildHeadersFile", () => {
  const text = siteHeaders.buildHeadersFile({
    scriptHash: "sha256-abc=",
    imageHosts: ["img.shields.io"],
  });
  const blocks = lib.parseHeadersFile(text);

  it("yields the security headers for / and no cache-control", () => {
    const got = lib.expectedHeadersFor(blocks, "/");
    for (const name of [
      "content-security-policy",
      "strict-transport-security",
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
      "cross-origin-opener-policy",
    ]) {
      expect(got, name).toHaveProperty(name);
    }
    expect(got).not.toHaveProperty("cache-control");
  });

  it("adds immutable cache-control for fonts", () => {
    const got = lib.expectedHeadersFor(blocks, "/assets/source/fonts/x.woff2");
    expect(got["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(got).toHaveProperty("content-security-policy");
  });
});
