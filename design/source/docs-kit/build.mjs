#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * The monte3l docs-site builder. It renders a repository's Markdown (and any
 * generated pages) into a static site styled with the vendored m3l-design
 * tokens and components, and gates that site against the repository.
 *
 *   node <design>/source/docs-kit/build.mjs [--config docs.config.mjs] --out <dir>
 *   node <design>/source/docs-kit/build.mjs [--config docs.config.mjs] --check
 *
 * `--out` writes the site. `--check` writes nothing and exits 1, listing every
 * problem at once, on: an unresolved link or anchor, a disallowed link scheme,
 * an italic span, unsupported Markdown, a `_headers` file over Cloudflare's
 * limits, tracked Markdown that is neither a page nor excluded, a stale
 * `pages`/`exclude` entry, a `SHA256SUMS` mismatch, a design marker that is
 * not the vendored tier, a literal in a local stylesheet, more than two
 * alerts in a row, a manifest `homepage` that is not the site URL, or any
 * message from a project parity module. Exit 2 is a bad command line or
 * config. The contract is in `README.md` next to this file.
 */
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  alertRunProblems,
  homepageProblems,
  localCssProblems,
  markerProblems,
  pageCoverageProblems,
  shaSumsProblems,
} from "./lib/checks.mjs";
import { ConfigError, loadConfig } from "./lib/config.mjs";
import { MarkdownError, escapeHtml, extractHeadings, renderMarkdown } from "./lib/markdown.mjs";
import { buildHeadersFile, externalImageHosts, hashInlineScript } from "./lib/site-headers.mjs";

