#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Builds this repo's own docs site: README (as `index.html`), CONTRIBUTING,
 * SECURITY, GOVERNANCE, ROADMAP, CODE_OF_CONDUCT, and four `docs/*.md`
 * pages, rendered by `bin/lib/markdown.mjs` and styled with the vendored
 * m3l-design tokens and components (`design/tokens.css`,
 * `design/source/components/bundle.css`, `design/local/site.css` -- the
 * one docs-site-specific layout divergence `design/README.md`'s
 * "design/local/" section reserves for exactly this). `docs/research/*` is
 * deliberately excluded (internal trackers, not reader-facing pages).
 *
 * `node bin/build-docs.mjs --out <dir>` writes the site there. `--check`
 * instead builds to a throwaway temp directory and fails, without writing
 * `--out`, on any internal link or same-page/cross-page anchor this build
 * cannot resolve (including an anchor into a non-page repo file, such as
 * `CLAUDE.md#some-heading`), a disallowed link scheme, or an italic
 * `_x_`/`*x*` emphasis span surviving in one of `PAGES`' sources --
 * registered as the `docs` step in `bin/lib/verify-steps.mjs`'s `build`
 * group.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  copyFile,
  cp,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  renderMarkdown,
  extractHeadings,
  escapeHtml,
  MarkdownError,
} from "./lib/markdown.mjs";
import { repoRoot } from "./lib/report.mjs";

const REPO_URL = "https://github.com/monte3l/m3l-groundwork";
const REPO_BRANCH = "main";
const SITE_TITLE = "m3l-groundwork";
const ALLOWED_HREF_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * The pages this site renders. `src` is repo-root-relative (POSIX); `out`
 * is the site-relative output path. `group` drives the sidebar's four
 * sections; their fixed order is `NAV_GROUPS` below.
 */
const PAGES = [
  { src: "README.md", out: "index.html", group: "Start", label: "Overview" },
  {
    src: "CONTRIBUTING.md",
    out: "CONTRIBUTING.html",
    group: "Project",
    label: "Contributing",
  },
  {
    src: "GOVERNANCE.md",
    out: "GOVERNANCE.html",
    group: "Project",
    label: "Governance",
  },
  {
    src: "ROADMAP.md",
    out: "ROADMAP.html",
    group: "Project",
    label: "Roadmap",
  },
  {
    src: "CODE_OF_CONDUCT.md",
    out: "CODE_OF_CONDUCT.html",
    group: "Project",
    label: "Code of Conduct",
  },
  {
    src: "SECURITY.md",
    out: "SECURITY.html",
    group: "Security",
    label: "Security policy",
  },
  {
    src: "docs/assurance-case.md",
    out: "docs/assurance-case.html",
    group: "Security",
    label: "Assurance case",
  },
  {
    src: "docs/security-review.md",
    out: "docs/security-review.html",
    group: "Security",
    label: "Security review",
  },
  {
    src: "docs/architecture.md",
    out: "docs/architecture.html",
    group: "Internals",
    label: "Architecture",
  },
  {
    src: "docs/glossary.md",
    out: "docs/glossary.html",
    group: "Internals",
    label: "Glossary",
  },
];
const NAV_GROUPS = ["Start", "Project", "Security", "Internals"];

