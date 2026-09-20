/**
 * Unit tests for the logic in the `statusline` pack's scripts that has to hold
 * on both macOS and Linux -- above all `resolveMemory`, whose inputs mean
 * different things per platform. `templates/**` is excluded from this repo's
 * vitest discovery (it is emitted payload, not this repo's code), so the
 * scripts are loaded by path rather than imported; every platform branch is
 * driven through injected inputs, so the whole matrix runs on whichever OS
 * runs the suite. The end-to-end behaviour (a real bootstrap, real stdin, the
 * emitted project's own lint) lives in packs-statusline.e2e.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(
  here,
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

  it("ignores an unlimited cgroup (0 on macOS, a huge sentinel on cgroup v1)", () => {
    for (const constrainedMemory of [0, 9_223_372_036_854_771_712]) {
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

  it("subagent-statusline.mjs still emits its override line", () => {
    const out = execFileSync(
      "node",
      [join(linkedHooks, "subagent-statusline.mjs")],
      {
        input: JSON.stringify({ tasks: [{ id: "a", name: "reviewer" }] }),
        encoding: "utf8",
      },
    );
    expect(JSON.parse(out) as { id: string }).toMatchObject({ id: "a" });
  });
});