const KIT_DIR = import.meta.dirname;
const REPO_BRANCH = "main";
const ALLOWED_HREF_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const EXTERNAL_HREF_RE = /^([a-z][a-z0-9+.-]*:|#)/i;
const HREF_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function splitFragment(href) {
  const i = href.indexOf("#");
  return i === -1 ? [href, ""] : [href.slice(0, i), href.slice(i + 1)];
}

/** Headings of a repo `.md` that is not a page, read once per build. */
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
 * Resolves one Markdown href found on `page` into the href the site emits: an
 * external URL or bare `#anchor` unchanged; a relative `.html` path when it
 * points at another Markdown page; a `blob/main/<path>` GitHub URL for any
 * other repo file. Under `check`, every way that can be wrong is appended to
 * `problems` instead of thrown, so one run reports the whole site.
 */
function resolveHref(href, page, { config, mdPages, headingIndex, nonPageHeadingCache, problems, check }) {
  const { root, repo } = config;
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
  const targetPage = mdPages.find((candidate) => candidate.src === targetSrc);

  if (targetPage) {
    if (check && frag && !headingIndex.get(targetPage.src).has(frag)) {
      problems.push(`${page.src}: broken anchor "${href}" (no #${frag} heading on ${targetPage.src})`);
    }
    const rel = path.posix.relative(path.posix.dirname(page.out), targetPage.out);
    return frag ? `${rel}#${frag}` : rel;
  }

  if (check) {
    if (targetSrc.startsWith("..")) {
      problems.push(`${page.src}: link target escapes the repository: "${targetSrc}"`);
    } else if (!existsSync(path.join(root, targetSrc))) {
      problems.push(`${page.src}: link target does not exist in the repo: "${targetSrc}"`);
    } else if (frag) {
      if (!targetSrc.endsWith(".md")) {
        problems.push(`${page.src}: cannot verify anchor "#${frag}" on non-markdown "${targetSrc}"`);
      } else if (!nonPageHeadings(root, targetSrc, nonPageHeadingCache)?.has(frag)) {
        problems.push(`${page.src}: broken anchor "${href}" (no #${frag} heading on ${targetSrc})`);
      }
    }
  }
  return `${repo}/blob/${REPO_BRANCH}/${targetSrc}${frag ? `#${frag}` : ""}`;
}

/** Renders every Markdown page; returns the HTML per page plus all findings. */
async function renderMarkdownPages(config, mdPages, check) {
  const sources = new Map();
  const unreadable = [];
  for (const page of mdPages) {
    try {
      sources.set(page.src, await readFile(path.join(config.root, page.src), "utf8"));
    } catch {
      unreadable.push(`pages: cannot read "${page.src}"`);
    }
  }
  if (unreadable.length > 0) throw new ConfigError(unreadable.join("\n"));
  const headingIndex = new Map(
    mdPages.map((page) => [page.src, new Set(extractHeadings(sources.get(page.src)).map((h) => h.slug))]),
  );
  const nonPageHeadingCache = new Map();
  const problems = [];
  const italics = [];
  const rendered = new Map();
  for (const page of mdPages) {
    const resolveLink = (href) =>
      resolveHref(href, page, { config, mdPages, headingIndex, nonPageHeadingCache, problems, check });
    let result;
    try {
      result = renderMarkdown(sources.get(page.src), { resolveLink });
    } catch (cause) {
      if (cause instanceof MarkdownError) {
        throw new MarkdownError(`${page.src}: ${cause.message}`, { cause });
      }
      throw cause;
    }
    for (const span of new Set(result.italics)) italics.push(`${page.src}: ${span}`);
    rendered.set(page.src, result);
  }
  return { sources, rendered, problems, italics };
}

/**
 * Runs the config's `generators`. Each default-exports
 * `async ({ root, config }) => [{ out, group, label, html }]`: a page that
 * cannot come from Markdown. The HTML must already be the `<article>` body;
 * `--check` still verifies its links and anchors.
 */
async function runGenerators(config) {
  const pages = [];
  for (const rel of config.generators ?? []) {
    const module = await import(pathToFileURL(path.join(config.root, rel)).href);
    for (const page of await module.default({ root: config.root, config })) {
      pages.push({ ...page, src: `generated:${page.out}`, generated: true });
    }
  }
  return pages;
}

function generatedPageProblems(page, rendered, allPages) {
  const problems = [];
  const ids = new Set([...page.html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, href] of page.html.matchAll(/\shref="([^"]*)"/g)) {
    if (EXTERNAL_HREF_RE.test(href) && !href.startsWith("#")) {
      const scheme = HREF_SCHEME_RE.exec(href)?.[0]?.toLowerCase();
      if (!ALLOWED_HREF_SCHEMES.has(scheme)) problems.push(`${page.out}: disallowed link scheme in "${href}"`);
      continue;
    }
    const [rawPath, frag] = splitFragment(href);
    if (rawPath === "") {
      if (frag && !ids.has(frag)) problems.push(`${page.out}: broken same-page anchor "${href}"`);
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.out), rawPath));
    const targetPage = allPages.find((candidate) => candidate.out === target);
    if (!targetPage) {
      problems.push(`${page.out}: link target is not a page of this site: "${href}"`);
    } else if (frag) {
      const slugs = new Set(rendered.get(targetPage.src).headings.map((h) => h.slug));
      if (!slugs.has(frag)) problems.push(`${page.out}: broken anchor "${href}" (no #${frag} on ${targetPage.out})`);
    }
  }
  return problems;
}

/**
 * The text content of an HTML fragment: everything outside `<...>`. A `<` always
 * opens a tag and only a `>` closes it, so no `<` can reach the output and a
 * nested or unclosed tag cannot leave markup behind.
 */
function textOfHtml(html) {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function headingsOfHtml(html) {
  return [...html.matchAll(/<h([1-3])[^>]*\sid="([^"]+)"[^>]*>(.*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    slug: m[2],
    text: textOfHtml(m[3]),
  }));
}

function pageTitle(page, headings) {
  return headings[0]?.level === 1 ? headings[0].text : page.label;
}

/** The `<title>`: the page title and the site name, or the name alone when they are the same (the home page). */
function documentTitle(title, siteTitle) {
  return title === siteTitle ? title : `${title} · ${siteTitle}`;
}

/** Href from `page` to site-relative `target`; the 404 page links from the root. */
function pageHref(page, target) {
  return page.absolute ? `/${target}` : path.posix.relative(path.posix.dirname(page.out), target);
}

