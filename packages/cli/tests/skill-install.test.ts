// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, installSkillGuarded } from "../src/plugin.js";
import type { SkillSpec } from "../src/skill-spec.js";
import { FIX_AND_RERUN_ADVICE, FRESH_RETRY } from "../src/fs-guard.js";
import { DEMO_FILES, DEMO_SPEC, writeDemoSource } from "./skill-fixture.js";

let root: string;
let source: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-install-"));
  source = join(root, "source");
  target = join(root, "target");
  mkdirSync(target);
  writeDemoSource(source);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const claudeDir = (): string => join(target, ".claude", "skills", "demo");
const groundworkDir = (): string => join(target, ".groundwork", "demo");

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("installSkill (fresh policy)", () => {
  it("writes the payload with SKILL.md last and returns relative paths", () => {
    const { filesWritten } = installSkill(DEMO_SPEC, target, source);
    expect(filesWritten).toEqual([
      join(".claude", "skills", "demo", "data.txt"),
      join(".claude", "skills", "demo", "step-1.md"),
      join(".claude", "skills", "demo", "SKILL.md"),
    ]);
    for (const [name, content] of Object.entries(DEMO_FILES)) {
      expect(readFileSync(join(claudeDir(), name), "utf8")).toBe(content);
    }
  });

  it("writes nothing when an identical copy is already there", () => {
    installSkill(DEMO_SPEC, target, source);
    expect(installSkill(DEMO_SPEC, target, source).filesWritten).toEqual([]);
  });

  it("overwrites a differing copy", () => {
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(join(claudeDir(), "SKILL.md"), "stale");
    writeFileSync(join(claudeDir(), "data.txt"), "stale");
    const { filesWritten } = installSkill(DEMO_SPEC, target, source);
    expect(filesWritten).toHaveLength(3);
    expect(readFileSync(join(claudeDir(), "SKILL.md"), "utf8")).toBe(
      DEMO_FILES["SKILL.md"],
    );
    expect(readFileSync(join(claudeDir(), "data.txt"), "utf8")).toBe(
      DEMO_FILES["data.txt"],
    );
  });

  it("names the skill in a missing-source error and writes nothing", () => {
    const missing = DEMO_SPEC.sourceFile(source, "data.txt");
    rmSync(missing);
    const thrown = capture(() => installSkill(DEMO_SPEC, target, source));
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message.startsWith("could not install the /demo skill: ")).toBe(
      true,
    );
    expect(message).toContain(
      `the /demo skill's source file is missing: ${missing}`,
    );
    expect(existsSync(join(target, ".claude"))).toBe(false);
  });
});

