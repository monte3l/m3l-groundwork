// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the logic in the `statusline` pack's scripts that has to hold
 * on both macOS and Linux -- above all `resolveMemory`, whose inputs mean
 * different things per platform. `templates/**` is excluded from this repo's
 * vitest discovery (it is emitted payload, not this repo's code), so the
 * scripts are loaded by path rather than imported; every platform branch is
 * driven through injected inputs, so the whole matrix runs on whichever OS
 * runs the suite. The end-to-end behaviour (a real bootstrap, real stdin, the
 * emitted project's own lint) lives in packs.e2e.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "statusline",
  "files",
  ".claude",
  "hooks",
);

interface MemorySources {
  platform: string;
  totalmem: number;
  freemem: number;
  availableMemory?: unknown;
  constrainedMemory?: unknown;
}

interface Statusline {
  resolveMemory: (sources: MemorySources) => {
    freemem?: number;
    totalmem?: number;
  };
  sanitizeDisplayText: (text: string) => string;
  zoneForPercentage: (pct: number | null) => string;
  parseHeadRef: (content: unknown) => string | null;
  parseDetachedHead: (content: unknown) => string | null;
  readHead: (
    readFile: (path: string) => string | null,
    startDir: unknown,
  ) => string | null;
  formatBranchSegment: (
    branch: string | null,
    detachedSha?: string | null,
  ) => { text: string } | null;
  renderStatusLine: (payload: unknown, env?: object) => string;
}

async function load(name: string): Promise<unknown> {
  return import(pathToFileURL(join(hooksDir, name)).href);
}

const GiB = 2 ** 30;
// eslint-disable-next-line no-control-regex -- matches the ESC byte that starts an ANSI sequence
const ANSI = /\x1b\[[0-9;]*m/g;

let statusline: Statusline;
let layout: {
  displayWidth: (text: string) => number;
  truncateToWidth: (text: string, maxWidth: number) => string;
  fitRow: (
    segments: {
      id: string;
      priority: number;
      text: string;
      minWidth: number;
    }[],
    budget: number,
    separator: string,
  ) => string;
};

beforeAll(async () => {
  statusline = (await load("statusline.mjs")) as Statusline;
  layout = (await load("statusline-layout.mjs")) as typeof layout;
});

describe("resolveMemory (identical behaviour on macOS and Linux)", () => {
  it("prefers process.availableMemory() on both platforms, so macOS counts reclaimable pages", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(
        statusline.resolveMemory({
          platform,
          totalmem: 64 * GiB,
          freemem: 30 * GiB,
          availableMemory: 44 * GiB,
        }),
      ).toEqual({ freemem: 44 * GiB, totalmem: 64 * GiB });
    }
  });

  it("falls back to os.freemem() on Linux when availableMemory is missing (older Node)", () => {
    expect(
      statusline.resolveMemory({
        platform: "linux",
        totalmem: 32 * GiB,
        freemem: 9 * GiB,
      }),
    ).toEqual({ freemem: 9 * GiB, totalmem: 32 * GiB });
  });

  it("shows nothing on macOS without availableMemory rather than the misleading os.freemem()", () => {
    expect(
      statusline.resolveMemory({
        platform: "darwin",
        totalmem: 64 * GiB,
        freemem: 30 * GiB,
      }),
    ).toEqual({});
  });

  it("caps total at a cgroup limit, so a small container reads as itself, not its host", () => {
    expect(
      statusline.resolveMemory({
        platform: "linux",
        totalmem: 64 * GiB,
        freemem: 50 * GiB,
        availableMemory: 1.5 * GiB,
        constrainedMemory: 2 * GiB,
      }),
    ).toEqual({ freemem: 1.5 * GiB, totalmem: 2 * GiB });
  });

  it("ignores an unlimited cgroup (0 on macOS, a huge sentinel on cgroup v1, UINT64_MAX on cgroup v2)", () => {
    // 2 ** 64 is what process.constrainedMemory() returns on cgroup v2 with
    // memory.max = "max" (observed on Ubuntu 24.04 aarch64, Node 24).
    for (const constrainedMemory of [0, 9_223_372_036_854_771_712, 2 ** 64]) {
      expect(
        statusline.resolveMemory({
          platform: "linux",
          totalmem: 16 * GiB,
          freemem: 4 * GiB,
          availableMemory: 5 * GiB,
          constrainedMemory,
        }),
      ).toEqual({ freemem: 5 * GiB, totalmem: 16 * GiB });
    }
  });

  it("never reports more free than total, and returns nothing for garbage", () => {
    expect(
      statusline.resolveMemory({
        platform: "linux",
        totalmem: 8 * GiB,
        freemem: 1,
        availableMemory: 20 * GiB,
      }),
    ).toEqual({ freemem: 8 * GiB, totalmem: 8 * GiB });
    expect(
      statusline.resolveMemory({
        platform: "linux",
        totalmem: Number.NaN,
        freemem: 1,
        availableMemory: 1,
      }),
    ).toEqual({});
  });
});

