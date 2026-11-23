// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// Docs kit generator (docs.config.mjs `generators`): the "Status line" page.
// It runs the statusline pack's real renderer over fixed fixture payloads with
// the opt-in `m3l-design` palette and turns each color escape into a
// `<span class="sl-<role>">`, so the preview cannot drift from the code. The
// role classes are painted from design tokens by
// `design/local/statusline-preview.css`, which follows the site's light/dark
// theme. Inline styles are not an option: the site's CSP is `style-src 'self'`.
//
// Only the m3l-design theme is drawn. The default theme uses the terminal's own
// ANSI-16 colors, which have no design token to paint with.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOKS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/packs/statusline/files/.claude/hooks",
);

const FIXED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXED_NOW_SEC = FIXED_NOW_MS / 1000;

/** `COLORFGBG` for a dark terminal; the page's colors flip with the site theme. */
const DARK_TERMINAL = "15;0";

const SCENARIOS = [
  {
    title: "A typical session",
    blurb:
      "A feature branch, a half-empty context window and quota to spare. Every bar is in its calm zone.",
    branch: "feat/statusline-theme",
    payload: {
      session_name: "statusline-theme",
      model: { display_name: "Opus 5.5" },
      effort: { level: "high" },
      thinking: { enabled: true },
      workspace: {
        git_worktree: "statusline-theme",
        repo: { owner: "monte3l", name: "m3l-groundwork" },
      },
      context_window: {
        used_percentage: 38,
        total_input_tokens: 76_000,
        context_window_size: 200_000,
        remaining_percentage: 62,
      },
      rate_limits: {
        five_hour: { used_percentage: 23, resets_at: FIXED_NOW_SEC + 7800 },
        seven_day: { used_percentage: 41, resets_at: FIXED_NOW_SEC + 190_000 },
      },
      cost: {
        total_cost_usd: 4.82,
        total_duration_ms: 2_520_000,
        total_lines_added: 156,
        total_lines_removed: 23,
      },
      prompt_cache: { hit_ratio: 0.91, warm: true },
    },
  },
  {
    title: "A window filling up on main",
    blurb:
      "The context bar passes the 90% threshold, so it turns red and the row suggests compacting. Working on main is flagged too.",
    branch: "main",
    payload: {
      session_name: "release-notes",
      model: { display_name: "Opus 5.5" },
      effort: { level: "xhigh" },
      context_window: {
        used_percentage: 92,
        total_input_tokens: 184_000,
        context_window_size: 200_000,
        remaining_percentage: 8,
      },
      rate_limits: {
        five_hour: { used_percentage: 74, resets_at: FIXED_NOW_SEC + 1500 },
      },
      cost: {
        total_cost_usd: 18.4,
        total_duration_ms: 7_980_000,
        total_lines_added: 12,
        total_lines_removed: 4,
      },
      prompt_cache: { hit_ratio: 0.43, warm: false },
    },
  },
];

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Turns SGR-colored terminal text into HTML, one `<span class="sl-<role>">` per
 * colored run. An escape that is not a palette role or the reset throws, so a
 * new style in the renderer fails this page instead of vanishing from it.
 *
 * @param {string} text
 * @param {Record<string, string>} palette role -> SGR escape
 * @returns {string}
 */
export function sgrToHtml(text, palette) {
  const entries = Object.entries(palette).filter(
    ([role, sgr]) => role !== "reset" && sgr !== "",
  );
  const roleOf = new Map(entries.map(([role, sgr]) => [sgr, role]));
  if (roleOf.size !== entries.length) {
    throw new Error(
      "statusline preview: two palette roles share one escape, so a run cannot be mapped back to its role",
    );
  }
  // eslint-disable-next-line no-control-regex -- matches the ESC (\x1b) that opens an SGR sequence
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  let html = "";
  let open = false;
  for (const part of parts) {
    // eslint-disable-next-line no-control-regex -- see above
    if (!/^\x1b\[[0-9;]*m$/.test(part)) {
      // Any other control character (an OSC-8 link's ESC and BEL, say) would
      // reach the page as invisible bytes, so fail instead.
      // eslint-disable-next-line no-control-regex -- matches C0 control characters other than tab and newline
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(part)) {
        throw new Error(
          `statusline preview: unhandled control sequence in ${JSON.stringify(part)}`,
        );
      }
      html += escapeHtml(part);
      continue;
    }
    if (open) {
      html += "</span>";
      open = false;
    }
    if (part === palette["reset"]) continue;
    const role = roleOf.get(part);
    if (role === undefined) {
      throw new Error(
        `statusline preview: no palette role for escape ${JSON.stringify(part)}`,
      );
    }
    html += `<span class="sl-${role}">`;
    open = true;
  }
  if (open) html += "</span>";
  return html;
}

/** @returns {Promise<Array<{ out: string, group: string, label: string, html: string }>>} */
export default async function generate() {
  const layout = await import(join(HOOKS, "statusline-layout.mjs"));
  const { renderStatusLine } = await import(join(HOOKS, "statusline.mjs"));
  const theme = {
    GROUNDWORK_STATUSLINE_THEME: "m3l-design",
    COLORFGBG: DARK_TERMINAL,
  };
  const palette = layout.resolvePalette(theme);

  const blocks = SCENARIOS.map((scenario) => {
    const rendered = renderStatusLine(scenario.payload, {
      ...theme,
      now: FIXED_NOW_MS,
      branch: scenario.branch,
      freemem: 9.2 * 2 ** 30,
      totalmem: 32 * 2 ** 30,
      COLUMNS: "100",
    });
    return (
      `<h3>${escapeHtml(scenario.title)}</h3>\n` +
      `<p>${escapeHtml(scenario.blurb)}</p>\n` +
      `<pre class="sl-preview" tabindex="0" aria-label="${escapeHtml(`Status line preview: ${scenario.title}`)}"><code>${sgrToHtml(rendered, palette)}</code></pre>`
    );
  });

  const html = [
    "<h1>Status line</h1>",
    "<p>The <code>statusline</code> pack draws five rows under the prompt: session, model, context, quota and work. These previews are rendered by the pack's own script from fixed sample data, so they match what it prints.</p>",
    "<h2>Colors</h2>",
    "<p>By default the status line uses your terminal's own colors. It can instead use the m3l-design palette, in truecolor. <strong>That is never the default.</strong> <code>/customize</code> asks, and sets it only if you say yes. You can also turn it on yourself with an <code>env</code> entry in <code>.claude/settings.json</code>:</p>",
    `<pre tabindex="0" aria-label="Settings entry that turns on the m3l-design palette"><code>${escapeHtml(
      '{\n  "env": {\n    "GROUNDWORK_STATUSLINE_THEME": "m3l-design"\n  }\n}',
    )}</code></pre>`,
    "<p>The previews below use that palette. Their colors follow this site's light or dark theme, the way the palette follows your terminal's (it reads <code>COLORFGBG</code>). <code>NO_COLOR</code> turns every color off.</p>",
    "<h2>Previews</h2>",
    ...blocks,
  ].join("\n");

  return [
    {
      out: "docs/statusline.html",
      group: "Start",
      label: "Status line",
      html,
    },
  ];
}