describe("installSkillGuarded", () => {
  it("installs into .claude/skills/<name> in an empty project", () => {
    const result = installSkillGuarded(DEMO_SPEC, target, source);
    expect(result.location).toBe("claude");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.fallbackCause).toBeUndefined();
    expect(result.filesWritten.at(-1)).toBe(
      join(".claude", "skills", "demo", "SKILL.md"),
    );
    expect(result.filesWritten).toHaveLength(3);
  });

  it("reports already-present for an identical copy and writes nothing", () => {
    installSkill(DEMO_SPEC, target, source);
    const result = installSkillGuarded(DEMO_SPEC, target, source);
    expect(result).toEqual({ filesWritten: [], location: "already-present" });
  });

  it("falls back to .groundwork/<name> when the project owns a differing entry", () => {
    mkdirSync(claudeDir(), { recursive: true });
    const own = join(claudeDir(), "SKILL.md");
    writeFileSync(own, "project's own");
    const result = installSkillGuarded(DEMO_SPEC, target, source);
    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("entry");
    expect(result.fallbackReason).toContain(own);
    expect(result.fallbackReason).toContain("/demo skill");
    expect(result.filesWritten.at(-1)).toBe(
      join(".groundwork", "demo", "SKILL.md"),
    );
    expect(readFileSync(own, "utf8")).toBe("project's own");
    expect(readFileSync(join(groundworkDir(), "SKILL.md"), "utf8")).toBe(
      DEMO_FILES["SKILL.md"],
    );
  });

  it("falls back with cause component when .claude/skills is a symlink", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(target, ".claude"));
    symlinkSync(elsewhere, join(target, ".claude", "skills"));
    const result = installSkillGuarded(DEMO_SPEC, target, source);
    expect(result.location).toBe("groundwork");
    expect(result.fallbackCause).toBe("component");
    expect(result.fallbackReason).toContain(join(target, ".claude", "skills"));
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(groundworkDir(), "SKILL.md"))).toBe(true);
  });

  it("replaces a stale cli-owned fallback copy", () => {
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(join(claudeDir(), "SKILL.md"), "project's own");
    mkdirSync(groundworkDir(), { recursive: true });
    writeFileSync(join(groundworkDir(), "SKILL.md"), "old");
    installSkillGuarded(DEMO_SPEC, target, source);
    expect(readFileSync(join(groundworkDir(), "SKILL.md"), "utf8")).toBe(
      DEMO_FILES["SKILL.md"],
    );
  });

  it("names the skill in a missing-source error and writes nothing", () => {
    const missing = DEMO_SPEC.sourceFile(source, "step-1.md");
    rmSync(missing);
    const thrown = capture(() =>
      installSkillGuarded(DEMO_SPEC, target, source),
    );
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message.startsWith("could not install the /demo skill: ")).toBe(
      true,
    );
    expect(message).toContain(
      `the /demo skill's source file is missing: ${missing}`,
    );
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("invalid specs are refused before anything is written", () => {
  const invalid: readonly [string, SkillSpec][] = [
    ["empty writeOrder", { ...DEMO_SPEC, writeOrder: [] }],
    [
      "entry file not last",
      { ...DEMO_SPEC, writeOrder: ["SKILL.md", "data.txt"] },
    ],
    [
      "parent-directory file name",
      { ...DEMO_SPEC, writeOrder: ["../x", "SKILL.md"] },
    ],
    [
      "file name with a separator",
      { ...DEMO_SPEC, writeOrder: ["a/b", "SKILL.md"] },
    ],
    ["empty file name", { ...DEMO_SPEC, writeOrder: ["", "SKILL.md"] }],
    ["dot file name", { ...DEMO_SPEC, writeOrder: [".", "SKILL.md"] }],
    ["dot-dot file name", { ...DEMO_SPEC, writeOrder: ["..", "SKILL.md"] }],
    ["empty claudeSegments", { ...DEMO_SPEC, claudeSegments: [] }],
    ["empty fallbackSegments", { ...DEMO_SPEC, fallbackSegments: [] }],
    ...["", "Demo", "a b", "a\nb", "../x", "-x"].map(
      (name): [string, SkillSpec] => [
        `bad name ${JSON.stringify(name)}`,
        { ...DEMO_SPEC, name },
      ],
    ),
    [
      "entry file repeated earlier",
      { ...DEMO_SPEC, writeOrder: ["SKILL.md", "a.ts", "SKILL.md"] },
    ],
    [
      "case-insensitive duplicate",
      { ...DEMO_SPEC, writeOrder: ["a.md", "A.md", "SKILL.md"] },
    ],
    [
      "case-variant of the entry file",
      { ...DEMO_SPEC, writeOrder: ["skill.md", "a.ts", "SKILL.md"] },
    ],
    [
      "NFC-equivalent duplicate",
      {
        ...DEMO_SPEC,
        writeOrder: ["\u00e9.ts", "e\u0301.ts", "SKILL.md"],
      },
    ],
    [
      "claudeSegments not rooted at .claude",
      { ...DEMO_SPEC, claudeSegments: ["skills", "demo"] },
    ],
    [
      "claudeSegments rooted at .Claude",
      { ...DEMO_SPEC, claudeSegments: [".Claude", "skills", "demo"] },
    ],
    [
      "fallback outside .groundwork",
      { ...DEMO_SPEC, fallbackSegments: ["src"] },
    ],
    [
      "fallback inside .claude",
      { ...DEMO_SPEC, fallbackSegments: [".claude", "skills", "demo"] },
    ],
    [
      "fallback equal to claude",
      {
        ...DEMO_SPEC,
        claudeSegments: [".claude"],
        fallbackSegments: [".claude"],
      },
    ],
    [
      "fallback differing from claude only in case",
      {
        ...DEMO_SPEC,
        claudeSegments: [".claude", "skills", "demo"],
        fallbackSegments: [".Claude", "skills", "demo"],
      },
    ],
    ...(["", ".", "..", "a/b", "a\\b"] as const).flatMap(
      (segment): [string, SkillSpec][] => [
        [
          `claudeSegments unsafe segment ${JSON.stringify(segment)}`,
          { ...DEMO_SPEC, claudeSegments: [".claude", segment] },
        ],
        [
          `fallbackSegments unsafe segment ${JSON.stringify(segment)}`,
          { ...DEMO_SPEC, fallbackSegments: [".groundwork", segment] },
        ],
      ],
    ),
  ];

  const hasControlCharacter = (text: string): boolean =>
    [...text].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });

  const expectInvalidSpecMessage = (thrown: unknown): void => {
    expectPlainError(thrown);
    const message = (thrown as Error).message;
    expect(message.startsWith("invalid skill spec")).toBe(true);
    expect(hasControlCharacter(message)).toBe(false);
  };

  // A plain Error (its own prototype), so a TypeError from a missing export
  // or a crash deeper in cannot satisfy this.
  const expectPlainError = (thrown: unknown): void => {
    expect(thrown).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(thrown)).toBe(Error.prototype);
  };

  it.each(invalid)("%s: installSkill throws a plain Error", (_label, spec) => {
    expectInvalidSpecMessage(capture(() => installSkill(spec, target, source)));
    expect(readdirSync(target)).toEqual([]);
  });

  it.each(invalid)(
    "%s: installSkillGuarded throws a plain Error",
    (_label, spec) => {
      expectInvalidSpecMessage(
        capture(() => installSkillGuarded(spec, target, source)),
      );
      expect(readdirSync(target)).toEqual([]);
    },
  );
});