describe("sanitizeDisplayText", () => {
  it("strips escape sequences and control characters a branch or session name could smuggle in", () => {
    expect(
      statusline.sanitizeDisplayText("feat/x\u001b[31mRED\u001b[0m\n"),
    ).toBe("feat/x[31mRED[0m");
    expect(statusline.sanitizeDisplayText("a\u0007b\u007fc\u009bd")).toBe(
      "abcd",
    );
  });
});

describe("zoneForPercentage", () => {
  it("uses Anthropic's documented thresholds: green under 70, warn 70-89, high 90+", () => {
    expect(statusline.zoneForPercentage(null)).toBe("unknown");
    expect(statusline.zoneForPercentage(69)).toBe("ok");
    expect(statusline.zoneForPercentage(70)).toBe("warn");
    expect(statusline.zoneForPercentage(89)).toBe("warn");
    expect(statusline.zoneForPercentage(90)).toBe("high");
  });
});

describe("parseHeadRef", () => {
  it("reads a branch name from .git/HEAD, and nothing from a detached HEAD", () => {
    expect(statusline.parseHeadRef("ref: refs/heads/feat/x\n")).toBe("feat/x");
    expect(
      statusline.parseHeadRef("9fceb02d0ae598e95dc970b74767f19372d61af8\n"),
    ).toBeNull();
  });
});

describe("detached HEAD", () => {
  const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";

  it("reports a short commit id, never a branch name", () => {
    expect(statusline.parseDetachedHead(`${sha}\n`)).toBe("9fceb02");
    expect(statusline.parseDetachedHead(`${"a".repeat(64)}\n`)).toBe("aaaaaaa");
    expect(statusline.parseHeadRef(sha)).toBeNull();
  });

  it("is null for a branch ref and for garbage", () => {
    expect(statusline.parseDetachedHead("ref: refs/heads/main\n")).toBeNull();
    expect(statusline.parseDetachedHead("not a sha")).toBeNull();
    expect(statusline.parseDetachedHead(null)).toBeNull();
  });

  it("reads HEAD through a linked worktree's gitdir pointer too", () => {
    const files: Record<string, string> = {
      "/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
      "/repo/.git/worktrees/wt/HEAD": `${sha}\n`,
    };
    const head = statusline.readHead((path) => files[path] ?? null, "/wt");
    expect(statusline.parseDetachedHead(head)).toBe("9fceb02");
  });

  it("keeps the branch segment during a rebase or bisect instead of dropping it", () => {
    const segment = statusline.formatBranchSegment(null, "9fceb02");
    expect(segment?.text.replace(ANSI, "")).toBe("detached @ 9fceb02");
  });

  it("prefers a real branch, and shows nothing when there is neither", () => {
    expect(
      statusline
        .formatBranchSegment("feat/x", "9fceb02")
        ?.text.replace(ANSI, ""),
    ).toContain("feat/x");
    expect(statusline.formatBranchSegment(null, null)).toBeNull();
  });

  it("renders in the session row end to end", () => {
    const out = statusline.renderStatusLine(
      { session_name: "s" },
      { detachedSha: "9fceb02", COLUMNS: "120" },
    );
    expect(out.replace(ANSI, "")).toContain("detached @ 9fceb02");
  });
});