/** The files `brand: true` copies from `<designDir>/source/brand/` into the site's `assets/brand/`. */
const BRAND_FILES = [
  "favicon/favicon.ico",
  "favicon/favicon.svg",
  "favicon/apple-touch-icon.png",
  "logo/symbol-light.svg",
  "logo/symbol-dark.svg",
];

/** One message per brand file the design directory lacks, for a config with `brand: true`. */
function brandProblems(config) {
  if (!config.brand) return [];
  const dir = path.join(config.root, config.designDir, "source/brand");
  return BRAND_FILES.filter((rel) => !existsSync(path.join(dir, rel))).map(
    (rel) => `"brand" is true but ${config.designDir}/source/brand/${rel} is missing (sync m3l-design v1.2.0 or later)`,
  );
}

/** The favicon links: the ICO first with sizes="any", then the adaptive SVG, as web.dev recommends. */
function renderBrandHead(assetPrefix) {
  return `
<link rel="icon" href="${assetPrefix}/brand/favicon/favicon.ico" sizes="any">
<link rel="icon" href="${assetPrefix}/brand/favicon/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${assetPrefix}/brand/favicon/apple-touch-icon.png">`;
}

/**
 * The MONTE3L symbol, linking to the home page. Both themes are in the markup
 * and the stylesheet shows one, because an `<img>` cannot follow `data-theme`;
 * the hidden image is out of the accessibility tree, so the link has one name.
 */
function renderBrandLogo(page, assetPrefix) {
  const img = (theme) =>
    `<img class="m3l-site-brand__img m3l-site-brand__img--${theme}" src="${assetPrefix}/brand/logo/symbol-${theme}.svg" alt="MONTE3L" width="40" height="40">`;
  return `<a class="m3l-site-brand" href="${escapeHtml(pageHref(page, "index.html"))}">${img("light")}${img("dark")}</a>\n`;
}

function renderTopNav(config, page) {
  const items = config.nav ?? [
    { href: "index.html", label: "Docs" },
    { href: config.repo, label: "GitHub" },
  ];
  const links = items
    .map(({ href, label }) => {
      const external = /^https?:/.test(href);
      const rel = external ? href : pageHref(page, href);
      const aria = !external && href === page.out ? ` aria-current="page"` : "";
      return `<li><a class="m3l-nav__link body" href="${escapeHtml(rel)}"${aria}>${escapeHtml(label)}</a></li>`;
    })
    .join("");
  return `<nav class="m3l-nav" data-orientation="horizontal" aria-label="Site"><ul class="m3l-nav__list">${links}</ul></nav>`;
}