describe("the installer uses only the validated copy of the spec", () => {
  function mutatingSpec(): SkillSpec {
    const writeOrder = ["data.txt", "step-1.md", "SKILL.md"];
    const claudeSegments = [".claude", "skills", "demo"];
    const spec: SkillSpec = {
      ...DEMO_SPEC,
      writeOrder,
      claudeSegments,
      sourceFile: (sourceDir, fileName) => {
        writeOrder.push("extra.txt");
        writeOrder[0] = "evil.txt";
        claudeSegments[2] = "evil";
        return DEMO_SPEC.sourceFile(sourceDir, fileName);
      },
    };
    return spec;
  }

  beforeEach(() => {
    writeFileSync(join(source, "src", "extra.txt"), "extra");
    writeFileSync(join(source, "src", "evil.txt"), "evil");
  });

  it("installSkill writes exactly the list it validated", () => {
    const { filesWritten } = installSkill(mutatingSpec(), target, source);
    expect(filesWritten).toEqual([
      join(".claude", "skills", "demo", "data.txt"),
      join(".claude", "skills", "demo", "step-1.md"),
      join(".claude", "skills", "demo", "SKILL.md"),
    ]);
    expect(readdirSync(claudeDir()).sort()).toEqual([
      "SKILL.md",
      "data.txt",
      "step-1.md",
    ]);
  });

  it("installSkillGuarded writes exactly the list it validated", () => {
    const { filesWritten } = installSkillGuarded(
      mutatingSpec(),
      target,
      source,
    );
    expect(filesWritten).toEqual([
      join(".claude", "skills", "demo", "data.txt"),
      join(".claude", "skills", "demo", "step-1.md"),
      join(".claude", "skills", "demo", "SKILL.md"),
    ]);
    expect(readdirSync(claudeDir()).sort()).toEqual([
      "SKILL.md",
      "data.txt",
      "step-1.md",
    ]);
  });
});

describe("a failing sourceFile callback", () => {
  const boom = new Error("callback exploded");
  const throwing: SkillSpec = {
    ...DEMO_SPEC,
    sourceFile: () => {
      throw boom;
    },
  };
  const nonString: SkillSpec = {
    ...DEMO_SPEC,
    sourceFile: () => 42 as unknown as string,
  };

  it.each([
    ["throws", throwing],
    ["returns a non-string", nonString],
  ] as const)(
    "installSkill: %s -> install failure, nothing written",
    (_l, spec) => {
      const thrown = capture(() => installSkill(spec, target, source));
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith("could not install the /demo skill: ")).toBe(
        true,
      );
      expect(message.endsWith(FRESH_RETRY)).toBe(true);
      expect(existsSync(join(target, ".claude"))).toBe(false);
    },
  );

  it.each([
    ["throws", throwing],
    ["returns a non-string", nonString],
  ] as const)(
    "installSkillGuarded: %s -> install failure, nothing written",
    (_l, spec) => {
      const thrown = capture(() => installSkillGuarded(spec, target, source));
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.startsWith("could not install the /demo skill: ")).toBe(
        true,
      );
      expect(message.endsWith(FIX_AND_RERUN_ADVICE)).toBe(true);
      expect(readdirSync(target)).toEqual([]);
    },
  );

  it("keeps the callback's error as the cause", () => {
    const fresh = capture(() => installSkill(throwing, target, source));
    expect((fresh as Error).cause).toBe(boom);
    const guarded = capture(() =>
      installSkillGuarded(throwing, target, source),
    );
    expect((guarded as Error).cause).toBe(boom);
  });
});