describe("displayWidth", () => {
  // Cell counts as a terminal draws them, not as codepoints sum.
  it.each([
    // Emoji-presentation glyphs are two cells; text-presentation symbols from
    // the same Unicode blocks are one. `⚠` is what the branch segment shows on main.
    ["⚡", 2],
    ["🌿 feat", 7],
    ["⚠ main", 6],
    ["✓ ➜ ↳ ↻", 7],
    // U+FE0F asks for emoji presentation, widening a narrow base to two cells.
    ["⚠\uFE0F", 2],
    ["1\uFE0F\u20E3", 2],
    // A ZWJ sequence is one glyph.
    ["\u{1F468}\u200D\u{1F4BB}", 2],
    // East Asian Wide text is not emoji, and must keep counting two.
    ["日本", 4],
    ["가", 2],
    // Bar glyphs, combining marks and escapes.
    ["█░", 2],
    ["e\u0301", 1],
    ["\x1b[31mabc\x1b[0m", 3],
  ])("measures %j as %i cells", (text, cells) => {
    expect(layout.displayWidth(text)).toBe(cells);
  });
});

describe("truncateToWidth", () => {
  it("never cuts inside a ZWJ sequence", () => {
    const family = "\u{1F468}\u200D\u{1F4BB}";
    expect(layout.truncateToWidth(`${family}abc`, 3)).toBe(`${family}…`);
  });
});

describe("fitRow", () => {
  it("drops the lowest-priority segment first and keeps original order", () => {
    const segments = [
      { id: "a", priority: 10, text: "aaaa", minWidth: 1 },
      { id: "b", priority: 90, text: "bbbb", minWidth: 1 },
      { id: "c", priority: 50, text: "cccc", minWidth: 1 },
    ];
    expect(layout.fitRow(segments, 100, "|")).toBe("aaaa|bbbb|cccc");
    expect(layout.fitRow(segments, 9, "|")).toBe("bbbb|cccc");
    expect(layout.fitRow(segments, 4, "|")).toBe("bbbb");
  });
});

describe("renderStatusLine", () => {
  it("always renders exactly five gutter-labelled rows, even for an empty payload", () => {
    const rows = statusline.renderStatusLine({}).replace(ANSI, "").split("\n");
    expect(rows.map((row) => row.split(/\s/)[0])).toEqual([
      "session",
      "model",
      "context",
      "quota",
      "work",
    ]);
  });

  it("never lets a payload string inject its own escape sequence into a row", () => {
    const out = statusline.renderStatusLine(
      { session_name: "evil\u001b[2J\u001b[Hname" },
      { COLUMNS: "120" },
    );
    expect(out).not.toContain("\u001b[2J");
    expect(out).not.toContain("\u001b[H");
  });
});

describe("running as the entry point through a symlinked path", () => {
  // `import.meta.url` is symlink-resolved but `process.argv[1]` is not, so a
  // naive "am I the entry point" check is false under any symlinked directory
  // (macOS's /tmp and /var, a symlinked home) and the script prints nothing.
  let scratch: string;
  let linkedHooks: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "statusline-symlink-"));
    linkedHooks = join(scratch, "linked-hooks");
    symlinkSync(hooksDir, linkedHooks, "dir");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("statusline.mjs still renders five rows", () => {
    const out = execFileSync("node", [join(linkedHooks, "statusline.mjs")], {
      input: "{}",
      encoding: "utf8",
    });
    expect(out.trimEnd().split("\n")).toHaveLength(5);
  });
});

const repoRoot = join(here, "..", "..", "..", "..");

