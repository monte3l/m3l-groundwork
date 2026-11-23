// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Theme tests for the `statusline` pack: the role palette
 * (`PALETTES`/`resolvePalette`) in `statusline-layout.mjs` and its vendored
 * twin `row-format.mjs`, the byte-identical default rendering, the
 * `m3l-design` truecolor opt-in, NO_COLOR, the parity pin against the design
 * tokens, root-copy convergence, and the rule that the pack never plants the
 * theme itself. `templates/**` is outside vitest discovery, so scripts are
 * loaded by path.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const packFiles = join(
  repoRoot,
  "templates",
  "packs",
  "statusline",
  "files",
  ".claude",
);

const ROLES = [
  "success",
  "warning",
  "danger",
  "accent",
  "accentAlt",
  "accentStrong",
  "muted",
  "reset",
] as const;
type Role = (typeof ROLES)[number];
type Palette = Record<Role, string>;

interface PaletteModule {
  PALETTES: { default: Palette } & Record<string, Palette>;
  resolvePalette: (env: Record<string, unknown>) => Palette;
}

const DEFAULT_PALETTE: Palette = {
  success: "\x1b[32m",
  warning: "\x1b[33m",
  danger: "\x1b[31m",
  accent: "\x1b[36m",
  accentAlt: "\x1b[34m",
  accentStrong: "\x1b[35m",
  muted: "\x1b[2m",
  reset: "\x1b[0m",
};