function renderSidebar(config, allPages, page) {
  const groups = config.navGroups
    .map((group) => {
      const groupId = `nav-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const items = allPages
        .filter((candidate) => candidate.group === group)
        .map((candidate) => {
          const rel = pageHref(page, candidate.out);
          const aria = candidate.src === page.src ? ` aria-current="page"` : "";
          return `<li><a class="m3l-nav__link body" href="${escapeHtml(rel)}"${aria}>${escapeHtml(candidate.label)}</a></li>`;
        })
        .join("");
      if (items === "") return "";
      return `<p class="m3l-nav__group label" id="${groupId}">${escapeHtml(group)}</p><ul class="m3l-nav__list" aria-labelledby="${groupId}">${items}</ul>`;
    })
    .join("");
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

function renderPage(config, allPages, localCss, page, rendered) {
  const { html, headings } = rendered.get(page.src);
  const title = pageTitle(page, headings);
  const depth = page.out.split("/").length - 1;
  const assetPrefix = page.absolute ? "/assets" : depth === 0 ? "assets" : "../".repeat(depth) + "assets";
  const locals = localCss.map((name) => `\n<link rel="stylesheet" href="${assetPrefix}/local/${name}">`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle(title, config.title))}</title>
<link rel="stylesheet" href="${assetPrefix}/tokens.css">
<link rel="stylesheet" href="${assetPrefix}/source/components/bundle.css">
<link rel="stylesheet" href="${assetPrefix}/kit/site.css">${locals}${config.brand ? renderBrandHead(assetPrefix) : ""}
</head>
<body>
<header class="m3l-site-header">
${config.brand ? renderBrandLogo(page, assetPrefix) : ""}${renderTopNav(config, page)}
<button type="button" id="m3l-theme-toggle" class="m3l-button label" data-variant="ghost">Toggle theme</button>
</header>
<div class="m3l-site-layout">
${renderSidebar(config, allPages, page)}
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

/** Served by `not_found_handling: "404-page"`; not a page of the site and never "current". */
const NOT_FOUND_PAGE = { src: "__404__", out: "404.html", label: "Not found", absolute: true };

function renderNotFoundPage(config, allPages, localCss) {
  const rendered = new Map([
    [
      NOT_FOUND_PAGE.src,
      {
        html: `<h1 id="page-not-found">Page not found</h1>\n<p>The page you're looking for doesn't exist. <a href="/">Return to the docs home</a>.</p>`,
        headings: [{ level: 1, text: "Page not found", slug: "page-not-found" }],
      },
    ],
  ]);
  return renderPage(config, allPages, localCss, NOT_FOUND_PAGE, rendered);
}

async function localCssFiles(config) {
  const dir = path.join(config.root, config.designDir, "local");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.endsWith(".css")).sort();
}

async function copyAssets(config, outDir, localCss) {
  const design = path.join(config.root, config.designDir);
  const assets = path.join(outDir, "assets");
  for (const sub of ["source/components", "source/fonts", "kit", ...(localCss.length > 0 ? ["local"] : [])]) {
    await mkdir(path.join(assets, sub), { recursive: true });
  }
  await copyFile(path.join(design, "tokens.css"), path.join(assets, "tokens.css"));
  await copyFile(path.join(design, "source/components/bundle.css"), path.join(assets, "source/components/bundle.css"));
  await copyFile(path.join(KIT_DIR, "site.css"), path.join(assets, "kit/site.css"));
  await cp(path.join(design, "source/fonts"), path.join(assets, "source/fonts"), { recursive: true });
  for (const name of localCss) {
    await copyFile(path.join(design, "local", name), path.join(assets, "local", name));
  }
  if (config.brand) {
    for (const rel of BRAND_FILES) {
      await mkdir(path.dirname(path.join(assets, "brand", rel)), { recursive: true });
      await copyFile(path.join(design, "source/brand", rel), path.join(assets, "brand", rel));
    }
  }
}

async function writeSite(config, allPages, outDir, rendered) {
  const localCss = await localCssFiles(config);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyAssets(config, outDir, localCss);
  for (const page of allPages) {
    const target = path.join(outDir, page.out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, renderPage(config, allPages, localCss, page, rendered), "utf8");
  }
  // Clients that ignore <link rel="icon"> (feed readers, crawlers) ask for /favicon.ico at the root.
  if (config.brand) {
    await copyFile(path.join(config.root, config.designDir, "source/brand/favicon/favicon.ico"), path.join(outDir, "favicon.ico"));
  }
  await writeFile(path.join(outDir, NOT_FOUND_PAGE.out), renderNotFoundPage(config, allPages, localCss), "utf8");
  const htmlPages = [...rendered.values()].map((page) => page.html);
  const headersText = buildHeadersFile({
    scriptHash: hashInlineScript(THEME_TOGGLE_SCRIPT),
    imageHosts: externalImageHosts(htmlPages),
  });
  await writeFile(path.join(outDir, "_headers"), headersText, "utf8");
}

function trackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    throw new ConfigError(`cannot list tracked files with git in ${root}: ${error.message}`);
  }
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every gate that is not rendering: coverage, design integrity, CSS, alerts, homepage, parity. */
async function repoProblems(config, sources) {
  const { root } = config;
  const designAbs = path.join(root, config.designDir);
  const isSourceRepo = config.designDir === ".";
  const problems = [...brandProblems(config)];

  const exclude = [...(config.exclude ?? [])];
  const tracked = trackedFiles(root);
  const vendored = `${config.designDir}/source/`;
  // The vendored payload is never the repo's own documentation, so it needs no entry.
  if (!isSourceRepo && tracked.some((file) => file.startsWith(vendored) && file.endsWith(".md"))) {
    exclude.push({ glob: `${vendored}**`, reason: "vendored m3l-design payload" });
  }
  problems.push(...pageCoverageProblems({ tracked, pages: config.pages, exclude }));

  problems.push(...(await shaSumsProblems(designAbs)));
  const marker = config.marker ?? `${config.designDir}/README.md`;
  const markerText = existsSync(path.join(root, marker)) ? await readFile(path.join(root, marker), "utf8") : null;
  problems.push(...markerProblems({ marker, text: markerText, isSourceRepo }));

  for (const name of await localCssFiles(config)) {
    const rel = `${config.designDir}/local/${name}`;
    problems.push(...localCssProblems(rel, await readFile(path.join(root, rel), "utf8")));
  }
  for (const [src, text] of sources) problems.push(...alertRunProblems(src, text));

  if (config.manifest) {
    problems.push(
      ...homepageProblems(await readJsonOrNull(path.join(root, config.manifest)), config.manifest, config.siteUrl),
    );
  }
  for (const rel of config.parity ?? []) {
    const module = await import(pathToFileURL(path.join(root, rel)).href);
    if (typeof module.default !== "function") {
      problems.push(`${rel}: a parity module must default-export an async function ({ root, config }) => string[]`);
      continue;
    }
    problems.push(...(await module.default({ root, config })).map((message) => `${rel}: ${message}`));
  }
  return problems;
}

function usage(message) {
  console.error(`docs-kit: ${message}`);
  console.error("usage: node build.mjs [--config <docs.config.mjs>] (--out <dir> | --check)");
  process.exitCode = 2;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const valueOf = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] ?? "");
  };
  const requestedOut = valueOf("--out");
  if (!check && !requestedOut) return usage("pass --out <dir>, or --check to validate without writing");
  if (check && requestedOut) return usage("--check and --out are exclusive");

  let config;
  try {
    config = await loadConfig(valueOf("--config") || "docs.config.mjs");
  } catch (error) {
    if (error instanceof ConfigError) return usage(error.message);
    throw error;
  }

  const mdPages = config.pages;
  let generated;
  try {
    generated = await runGenerators(config);
  } catch (error) {
    console.error(`fail  page generator: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  let pagesResult;
  try {
    pagesResult = await renderMarkdownPages(config, mdPages, check);
  } catch (error) {
    if (error instanceof ConfigError) return usage(error.message);
    throw error;
  }
  const { sources, rendered, problems, italics } = pagesResult;
  for (const page of generated) {
    rendered.set(page.src, { html: page.html, headings: headingsOfHtml(page.html), italics: [] });
  }
  const allPages = [...mdPages, ...generated];

  if (!check) {
    const missing = brandProblems(config);
    if (missing.length > 0) return usage(missing.join("\n"));
    const outDir = path.resolve(config.root, requestedOut);
    await writeSite(config, allPages, outDir, rendered);
    const rel = path.relative(config.root, outDir);
    console.log(`wrote ${rel.startsWith("..") ? outDir : `${rel}/`}`);
    return;
  }

  for (const page of generated) problems.push(...generatedPageProblems(page, rendered, allPages));
  const gate = await repoProblems(config, sources);
  let failed = false;
  const report = (heading, list) => {
    if (list.length === 0) return;
    failed = true;
    console.error(heading);
    for (const item of list) console.error(`      ${item}`);
  };
  report("fail  italic emphasis found in a docs-site source (use **bold** instead):", italics);
  report("fail  broken internal link(s):", problems);
  report("fail  repository gate(s):", gate);
  if (!failed) {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "m3l-docs-check-"));
    try {
      await writeSite(config, allPages, tmpDir, rendered);
    } catch (error) {
      console.error("fail  the site does not build:");
      console.error(`      ${error.message}`);
      process.exitCode = 1;
      return;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    console.log("  ok  docs site builds cleanly; links, coverage, design integrity and parity all pass");
    return;
  }
  process.exitCode = 1;
}

await main();