describe.each([
  [
    "shipped pack copy",
    join(
      repoRoot,
      "templates",
      "packs",
      "statusline",
      "files",
      ".claude",
      "skills",
      "subagent-rows",
    ),
  ],
  ["root copy", join(repoRoot, ".claude", "skills", "subagent-rows")],
])("subagent-rows plugin (%s)", (_label, pluginDir) => {
  type Props = Record<string, unknown>;
  type Event = { props: Props; [key: string]: unknown };
  type Next = (e: Event) => unknown;
  type Handler = (ctx: unknown, e: Event, next: Next) => unknown;
  type On = (event: string, matcher: unknown, handler: Handler) => unknown;

  let render: (props: unknown, env?: { now?: number }) => string | null;
  let register: (on: On) => void;
  let rowFormat: Record<string, unknown> & {
    formatTokenCount: (n: number) => string;
    truncateToWidth: (text: string, maxWidth: number) => string;
  };

  beforeAll(async () => {
    const mod = (await import(
      pathToFileURL(join(pluginDir, "hooks", "register.mjs")).href
    )) as { renderAgentRow: typeof render; register: typeof register };
    render = mod.renderAgentRow;
    register = mod.register;
    rowFormat = (await import(
      pathToFileURL(join(pluginDir, "hooks", "row-format.mjs")).href
    )) as typeof rowFormat;
  });

  const text = (body: string | null): string => (body ?? "").replace(ANSI, "");

  describe("renderAgentRow", () => {
    it("uses name as the label", () => {
      expect(text(render({ name: "reviewer", type: "other" }))).toBe(
        "reviewer",
      );
    });

    it("falls back to type when name is missing", () => {
      expect(text(render({ type: "code-reviewer" }))).toBe("code-reviewer");
    });

    it("falls back to type when name is empty", () => {
      expect(text(render({ name: "", type: "tester" }))).toBe("tester");
    });

    it("does not require an id", () => {
      expect(render({ name: "x" })).not.toBeNull();
    });

    it.each([
      ["no name and no type", {}],
      ["empty name and empty type", { name: "", type: "" }],
      ["non-string type", { type: 7 }],
    ])("returns null for %s", (_n, props) => {
      expect(render(props)).toBeNull();
    });

    it("renders effort in magenta", () => {
      const body = render({ name: "x", effort: "high" }) ?? "";
      expect(body).toContain(`${rowFormat["MAGENTA"] as string}high`);
      expect(text(body)).toBe("x · high");
    });

    it("renders tokens/context with a rounded percentage", () => {
      expect(
        text(
          render({ name: "x", tokenCount: 12000, contextWindowSize: 200000 }),
        ),
      ).toBe("x · 12k/200k (6%)");
    });

    it("omits the token segment without a positive context window", () => {
      expect(
        text(render({ name: "x", tokenCount: 12000, contextWindowSize: 0 })),
      ).toBe("x");
    });

    it.each([
      [0, "0m", "GREEN"],
      [14 * 60_000, "14m", "GREEN"],
      [15 * 60_000, "15m", "YELLOW"],
      [29 * 60_000, "29m", "YELLOW"],
      [30 * 60_000, "30m", "RED"],
      [75 * 60_000, "1h15m", "RED"],
    ])("elapsed %i ms renders %s in %s", (elapsed, label, color) => {
      const body =
        render({ name: "x", startTime: 1000 }, { now: 1000 + elapsed }) ?? "";
      expect(body).toContain(`${rowFormat[color] as string}${label}`);
      expect(text(body)).toBe(`x · ${label}`);
    });

    it("truncates to props.columns when it is a positive number", () => {
      const props = { name: "a-very-long-subagent-name", columns: 10 };
      const body = render(props) ?? "";
      expect(body).toBe(
        rowFormat.truncateToWidth("a-very-long-subagent-name", 10),
      );
      expect(text(body).length).toBeLessThanOrEqual(10);
    });

    it.each([0, -5, "80", undefined])(
      "does not truncate when columns is %s",
      (columns) => {
        expect(
          text(render({ name: "a-very-long-subagent-name", columns })),
        ).toBe("a-very-long-subagent-name");
      },
    );
  });

  describe("register", () => {
    function capture(): {
      calls: { event: string; matcher: unknown; handler: Handler }[];
    } {
      const calls: { event: string; matcher: unknown; handler: Handler }[] = [];
      register((event, matcher, handler) => {
        calls.push({ event, matcher, handler });
      });
      return { calls };
    }

    it("registers exactly one ui.render hook for the AgentRow component", () => {
      const { calls } = capture();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.event).toBe("ui.render");
      expect(calls[0]?.matcher).toEqual({ component: "AgentRow" });
    });

    it("sets props.body and preserves every other prop, including isHidden", () => {
      const handler = capture().calls[0]?.handler as Handler;
      const next = vi.fn();
      const e = {
        kind: "ui.render",
        props: { id: "a", name: "reviewer", type: "t", isHidden: false },
      };
      handler(undefined, e, next);
      expect(next).toHaveBeenCalledTimes(1);
      const passed = next.mock.calls[0]?.[0] as Event;
      expect(text(passed.props["body"] as string)).toContain("reviewer");
      expect(passed.props).toMatchObject({
        id: "a",
        name: "reviewer",
        type: "t",
        isHidden: false,
      });
      expect(passed["kind"]).toBe("ui.render");
    });

    it("never un-hides or hides a row", () => {
      const handler = capture().calls[0]?.handler as Handler;
      const next = vi.fn();
      handler(undefined, { props: { name: "x", isHidden: true } }, next);
      expect((next.mock.calls[0]?.[0] as Event).props["isHidden"]).toBe(true);
    });

    it("calls next with the event untouched when there is no usable label", () => {
      const handler = capture().calls[0]?.handler as Handler;
      const next = vi.fn();
      const e = { props: { id: "a", isHidden: false } };
      handler(undefined, e, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]?.[0]).toBe(e);
      expect(Object.hasOwn(e.props, "body")).toBe(false);
    });

    it("catches a throwing render and still calls next with the event untouched", () => {
      const handler = capture().calls[0]?.handler as Handler;
      const next = vi.fn();
      const hostile = {
        props: new Proxy(
          {},
          {
            get() {
              throw new Error("boom");
            },
          },
        ) as Props,
      };
      expect(() => handler(undefined, hostile, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]?.[0]).toBe(hostile);
    });

    it("lets an error thrown by next propagate and calls next exactly once", () => {
      const handler = capture().calls[0]?.handler as Handler;
      const failure = new Error("downstream");
      const next = vi.fn(() => {
        throw failure;
      });
      let thrown: unknown;
      try {
        handler(undefined, { props: { name: "reviewer" } }, next);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("tolerates an undefined props and passes the event on untouched", () => {
      const handler = capture().calls[0]?.handler as Handler;
      const next = vi.fn();
      const e = { kind: "ui.render" } as unknown as Event;
      expect(() => handler(undefined, e, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]?.[0]).toBe(e);
    });
  });

  describe("renderAgentRow input hardening", () => {
    it("omits the token segment for a negative tokenCount", () => {
      expect(
        text(render({ name: "x", tokenCount: -5, contextWindowSize: 200000 })),
      ).toBe("x");
    });

    it("still renders a zero tokenCount", () => {
      expect(
        text(render({ name: "x", tokenCount: 0, contextWindowSize: 200000 })),
      ).toBe("x · 0/200k (0%)");
    });

    it.each([-1e300, 1e300, Infinity, NaN, 1.5])(
      "omits the elapsed segment for startTime %s",
      (startTime) => {
        expect(text(render({ name: "x", startTime }, { now: 5_000_000 }))).toBe(
          "x",
        );
      },
    );

    it.each([0.5, NaN, 0, -3])(
      "does not truncate when columns is %s",
      (columns) => {
        expect(
          text(render({ name: "a-very-long-subagent-name", columns })),
        ).toBe("a-very-long-subagent-name");
      },
    );
  });

  describe("row-format.mjs parity with statusline-layout.mjs", () => {
    let original: Record<string, unknown> & {
      formatTokenCount: (n: number) => string;
      truncateToWidth: (text: string, maxWidth: number) => string;
    };

    beforeAll(() => {
      original = layout as unknown as typeof original;
    });

    it.each(["DIM", "GREEN", "MAGENTA", "RED", "RESET", "YELLOW"])(
      "exports the same %s constant",
      (name) => {
        expect(typeof rowFormat[name]).toBe("string");
        expect(rowFormat[name]).toBe(original[name]);
      },
    );

    it.each([0, 1, 999, 1000, 12345, 200000, 1_000_000, 2_500_000])(
      "formatTokenCount(%i) matches",
      (n) => {
        expect(rowFormat.formatTokenCount(n)).toBe(
          original.formatTokenCount(n),
        );
      },
    );

    it.each([
      ["plain", "hello world", 5],
      ["fits", "short", 80],
      ["wide CJK", "日本語のテキストです", 7],
      ["emoji", "ok 🎉🎉🎉 done", 6],
      ["ANSI", `${"\x1b[32m"}green text that is long${"\x1b[0m"}`, 8],
      ["zero width", "abc", 0],
    ])("truncateToWidth matches for %s", (_n, input, width) => {
      expect(rowFormat.truncateToWidth(input, width)).toBe(
        original.truncateToWidth(input, width),
      );
    });
  });

  describe("plugin files", () => {
    const read = (rel: string): string =>
      readFileSync(join(pluginDir, rel), "utf8");

    it("plugin.json names the plugin after its directory", () => {
      const manifest = JSON.parse(read(".claude-plugin/plugin.json")) as {
        name: string;
        version: string;
        description: string;
        author: unknown;
      };
      expect(manifest.name).toBe("subagent-rows");
      expect(basename(pluginDir)).toBe(manifest.name);
      expect(typeof manifest.version).toBe("string");
      expect(typeof manifest.description).toBe("string");
      expect(manifest.author).toBeDefined();
    });

    it("hooks.json lists register.mjs as its only module", () => {
      const hooks = JSON.parse(read("hooks/hooks.json")) as {
        description: string;
        modules: string[];
      };
      expect(hooks.modules).toEqual(["./register.mjs"]);
      expect(typeof hooks.description).toBe("string");
    });

    it.each(["hooks/register.mjs", "hooks/row-format.mjs"])(
      "%s imports only node:* or files inside the plugin directory",
      (rel) => {
        const source = read(rel);
        const specifiers = [
          ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
        ].map((m) => m[1] as string);
        const fileDir = dirname(join(pluginDir, rel));
        for (const spec of specifiers) {
          if (spec.startsWith("node:")) continue;
          expect(spec.startsWith("."), `${rel} imports ${spec}`).toBe(true);
          const resolved = resolve(fileDir, spec);
          expect(
            resolved.startsWith(pluginDir + sep),
            `${rel} imports ${spec}`,
          ).toBe(true);
        }
      },
    );

    it("register.mjs imports from the vendored row-format.mjs", () => {
      expect(read("hooks/register.mjs")).toContain("./row-format.mjs");
    });
  });
});

describe("the old subagent-statusline command is gone", () => {
  it.each([
    join(hooksDir, "subagent-statusline.mjs"),
    join(repoRoot, ".claude", "hooks", "subagent-statusline.mjs"),
  ])("%s does not exist", (path) => {
    expect(existsSync(path)).toBe(false);
  });

  it("the repo's .claude/settings.json has no subagentStatusLine key", () => {
    const settings = JSON.parse(
      readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(settings, "subagentStatusLine")).toBe(false);
  });
});