const THEME = { GROUNDWORK_STATUSLINE_THEME: "m3l-design" };
const LIGHT = { COLORFGBG: "0;15" };
const DARK = { COLORFGBG: "15;0" };
// eslint-disable-next-line no-control-regex -- matches ESC
const TRUECOLOR = /^\x1b\[38;2;\d{1,3};\d{1,3};\d{1,3}m$/;
// eslint-disable-next-line no-control-regex -- matches ESC
const ANSI16_HUE = /\x1b\[3[0-7]m/;
// eslint-disable-next-line no-control-regex -- matches ESC
const ANSI = /\x1b\[[0-9;]*m/g;

const load = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(path).href)) as T;

let layout: PaletteModule;
let rowFormat: PaletteModule;
let statusline: { renderStatusLine: (p: unknown, env?: object) => string };
let term: {
  PALETTE: Record<"light" | "dark", Record<string, string>>;
  truecolorSgr: (hex: string) => string;
};

beforeAll(async () => {
  layout = await load(join(packFiles, "hooks", "statusline-layout.mjs"));
  rowFormat = await load(
    join(packFiles, "skills", "subagent-rows", "hooks", "row-format.mjs"),
  );
  statusline = await load(join(packFiles, "hooks", "statusline.mjs"));
  term = await load(join(repoRoot, "bin", "lib", "term.mjs"));
});

describe.each([
  ["statusline-layout.mjs", () => layout],
  ["row-format.mjs", () => rowFormat],
])("%s palette", (_name, get) => {
  it("PALETTES.default is the ANSI-16 mapping", () => {
    expect(get().PALETTES.default).toEqual(DEFAULT_PALETTE);
  });

  it.each([
    ["no theme key", {}],
    ["unknown theme", { GROUNDWORK_STATUSLINE_THEME: "solarized" }],
    ["empty theme", { GROUNDWORK_STATUSLINE_THEME: "" }],
    ["wrong case", { GROUNDWORK_STATUSLINE_THEME: "M3L-Design" }],
    ["default with light COLORFGBG", LIGHT],
  ])("resolves the default palette for %s", (_n, env) => {
    expect(get().resolvePalette(env)).toEqual(DEFAULT_PALETTE);
  });

  it.each([
    ["dark", { ...THEME, ...DARK }],
    ["light", { ...THEME, ...LIGHT }],
    ["absent COLORFGBG", THEME],
  ])("m3l-design (%s) paints every color role in truecolor", (_n, env) => {
    const palette = get().resolvePalette(env);
    for (const role of ROLES.filter((r) => r !== "muted" && r !== "reset")) {
      expect(palette[role]).toMatch(TRUECOLOR);
    }
    expect(palette.muted).toBe("\x1b[2m");
    expect(palette.reset).toBe("\x1b[0m");
  });

  it("m3l-design differs between light and dark, and absent COLORFGBG means dark", () => {
    const light = get().resolvePalette({ ...THEME, ...LIGHT });
    const dark = get().resolvePalette({ ...THEME, ...DARK });
    expect(light).not.toEqual(dark);
    expect(get().resolvePalette(THEME)).toEqual(dark);
  });

  it("treats a COLORFGBG with no separator as dark", () => {
    expect(get().resolvePalette({ ...THEME, COLORFGBG: "15" })).toEqual(
      get().resolvePalette({ ...THEME, ...DARK }),
    );
  });

  it.each(["7", "15"])("treats a COLORFGBG background of %s as light", (bg) => {
    expect(get().resolvePalette({ ...THEME, COLORFGBG: `0;${bg}` })).toEqual(
      get().resolvePalette({ ...THEME, ...LIGHT }),
    );
  });

  it.each([
    ["default theme", {}],
    ["m3l-design dark", { ...THEME, ...DARK }],
    ["m3l-design light", { ...THEME, ...LIGHT }],
  ])("NO_COLOR empties every role under %s", (_n, env) => {
    const palette = get().resolvePalette({ ...env, NO_COLOR: "1" });
    for (const role of ROLES) expect(palette[role]).toBe("");
  });

  it("an empty-string NO_COLOR does not disable color (no-color.org)", () => {
    expect(get().resolvePalette({ NO_COLOR: "" })).toEqual(DEFAULT_PALETTE);
    expect(get().resolvePalette({ ...THEME, ...DARK, NO_COLOR: "" })).toEqual(
      get().resolvePalette({ ...THEME, ...DARK }),
    );
    expect(get().resolvePalette({ ...THEME, ...DARK }).accent).toMatch(
      TRUECOLOR,
    );
  });

  it("an undefined NO_COLOR leaves colors on", () => {
    expect(get().resolvePalette({ NO_COLOR: undefined })).toEqual(
      DEFAULT_PALETTE,
    );
  });

  it("any non-empty NO_COLOR value disables color", () => {
    for (const value of ["0", "false", " "]) {
      const palette = get().resolvePalette({ NO_COLOR: value });
      for (const role of ROLES) expect(palette[role]).toBe("");
    }
  });
});

describe("twin parity of the palette exports", () => {
  it("PALETTES are deeply equal", () => {
    expect(rowFormat.PALETTES).toEqual(layout.PALETTES);
  });

  it.each([
    ["none", {}],
    ["m3l-design dark", { ...THEME, ...DARK }],
    ["m3l-design light", { ...THEME, ...LIGHT }],
    ["m3l-design NO_COLOR", { ...THEME, NO_COLOR: "1" }],
    ["unknown", { GROUNDWORK_STATUSLINE_THEME: "x" }],
  ])("resolvePalette agrees for %s", (_n, env) => {
    expect(rowFormat.resolvePalette(env)).toEqual(layout.resolvePalette(env));
  });
});

describe("parity pin against design/source/dtcg via bin/lib/term.mjs", () => {
  const roleToToken: Record<string, string> = {
    success: "success",
    warning: "warning",
    danger: "danger",
    accent: "accent",
    accentAlt: "accentHover",
    accentStrong: "accentActive",
  };

  it.each([
    ["dark", DARK],
    ["light", LIGHT],
  ] as const)(
    "the inlined %s hex values equal the design tokens",
    (id, env) => {
      const tokens = term.PALETTE[id];
      const expected = Object.fromEntries(
        Object.entries(roleToToken).map(([role, token]) => [
          role,
          term.truecolorSgr(tokens[token] as string),
        ]),
      );
      const actual = layout.resolvePalette({ ...THEME, ...env });
      expect(actual).toMatchObject(expected);
      expect(actual.muted).toBe("\x1b[2m");
      expect(actual.reset).toBe("\x1b[0m");
    },
  );
});

describe("renderStatusLine theming", () => {
  const payload = {
    model: { display_name: "Opus" },
    effort: { level: "high" },
    context_window: { used_percentage: 90 },
  };
  const base = { COLUMNS: "200", branch: "feature-x", now: 0 };

  it("with no theme key, emits the exact ANSI-16 escapes (byte-identical to the pre-theme output)", () => {
    const out = statusline.renderStatusLine(payload, base);
    expect(out).toContain("\x1b[36mOpus\x1b[0m");
    expect(out).toContain("\x1b[34m🌿 feature-x\x1b[0m");
    expect(out).toContain("\x1b[2meffort\x1b[0m \x1b[35mhigh\x1b[0m");
    expect(out).toContain("\x1b[31m90%\x1b[0m");
    expect(out).toContain(`\x1b[2m${"model".padEnd(10)}\x1b[0m`);
  });

  it("uses the success zone color by default for low usage", () => {
    const ok = statusline.renderStatusLine(
      { context_window: { used_percentage: 5 } },
      base,
    );
    expect(ok).toContain("\x1b[32m5%\x1b[0m");
  });

  it("with m3l-design, uses truecolor escapes and no ANSI-16 hue escapes", () => {
    const env = { ...base, ...THEME, ...DARK };
    const out = statusline.renderStatusLine(payload, env);
    const p = layout.resolvePalette(env);
    expect(out).toContain(`${p.accent}Opus${p.reset}`);
    expect(out).toContain(`${p.accentAlt}🌿 feature-x${p.reset}`);
    expect(out).toContain(`${p.accentStrong}high${p.reset}`);
    expect(out).toContain(`${p.danger}90%${p.reset}`);
    expect(out).not.toMatch(ANSI16_HUE);
  });

  it("with NO_COLOR, emits no escape at all and the displayed text is unchanged", () => {
    const plain = statusline.renderStatusLine(payload, base).replace(ANSI, "");
    for (const theme of [{}, THEME]) {
      const out = statusline.renderStatusLine(payload, {
        ...base,
        ...theme,
        NO_COLOR: "1",
      });
      expect(out).not.toContain("\x1b[");
      expect(out).toBe(plain);
    }
  });

  it("row-width fitting is unaffected by the theme", () => {
    const rows = (env: object): string[] =>
      statusline
        .renderStatusLine(payload, { ...base, COLUMNS: "30", ...env })
        .replace(ANSI, "")
        .split("\n");
    expect(rows({ ...THEME, ...DARK })).toEqual(rows({}));
    expect(rows({ NO_COLOR: "1" })).toEqual(rows({}));
  });
});

describe("renderAgentRow honors an injected theme", () => {
  type Render = (
    props: unknown,
    env?: Record<string, unknown>,
  ) => string | null;
  let render: Render;

  beforeAll(async () => {
    ({ renderAgentRow: render } = await load<{ renderAgentRow: Render }>(
      join(packFiles, "skills", "subagent-rows", "hooks", "register.mjs"),
    ));
  });

  const props = { name: "rev", effort: "high" };

  it("keeps ANSI-16 with no theme key", () => {
    expect(render(props, { now: 0 })).toContain("\x1b[35mhigh\x1b[0m");
  });

  it("uses truecolor under m3l-design", () => {
    const env = { now: 0, ...THEME, ...DARK };
    const p = layout.resolvePalette(env);
    const out = render(props, env) ?? "";
    expect(out).toContain(`${p.accentStrong}high${p.reset}`);
    expect(out).not.toMatch(ANSI16_HUE);
  });

  it("emits no escapes under NO_COLOR", () => {
    const out = render(props, { now: 0, NO_COLOR: "1" }) ?? "";
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("high");
  });
});

// TODO: register()-level theme behavior (how the hook obtains the theme at
// runtime) is untested until the probe on the mod's available APIs resolves.

describe("root copy convergence", () => {
  // The root copy adds a 2-line SPDX header (plus a blank line) after the
  // optional shebang; strip it to compare with the SPDX-free pack file.
  const strip = (src: string): string => {
    const lines = src.split("\n");
    const at = lines.findIndex((l) => l.startsWith("// SPDX-FileCopyright"));
    if (at === -1) return src;
    lines.splice(at, lines[at + 2] === "" ? 3 : 2);
    return lines.join("\n");
  };

  it.each([
    "hooks/statusline.mjs",
    "hooks/statusline-layout.mjs",
    "skills/subagent-rows/hooks/register.mjs",
    "skills/subagent-rows/hooks/row-format.mjs",
  ])("root .claude/%s equals the pack file after the SPDX header", (rel) => {
    const root = readFileSync(join(repoRoot, ".claude", rel), "utf8");
    const pack = readFileSync(join(packFiles, rel), "utf8");
    expect(strip(root)).toBe(pack);
  });

  it("root settings.json opts into the m3l-design theme", () => {
    const settings = JSON.parse(
      readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
    ) as { env?: Record<string, string> };
    expect(settings.env?.["GROUNDWORK_STATUSLINE_THEME"]).toBe("m3l-design");
  });
});

describe("the pack never plants the theme", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(repoRoot, "templates", "packs", "statusline", "pack.json"),
      "utf8",
    ),
  ) as {
    wiring: { settings: object; settingsTopLevel: object };
    adoptNotes: string;
  };

  it("has no env key in settingsTopLevel or settings", () => {
    expect(Object.hasOwn(manifest.wiring.settingsTopLevel, "env")).toBe(false);
    expect(Object.hasOwn(manifest.wiring.settings, "env")).toBe(false);
  });

  it("mentions GROUNDWORK_STATUSLINE_THEME in adoptNotes", () => {
    expect(manifest.adoptNotes).toContain("GROUNDWORK_STATUSLINE_THEME");
  });
});