const EXTERNAL_HREF_RE = /^([a-z][a-z0-9+.-]*:|#)/i;
const HREF_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function splitFragment(href) {
  const i = href.indexOf("#");
  return i === -1 ? [href, ""] : [href.slice(0, i), href.slice(i + 1)];
}

/**
 * Headings of a repo `.md` file that isn't one of `PAGES`, read and cached
 * lazily so a repeated `CLAUDE.md#anchor`-shaped link across many pages
 * reads and re-parses that file only once per build.
 */
function nonPageHeadings(root, targetSrc, cache) {
  if (cache.has(targetSrc)) return cache.get(targetSrc);
  const abs = path.join(root, targetSrc);
  const slugs = existsSync(abs)
    ? new Set(extractHeadings(readFileSync(abs, "utf8")).map((h) => h.slug))
    : null;
  cache.set(targetSrc, slugs);
  return slugs;
}

/**
 * Resolves one raw markdown href found on `page` into the href this site
 * should actually emit: unchanged for an external URL or a bare same-page
 * `#anchor`; a relative path to another page's output file (rewritten
 * `.md` -> `.html`) when it points at one of `PAGES`; a `blob/main/<path>`
 * GitHub URL for any other repo file (`CLAUDE.md`, `LICENSE`,
 * `templates/packs/README.md`, a `.github/**` file, ...). Under `check`,
 * every case that can be wrong -- a same-page anchor with no matching
 * heading, a cross-page anchor, an anchor into a non-page `.md` file that
 * doesn't exist there, a disallowed link scheme, or a repo path that
 * doesn't exist at all -- is verified and appended to `problems` rather
 * than thrown, so one run reports every broken link across the whole site
 * at once.
 */
function resolveHref(
  href,
  page,
  { root, headingIndex, nonPageHeadingCache, problems, check },
) {
  if (EXTERNAL_HREF_RE.test(href)) {
    if (!check) return href;
    if (href.startsWith("#")) {
      const frag = href.slice(1);
      if (frag !== "" && !headingIndex.get(page.src).has(frag)) {
        problems.push(`${page.src}: broken same-page anchor "${href}"`);
      }
    } else {
      const scheme = HREF_SCHEME_RE.exec(href)?.[0]?.toLowerCase();
      if (!scheme || !ALLOWED_HREF_SCHEMES.has(scheme)) {
        problems.push(`${page.src}: disallowed link scheme in "${href}"`);
      }
    }
    return href;
  }

  const [rawPath, frag] = splitFragment(href);
  const targetSrc = path.posix.join(path.posix.dirname(page.src), rawPath);
  const targetPage = PAGES.find((candidate) => candidate.src === targetSrc);

  if (targetPage) {
    if (check && frag && !headingIndex.get(targetPage.src).has(frag)) {
      problems.push(
        `${page.src}: broken anchor "${href}" (no #${frag} heading on ${targetPage.src})`,
      );
    }
    const rel = path.posix.relative(
      path.posix.dirname(page.out),
      targetPage.out,
    );
    return frag ? `${rel}#${frag}` : rel;
  }

  if (check) {
    if (targetSrc.startsWith("..")) {
      problems.push(
        `${page.src}: link target escapes the repository: "${targetSrc}"`,
      );
    } else if (!existsSync(path.join(root, targetSrc))) {
      problems.push(
        `${page.src}: link target does not exist in the repo: "${targetSrc}"`,
      );
    } else if (frag) {
      if (!targetSrc.endsWith(".md")) {
        problems.push(
          `${page.src}: cannot verify anchor "#${frag}" on non-markdown "${targetSrc}"`,
        );
      } else {
        const slugs = nonPageHeadings(root, targetSrc, nonPageHeadingCache);
        if (!slugs?.has(frag)) {
          problems.push(
            `${page.src}: broken anchor "${href}" (no #${frag} heading on ${targetSrc})`,
          );
        }
      }
    }
  }
  return `${REPO_URL}/blob/${REPO_BRANCH}/${targetSrc}${frag ? `#${frag}` : ""}`;
}

async function readSources(root) {
  const sources = new Map();
  for (const page of PAGES) {
    sources.set(page.src, await readFile(path.join(root, page.src), "utf8"));
  }
  return sources;
}

function buildHeadingIndex(sources) {
  const index = new Map();
  for (const page of PAGES) {
    index.set(
      page.src,
      new Set(extractHeadings(sources.get(page.src)).map((h) => h.slug)),
    );
  }
  return index;
}

/** Renders every page. Returns the rendered HTML/headings per page, plus every broken-link and stray-italic finding across the whole site. */
function renderSite(root, sources, check) {
  const headingIndex = buildHeadingIndex(sources);
  const nonPageHeadingCache = new Map();
  const problems = [];
  const italics = [];
  const rendered = new Map();
  for (const page of PAGES) {
    const resolveLink = (href) =>
      resolveHref(href, page, {
        root,
        headingIndex,
        nonPageHeadingCache,
        problems,
        check,
      });
    let result;
    try {
      result = renderMarkdown(sources.get(page.src), { resolveLink });
    } catch (cause) {
      if (cause instanceof MarkdownError) {
        throw new MarkdownError(`${page.src}: ${cause.message}`, { cause });
      }
      throw cause;
    }
    for (const span of result.italics) {
      italics.push(`${page.src}: ${span}`);
    }
    rendered.set(page.src, result);
  }
  return { rendered, problems, italics };
}

function pageTitle(page, headings) {
  return headings[0]?.level === 1 ? headings[0].text : page.label;
}

function renderTopNav(page) {
  const items = [
    { href: "index.html", label: "Docs" },
    { href: "SECURITY.html", label: "Security" },
    { href: `${REPO_URL}`, label: "GitHub" },
    { href: "https://www.npmjs.com/package/@monte3l/groundwork", label: "npm" },
  ];
  const links = items
    .map(({ href, label }) => {
      const current =
        href === "index.html" || href === "SECURITY.html"
          ? href === page.out
          : false;
      const rel = href.startsWith("http")
        ? href
        : path.posix.relative(path.posix.dirname(page.out), href);
      const aria = current ? ` aria-current="page"` : "";
      return `<li><a class="m3l-nav__link body" href="${escapeHtml(rel)}"${aria}>${escapeHtml(label)}</a></li>`;
    })
    .join("");
  return `<nav class="m3l-nav" data-orientation="horizontal" aria-label="Site"><ul class="m3l-nav__list">${links}</ul></nav>`;
}

function renderSidebar(page) {
  const groups = NAV_GROUPS.map((group) => {
    const groupId = `nav-${group.toLowerCase()}`;
    const items = PAGES.filter((candidate) => candidate.group === group)
      .map((candidate) => {
        const rel = path.posix.relative(
          path.posix.dirname(page.out),
          candidate.out,
        );
        const aria = candidate.src === page.src ? ` aria-current="page"` : "";
        return `<li><a class="m3l-nav__link body" href="${escapeHtml(rel)}"${aria}>${escapeHtml(candidate.label)}</a></li>`;
      })
      .join("");
    return `<p class="m3l-nav__group label" id="${groupId}">${group}</p><ul class="m3l-nav__list" aria-labelledby="${groupId}">${items}</ul>`;
  }).join("");
  return `<nav class="m3l-nav m3l-site-sidebar" aria-label="Docs">${groups}</nav>`;
}

const THEME_TOGGLE_SCRIPT = `(function () {
  var root = document.documentElement;
  try {
    var stored = localStorage.getItem("m3l-theme");
    if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);
  } catch (_error) {}
  var button = document.getElementById("m3l-theme-toggle");
  if (!button) return;
  button.addEventListener("click", function () {
    var prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
    var current = root.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
    var next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("m3l-theme", next);
    } catch (_error) {}
  });
})();`;

function renderPage(page, rendered) {
  const { html, headings } = rendered.get(page.src);
  const title = pageTitle(page, headings);
  const depth = page.out.split("/").length - 1;
  const assetPrefix = depth === 0 ? "assets" : "../".repeat(depth) + "assets";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(SITE_TITLE)}</title>
<link rel="stylesheet" href="${assetPrefix}/tokens.css">
<link rel="stylesheet" href="${assetPrefix}/source/components/bundle.css">
<link rel="stylesheet" href="${assetPrefix}/local/site.css">
</head>
<body>
<header class="m3l-site-header">
${renderTopNav(page)}
<button type="button" id="m3l-theme-toggle" class="m3l-button label" data-variant="ghost">Toggle theme</button>
</header>
<div class="m3l-site-layout">
${renderSidebar(page)}
<main class="m3l-site-main">
<article class="m3l-prose">
${html}
</article>
</main>
</div>
<script>${THEME_TOGGLE_SCRIPT}</script>
</body>
</html>
`;
}

async function copyAssets(root, outDir) {
  const assetsDir = path.join(outDir, "assets");
  await mkdir(path.join(assetsDir, "source", "components"), {
    recursive: true,
  });
  await mkdir(path.join(assetsDir, "source", "fonts"), { recursive: true });
  await mkdir(path.join(assetsDir, "local"), { recursive: true });
  await copyFile(
    path.join(root, "design/tokens.css"),
    path.join(assetsDir, "tokens.css"),
  );
  await copyFile(
    path.join(root, "design/source/components/bundle.css"),
    path.join(assetsDir, "source/components/bundle.css"),
  );
  await copyFile(
    path.join(root, "design/local/site.css"),
    path.join(assetsDir, "local/site.css"),
  );
  await cp(
    path.join(root, "design/source/fonts"),
    path.join(assetsDir, "source/fonts"),
    {
      recursive: true,
    },
  );
}

async function writeSite(root, outDir, rendered) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyAssets(root, outDir);
  for (const page of PAGES) {
    const html = renderPage(page, rendered);
    const target = path.join(outDir, page.out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, html, "utf8");
  }
}

async function main() {
  const root = repoRoot();
  const check = process.argv.includes("--check");
  const outIndex = process.argv.indexOf("--out");
  const requestedOut = outIndex === -1 ? null : process.argv[outIndex + 1];

  if (!check && !requestedOut) {
    console.error(
      "build-docs: pass --out <dir>, or --check to validate without writing",
    );
    process.exitCode = 1;
    return;
  }

  const sourceTexts = await readSources(root);
  const { rendered, problems, italics } = renderSite(root, sourceTexts, check);

  if (check) {
    if (italics.length > 0) {
      console.error(
        "fail  italic emphasis found in a docs-site source (use **bold** instead):",
      );
      for (const span of italics) console.error(`      ${span}`);
    }
    if (problems.length > 0) {
      console.error("fail  broken internal link(s):");
      for (const problem of problems) console.error(`      ${problem}`);
    }
    if (italics.length > 0 || problems.length > 0) {
      process.exitCode = 1;
      return;
    }
    const tmpDir = await mkdtemp(path.join(tmpdir(), "m3l-docs-check-"));
    try {
      await writeSite(root, tmpDir, rendered);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    console.log(
      "  ok  docs site builds cleanly, every internal link and anchor resolves",
    );
    return;
  }

  const outDir = path.isAbsolute(requestedOut)
    ? requestedOut
    : path.join(root, requestedOut);
  await writeSite(root, outDir, rendered);
  const relOut = path.relative(root, outDir);
  const label = relOut.startsWith("..") ? outDir : `${relOut}/`;
  console.log(`wrote ${label}`);
}

await main();
