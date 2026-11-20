// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Pure, zero-dependency builders for the parts of a docs site that agents read
 * instead of browsers: the `.md` copy of each page, `llms.txt` (the format of
 * https://llmstxt.org), the optional `llms-full.txt`, and `sitemap.xml`. Each
 * is opt-in through the config (`llms`, `sitemap`), so a site that sets neither
 * builds exactly as before. Nothing here reads or writes a file: `build.mjs`
 * passes in what it has rendered.
 */
import { pageUrlPath } from "./live-site.mjs";

export const LLMS_FILE = "llms.txt";
export const LLMS_FULL_FILE = "llms-full.txt";
export const SITEMAP_FILE = "sitemap.xml";

const LLMS_OPTIONS = new Set(["description", "optionalGroups", "full"]);

/**
 * The path of a page's markdown copy: the same path with `.md` for `.html`.
 *
 * @param {string} out a page's `out`, such as `standard.html`
 * @returns {string} `standard.md`
 * @throws {Error} when `out` does not end in `.html`
 */
export function markdownOutPath(out) {
  if (!out.endsWith(".html")) {
    throw new Error(`cannot name the markdown copy of "${out}": it does not end in .html`);
  }
  return `${out.slice(0, -".html".length)}.md`;
}

/**
 * A path as it goes into a URL: each segment percent-encoded, and the characters
 * `encodeURIComponent` leaves alone (`!'()*`) too, since a `)` would end a markdown link.
 *
 * @param {string} urlPath a path such as `/components/badge` or `index.md`
 * @returns {string}
 */
export function encodePath(urlPath) {
  return urlPath
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * @param {string} siteUrl an https origin with no trailing slash
 * @param {{ out: string, markdownOut?: string }} page
 * @returns {string} the page's markdown copy when it has one, otherwise its public page URL
 */
function pageLink(siteUrl, page) {
  return page.markdownOut ? `${siteUrl}/${encodePath(page.markdownOut)}` : `${siteUrl}${encodePath(pageUrlPath(page.out))}`;
}

/** A page label as link text: a bracket in it would end the link early. */
function escapeLinkText(text) {
  return text.replace(/[[\]\\]/g, "\\$&");
}

/**
 * `llms.txt` as llmstxt.org v2 describes it: an H1 with the site name, a
 * blockquote summary, then one H2 list of links per nav group. The groups named
 * in `llms.optionalGroups` are gathered under a final `## Optional`, which tells
 * an agent it may skip them when it needs less context. A page that has a
 * markdown copy links to the copy, and a generated page links to its page.
 *
 * @param {{
 *   title: string,
 *   siteUrl: string,
 *   navGroups: string[],
 *   llms: { description: string, optionalGroups?: string[] },
 *   pages: Array<{ out: string, group: string, label: string, summary?: string, markdownOut?: string }>,
 * }} input
 * @returns {string}
 */
export function buildLlmsTxt({ title, siteUrl, navGroups, llms, pages }) {
  const optional = new Set(llms.optionalGroups ?? []);
  const section = (heading, group) => {
    const items = pages.filter((page) => group(page.group)).map((page) => {
      const note = page.summary ? `: ${page.summary}` : "";
      return `- [${escapeLinkText(page.label)}](${pageLink(siteUrl, page)})${note}`;
    });
    return items.length === 0 ? [] : [`## ${heading}`, "", ...items, ""];
  };
  const lines = [`# ${title}`, "", `> ${llms.description}`, ""];
  for (const group of navGroups) {
    if (!optional.has(group)) lines.push(...section(group, (name) => name === group));
  }
  lines.push(...section("Optional", (name) => optional.has(name)));
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * `llms-full.txt`: every page's markdown copy in one file, so an agent can load
 * the whole site in one request. It is a convention of docs platforms, not part
 * of llmstxt.org, which is why it is opt-in on its own (`llms.full`). Each
 * page is preceded by the URL of its copy, and headings keep their level.
 *
 * @param {{
 *   title: string,
 *   siteUrl: string,
 *   llms: { description: string },
 *   copies: Array<{ markdownOut: string, text: string }>,
 * }} input
 * @returns {string}
 */
export function buildLlmsFull({ title, siteUrl, llms, copies }) {
  const head = `# ${title}\n\n> ${llms.description}`;
  const body = copies.map(({ markdownOut, text }) => `Source: ${siteUrl}/${encodePath(markdownOut)}\n\n${text.trim()}`);
  return `${[head, ...body].join("\n\n---\n\n")}\n`;
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/**
 * `sitemap.xml` (sitemaps.org) listing every page by its public URL. The 404
 * page and the agent files are not pages and are not listed. `lastmods` maps a
 * page's `out` to a YYYY-MM-DD date; a page without one gets no `<lastmod>`.
 *
 * @param {{ siteUrl: string, pages: Array<{ out: string }>, lastmods?: Map<string, string> }} input
 * @returns {string}
 */
export function buildSitemap({ siteUrl, pages, lastmods }) {
  const urls = pages.map((page) => {
    const loc = `${siteUrl}${encodePath(pageUrlPath(page.out))}`.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
    const date = lastmods?.get(page.out);
    return `  <url><loc>${loc}</loc>${date === undefined ? "" : `<lastmod>${date}</lastmod>`}</url>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...urls,
    `</urlset>`,
    "",
  ].join("\n");
}

/**
 * The config problems of the agent-readable options: `llms`, `sitemap` and a
 * page's `summary`. One message per problem, like `configProblems`.
 *
 * @param {Record<string, any>} c the config object
 * @returns {string[]}
 */
export function agentDocsConfigProblems(c) {
  const problems = [];
  const pages = Array.isArray(c.pages) ? c.pages : [];
  const reserved = new Set();

  if (c.llms !== undefined) {
    const llms = c.llms;
    if (llms === null || typeof llms !== "object" || Array.isArray(llms)) {
      problems.push(`"llms" must be an object`);
    } else {
      for (const key of Object.keys(llms)) {
        if (!LLMS_OPTIONS.has(key)) {
          problems.push(`"llms.${key}" is not an option (use ${[...LLMS_OPTIONS].join(", ")})`);
        }
      }
      if (typeof llms.description !== "string" || llms.description.trim() === "" || /[\r\n]/.test(llms.description)) {
        problems.push(`"llms.description" must be a non-empty single line: it is the summary under the title in llms.txt`);
      }
      if (llms.optionalGroups !== undefined) {
        if (!Array.isArray(llms.optionalGroups)) {
          problems.push(`"llms.optionalGroups" must be an array of nav group names`);
        } else {
          for (const group of llms.optionalGroups) {
            if (!Array.isArray(c.navGroups) || !c.navGroups.includes(group)) {
              problems.push(`"llms.optionalGroups" names "${group}", which is not in navGroups`);
            }
          }
        }
      }
      if (llms.full !== undefined && typeof llms.full !== "boolean") {
        problems.push(`"llms.full" must be true or false`);
      }
      if (Array.isArray(c.navGroups) && c.navGroups.includes("Optional") && !(llms.optionalGroups ?? []).includes("Optional")) {
        problems.push(`a nav group called "Optional" would clash with the Optional section of llms.txt: rename it, or list it in "llms.optionalGroups"`);
      }
      reserved.add(LLMS_FILE);
      if (llms.full === true) reserved.add(LLMS_FULL_FILE);
      pages.forEach((page, i) => {
        if (typeof page?.out === "string" && !page.out.endsWith(".html")) {
          problems.push(`pages[${i}].out "${page.out}" must end in .html when "llms" is set, so its markdown copy can be named`);
        }
      });
    }
  }
  if (c.sitemap !== undefined && typeof c.sitemap !== "boolean") {
    problems.push(`"sitemap" must be true or false`);
  }
  if (c.sitemap === true) reserved.add(SITEMAP_FILE);

  pages.forEach((page, i) => {
    if (page?.summary !== undefined && (typeof page.summary !== "string" || page.summary.trim() === "" || /[\r\n]/.test(page.summary))) {
      problems.push(`pages[${i}].summary must be a non-empty single line`);
    }
    if (typeof page?.out === "string" && reserved.has(page.out)) {
      problems.push(`pages[${i}].out "${page.out}" is a file the kit writes for "llms" or "sitemap"`);
    }
  });
  return problems;
}
