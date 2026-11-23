// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Theme tests for the `statusline` pack's subagent-rows mod: `themeEnvFrom`
 * and how `register` learns the theme from `$.settings.read({ key: "env" })`
 * (a mod's hook module has no Node APIs, so never `process.env`).
 * `templates/**` is outside vitest discovery, so the module is loaded by path.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registerPath = join(
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
  "skills",
  "subagent-rows",
  "hooks",
  "register.mjs",
);

type Props = Record<string, unknown>;
type Event = { props: Props; [key: string]: unknown };
type Next = (e: Event) => unknown;
type Handler = (ctx: unknown, e: Event, next: Next) => unknown;
type On = (event: string, matcher: unknown, handler: Handler) => unknown;

let themeEnvFrom: (settingsEnv: unknown) => Record<string, unknown>;
let register: (on: On) => void;

beforeAll(async () => {
  const mod = (await import(pathToFileURL(registerPath).href)) as {
    themeEnvFrom: typeof themeEnvFrom;
    register: typeof register;
  };
  themeEnvFrom = mod.themeEnvFrom;
  register = mod.register;
});

// eslint-disable-next-line no-control-regex -- matches ESC
const ESC = /\x1b\[/;
// eslint-disable-next-line no-control-regex -- matches ESC
const ANSI16_HUE = /\x1b\[3[0-7]m/;
// eslint-disable-next-line no-control-regex -- matches ESC
const TRUECOLOR = /\x1b\[38;2;\d{1,3};\d{1,3};\d{1,3}m/;
const MAGENTA = "\x1b[35m";

const makeProps = (): Props => ({
  name: "reviewer",
  type: "code-reviewer",
  effort: "high",
  startTime: Date.now() - 5 * 60 * 1000,
  tokenCount: 12000,
  contextWindowSize: 200000,
  columns: 120,
});

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** Registers the mod and returns a driver that runs one event through it. */
const setup = (
  $: unknown,
): {
  run: (props?: Props) => { next: ReturnType<typeof vi.fn>; out: Event };
  threw: () => boolean;
} => {
  let handler: Handler | undefined;
  register((_event, _matcher, h) => {
    handler = h;
  });
  let threw = false;
  return {
    run: (props = makeProps()) => {
      const next = vi.fn((e: Event) => e);
      const e: Event = { props };
      try {
        (handler as Handler)($, e, next);
      } catch {
        threw = true;
      }
      expect(next).toHaveBeenCalledTimes(1);
      return { next, out: next.mock.calls[0]?.[0] as Event };
    },
    threw: () => threw,
  };
};

const body = (out: Event): string => {
  const value = out.props["body"];
  return typeof value === "string" ? value : "";
};

describe("themeEnvFrom", () => {
  it("keeps only the three string-valued theme keys", () => {
    const input = {
      GROUNDWORK_STATUSLINE_THEME: "m3l-design",
      COLORFGBG: "0;15",
      NO_COLOR: "1",
      PATH: "/usr/bin",
    };
    expect(themeEnvFrom(input)).toEqual({
      GROUNDWORK_STATUSLINE_THEME: "m3l-design",
      COLORFGBG: "0;15",
      NO_COLOR: "1",
    });
  });

  it("copies only keys that are present", () => {
    expect(themeEnvFrom({ NO_COLOR: "1" })).toEqual({ NO_COLOR: "1" });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "GROUNDWORK_STATUSLINE_THEME"],
    ["a number", 7],
    ["an array", ["GROUNDWORK_STATUSLINE_THEME"]],
    ["an object without theme keys", { PATH: "/bin", HOME: "/h" }],
  ])("returns {} for %s", (_n, input) => {
    expect(themeEnvFrom(input)).toEqual({});
  });

  it("drops non-string values", () => {
    expect(
      themeEnvFrom({
        GROUNDWORK_STATUSLINE_THEME: 1,
        COLORFGBG: null,
        NO_COLOR: true,
      }),
    ).toEqual({});
  });

  it("never copies a __proto__ key", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":"x"},"NO_COLOR":"1"}',
    ) as unknown;
    const out = themeEnvFrom(input);
    expect(out).toEqual({ NO_COLOR: "1" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["NO_COLOR"]);
  });

  it("ignores inherited keys", () => {
    const input: unknown = Object.create({
      NO_COLOR: "1",
      GROUNDWORK_STATUSLINE_THEME: "m3l-design",
    });
    expect(themeEnvFrom(input)).toEqual({});
  });

  it("returns a fresh object and does not mutate the input", () => {
    const input = { NO_COLOR: "1", PATH: "/bin" };
    const out = themeEnvFrom(input);
    expect(out).not.toBe(input);
    expect(input).toEqual({ NO_COLOR: "1", PATH: "/bin" });
  });
});

describe("register theme discovery via $.settings.read", () => {
  const withEnv = (resolved: unknown) => {
    const read = vi.fn(() => Promise.resolve(resolved));
    return { read, $: { settings: { read } } };
  };

  it("reads settings env once, lazily, and renders default first", async () => {
    const { read, $ } = withEnv({ GROUNDWORK_STATUSLINE_THEME: "m3l-design" });
    const { run } = setup($);
    expect(read).not.toHaveBeenCalled();

    const first = run();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ key: "env" });
    expect(body(first.out)).toContain(`${MAGENTA}high`);
    expect(body(first.out)).not.toMatch(TRUECOLOR);

    await settle();
    run();
    run();
    run();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("uses the m3l-design palette after the read resolves", async () => {
    const { $ } = withEnv({
      GROUNDWORK_STATUSLINE_THEME: "m3l-design",
      PATH: "/bin",
    });
    const { run } = setup($);
    run();
    await settle();
    const { out } = run();
    expect(body(out)).toMatch(TRUECOLOR);
    expect(body(out)).not.toMatch(ANSI16_HUE);
  });

  it("stays default when the resolved env has no theme key", async () => {
    const { $ } = withEnv({ PATH: "/bin" });
    const { run } = setup($);
    run();
    await settle();
    const { out } = run();
    expect(body(out)).toContain(`${MAGENTA}high`);
    expect(body(out)).not.toMatch(TRUECOLOR);
  });

  it("emits no escapes when the resolved env sets NO_COLOR", async () => {
    const { $ } = withEnv({ NO_COLOR: "1" });
    const { run } = setup($);
    run();
    await settle();
    const { out } = run();
    expect(body(out)).not.toBe("");
    expect(body(out)).not.toMatch(ESC);
  });
});

describe("register failure paths stay advisory", () => {
  const cases: [string, () => unknown][] = [
    [
      "settings.read rejects",
      () => ({
        settings: { read: vi.fn(() => Promise.reject(new Error("denied"))) },
      }),
    ],
    [
      "settings.read throws synchronously",
      () => ({
        settings: {
          read: vi.fn(() => {
            throw new Error("sync");
          }),
        },
      }),
    ],
    [
      "settings.read returns a non-thenable",
      () => ({
        settings: {
          read: vi.fn(() => ({ GROUNDWORK_STATUSLINE_THEME: "m3l-design" })),
        },
      }),
    ],
    [
      "settings.read resolves undefined",
      () => ({
        settings: { read: vi.fn(() => Promise.resolve(undefined)) },
      }),
    ],
    ["$.settings is missing", () => ({})],
    ["$ is undefined", () => undefined],
  ];

  it.each(cases)("%s", async (_n, make) => {
    const { run, threw } = setup(make());
    const first = run();
    await settle();
    const second = run();
    for (const { out } of [first, second]) {
      expect(Object.hasOwn(out, "isHidden")).toBe(false);
      expect(Object.hasOwn(out.props, "isHidden")).toBe(false);
      expect(Object.hasOwn(out.props, "body")).toBe(true);
      expect(body(out)).toContain(`${MAGENTA}high`);
      expect(body(out)).not.toMatch(TRUECOLOR);
    }
    expect(threw()).toBe(false);
  });

  it("reads at most once even when the read rejects", async () => {
    const read = vi.fn(() => Promise.reject(new Error("denied")));
    const { run } = setup({ settings: { read } });
    run();
    run();
    await settle();
    run();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a throwing getter",
      () => ({
        get NO_COLOR(): string {
          throw new TypeError("boom");
        },
      }),
    ],
    [
      "a throwing Proxy",
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new TypeError("boom");
            },
            getOwnPropertyDescriptor: () => {
              throw new TypeError("boom");
            },
          },
        ),
    ],
  ])(
    "a resolved env with %s leaves the default palette and no rejection",
    async (_n, makeEnv) => {
      const read = vi.fn(() => Promise.resolve(makeEnv()));
      const { run, threw } = setup({ settings: { read } });
      run();
      await settle();
      await settle();
      const { out } = run();
      expect(Object.hasOwn(out.props, "body")).toBe(true);
      expect(body(out)).toContain(`${MAGENTA}high`);
      expect(body(out)).not.toMatch(TRUECOLOR);
      expect(threw()).toBe(false);
    },
  );
});

describe("register passthrough", () => {
  it.each([
    ["no name or type", { effort: "high" }],
    ["empty name and type", { name: "", type: "" }],
  ])("passes props with %s through untouched", async (_n, props) => {
    const read = vi.fn(() => Promise.resolve({ NO_COLOR: "1" }));
    const { run } = setup({ settings: { read } });
    const first = run({ ...props });
    await settle();
    const second = run({ ...props });
    for (const { out } of [first, second]) {
      expect(out.props).toEqual(props);
      expect(out.props).not.toHaveProperty("body");
    }
  });
});
