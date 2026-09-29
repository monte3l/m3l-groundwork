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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fieldText, parseFrontmatter } from "../src/harness/frontmatter.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const corePath = join(repoRoot, "templates", "core", ".claude", "skills");
const corpusPath = join(repoRoot, "evals", "core-harness", "triggers.json");
const packsHarnessCorpusPath = join(
  repoRoot,
  "evals",
  "packs-harness",
  "triggers.json",
);
const packsRoot = join(repoRoot, "templates", "packs");

interface Entry {
  skill: string;
  query: string;
  should_trigger: boolean;
}
interface Case {
  dir: string;
  prompt: string;
  grader: string;
}
interface Scored {
  name: string;
  score: number;
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// harness-parity.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "eval-lib.mjs")).href
)) as {
  validateCorpus: (corpus: unknown) => Entry[];
  buildTriggerCases: (corpus: Entry[], tag?: string) => Case[];
  writeHarnessPlugin: (params: {
    skillsDir?: string;
    skillsDirs?: string[];
    corpus: unknown;
    outDir: string;
    name?: string;
    description?: string;
    tag?: string;
  }) => number;
  writeSkillPlugin: (params: {
    skillsDir?: string;
    skillsDirs?: string[];
    outDir: string;
    name: string;
    description: string;
  }) => void;
  listPackSkillDirs: (packsRoot: string) => string[];
  coreHarnessParams: (root: string) => {
    skillsDir: string;
    corpus: unknown;
  };
  packsHarnessParams: (root: string) => {
    skillsDirs: string[];
    corpus: unknown;
    name: string;
    description: string;
    tag: string;
  };
  writeToolchainPlugin: (params: {
    skillsDir: string;
    casesDir: string;
    outDir: string;
    cliPath: string;
  }) => number;
  CLI_PLACEHOLDER: string;
  evalArgs: (options: Record<string, unknown>) => string[];
  summarizeRun: (result: unknown) => {
    cases: { name: string; score: number; delta: number | null }[];
    costUsd: number;
    partial: boolean;
    partialReason: string | null;
  };
  compareToBaseline: (
    cases: Scored[],
    baseline: Record<string, number> | undefined,
    options?: { filtered?: boolean },
  ) => {
    regressions: { name: string; was: number; now: number }[];
    unbaselined: string[];
    missing: string[];
  };
  withSuiteScores: (
    baseline: unknown,
    suite: string,
    cases: Scored[],
    merge?: boolean,
  ) => {
    schemaVersion: number;
    suites: Record<string, Record<string, number>>;
  };
  SUITES: string[];
  parseArgs: (argv: string[]) => {
    suite: string;
    runs: number;
    maxCostUsd: number;
    model: string;
    judgeModel: string;
    ablation: string;
    threshold: number | undefined;
    caseGlob: string | undefined;
    concurrency: number | undefined;
    check: boolean;
    update: boolean;
    keepTemp: boolean;
  };
  shouldUpdateBaseline: (summary: {
    cases: Scored[];
    costUsd: number;
    partial: boolean;
    partialReason: string | null;
  }) => boolean;
  baselineMissingForCheck: (check: boolean, baseline: unknown) => boolean;
  suiteMissingForCheck: (
    check: boolean,
    baseline: unknown,
    suite: string,
  ) => boolean;
};

const good: Entry = {
  skill: "starting-work",
  query: "Do X.",
  should_trigger: true,
};

describe("validateCorpus", () => {
  it("accepts a well-formed corpus and returns it", () => {
    expect(lib.validateCorpus([good])).toEqual([good]);
  });

  it.each([
    ["not an array", {}],
    ["empty", []],
    ["a bad skill name", [{ ...good, skill: "../etc" }]],
    ["an empty query", [{ ...good, query: "  " }]],
    ["a non-boolean should_trigger", [{ ...good, should_trigger: "yes" }]],
  ])("rejects %s rather than dropping it silently", (_label, corpus) => {
    expect(() => lib.validateCorpus(corpus)).toThrow();
  });
});

describe("buildTriggerCases", () => {
  const cases = lib.buildTriggerCases([
    good,
    { ...good, query: "Do Y." },
    { skill: "starting-work", query: "Explain Z.", should_trigger: false },
  ]);

  it("numbers cases per skill and kind", () => {
    expect(cases.map((c) => c.dir)).toEqual([
      "starting-work-fires-1",
      "starting-work-fires-2",
      "starting-work-quiet-1",
    ]);
  });

  it("makes a positive grader require the skill and a negative one forbid it", () => {
    const positive = parseFrontmatter(cases[0]?.grader ?? "");
    const negative = parseFrontmatter(cases[2]?.grader ?? "");
    if (!positive.ok || !negative.ok) throw new Error("grader must parse");
    expect(fieldText(positive.fields, "min")).toBeUndefined();
    expect(fieldText(negative.fields, "min")).toBe("0");
    expect(fieldText(negative.fields, "max")).toBe("0");
  });

  it("emits an input_match that matches the bare and plugin-namespaced skill call, and nothing longer", () => {
    const parsed = parseFrontmatter(cases[0]?.grader ?? "");
    if (!parsed.ok) throw new Error("grader must parse");
    const pattern = new RegExp(fieldText(parsed.fields, "input_match") ?? "");
    expect(pattern.test('{"skill": "starting-work"}')).toBe(true);
    expect(pattern.test('{"skill":"m3l-baseline-harness:starting-work"}')).toBe(
      true,
    );
    expect(pattern.test('{"skill": "starting-work-extra"}')).toBe(false);
    expect(pattern.test('{"skill": "writing-commits"}')).toBe(false);
  });

  it("caps turns, grants only read-only tools plus Skill, and tags the case", () => {
    const parsed = parseFrontmatter(cases[0]?.prompt ?? "");
    if (!parsed.ok) throw new Error("prompt must parse");
    expect(fieldText(parsed.fields, "max_turns")).toBe("2");
    expect(parsed.fields.get("allowed_tools")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Skill",
    ]);
    expect(parsed.fields.get("tags")).toEqual([
      "core-harness",
      "starting-work",
      "positive",
    ]);
    expect(parsed.body.trim()).toBe("Do X.");
  });

  it("uses the given tag in place of the default core-harness tag", () => {
    const tagged = lib.buildTriggerCases([good], "packs-harness");
    const parsed = parseFrontmatter(tagged[0]?.prompt ?? "");
    if (!parsed.ok) throw new Error("prompt must parse");
    expect(parsed.fields.get("tags")).toEqual([
      "packs-harness",
      "starting-work",
      "positive",
    ]);
  });
});

describe("writeHarnessPlugin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-lib-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function skills(...names: string[]): string {
    const skillsDir = join(dir, "skills-src");
    for (const name of names) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(
        join(skillsDir, name, "SKILL.md"),
        `---\nname: ${name}\n---\n`,
      );
    }
    return skillsDir;
  }

  it("writes a plugin manifest, the skills, and one case per corpus entry", () => {
    const out = join(dir, "out");
    const count = lib.writeHarnessPlugin({
      skillsDir: skills("starting-work"),
      corpus: [good, { ...good, should_trigger: false }],
      outDir: out,
    });
    expect(count).toBe(2);
    expect(existsSync(join(out, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(out, "skills", "starting-work", "SKILL.md"))).toBe(
      true,
    );
    expect(readdirSync(join(out, "evals")).sort()).toEqual([
      "starting-work-fires-1",
      "starting-work-quiet-1",
    ]);
    expect(
      readFileSync(
        join(out, "evals", "starting-work-fires-1", "prompt.md"),
        "utf8",
      ),
    ).toContain("Do X.");
  });

  it("fails loudly when the corpus names a skill that does not exist", () => {
    expect(() =>
      lib.writeHarnessPlugin({
        skillsDir: skills("other-skill"),
        corpus: [good],
        outDir: join(dir, "out"),
      }),
    ).toThrow(/starting-work/);
  });

  it("finds the corpus's skill across skillsDirs regardless of which entry holds it", () => {
    const dirA = skills("unrelated-skill");
    const dirB = join(dir, "skills-src-2");
    mkdirSync(join(dirB, "starting-work"), { recursive: true });
    writeFileSync(
      join(dirB, "starting-work", "SKILL.md"),
      "---\nname: starting-work\n---\n",
    );
    const out = join(dir, "out");
    const count = lib.writeHarnessPlugin({
      skillsDirs: [dirA, dirB],
      corpus: [good],
      outDir: out,
    });
    expect(count).toBe(1);
    expect(existsSync(join(out, "skills", "starting-work", "SKILL.md"))).toBe(
      true,
    );
  });

  it("throws when the corpus names a skill present in neither skillsDirs entry", () => {
    const dirA = skills("other-a");
    const dirB = join(dir, "skills-src-2");
    mkdirSync(join(dirB, "other-b"), { recursive: true });
    writeFileSync(
      join(dirB, "other-b", "SKILL.md"),
      "---\nname: other-b\n---\n",
    );
    expect(() =>
      lib.writeHarnessPlugin({
        skillsDirs: [dirA, dirB],
        corpus: [good],
        outDir: join(dir, "out"),
      }),
    ).toThrow(/starting-work/);
  });

  it("passes tag through to the generated cases' frontmatter", () => {
    const out = join(dir, "out");
    lib.writeHarnessPlugin({
      skillsDir: skills("starting-work"),
      corpus: [good],
      outDir: out,
      tag: "packs-harness",
    });
    const prompt = readFileSync(
      join(out, "evals", "starting-work-fires-1", "prompt.md"),
      "utf8",
    );
    const parsed = parseFrontmatter(prompt);
    if (!parsed.ok) throw new Error("prompt must parse");
    expect(parsed.fields.get("tags")).toEqual([
      "packs-harness",
      "starting-work",
      "positive",
    ]);
  });

  it("writes an overridden name and description into the plugin manifest", () => {
    const out = join(dir, "out");
    lib.writeHarnessPlugin({
      skillsDir: skills("starting-work"),
      corpus: [good],
      outDir: out,
      name: "custom-name",
      description: "custom desc",
    });
    expect(
      JSON.parse(
        readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"),
      ),
    ).toMatchObject({ name: "custom-name", description: "custom desc" });
  });
});

describe("writeSkillPlugin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-lib-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the manifest it was given and copies the skills", () => {
    const skillsDir = join(dir, "src");
    mkdirSync(join(skillsDir, "one"), { recursive: true });
    writeFileSync(join(skillsDir, "one", "SKILL.md"), "---\nname: one\n---\n");
    const out = join(dir, "out");
    lib.writeSkillPlugin({
      skillsDir,
      outDir: out,
      name: "my-plugin",
      description: "A description.",
    });
    expect(
      JSON.parse(
        readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"),
      ),
    ).toEqual({
      name: "my-plugin",
      version: "0.0.0",
      description: "A description.",
      author: { name: "m3l-groundwork" },
    });
    expect(existsSync(join(out, "skills", "one", "SKILL.md"))).toBe(true);
  });

  it("merges skillsDirs into one skills tree", () => {
    const dirA = join(dir, "a");
    const dirB = join(dir, "b");
    mkdirSync(join(dirA, "skill-a"), { recursive: true });
    writeFileSync(
      join(dirA, "skill-a", "SKILL.md"),
      "---\nname: skill-a\n---\n",
    );
    mkdirSync(join(dirB, "skill-b"), { recursive: true });
    writeFileSync(
      join(dirB, "skill-b", "SKILL.md"),
      "---\nname: skill-b\n---\n",
    );
    const out = join(dir, "out");
    lib.writeSkillPlugin({
      skillsDirs: [dirA, dirB],
      outDir: out,
      name: "merged",
      description: "d",
    });
    expect(existsSync(join(out, "skills", "skill-a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(out, "skills", "skill-b", "SKILL.md"))).toBe(true);
  });

  it("throws when given both skillsDir and skillsDirs", () => {
    expect(() =>
      lib.writeSkillPlugin({
        skillsDir: join(dir, "a"),
        skillsDirs: [join(dir, "b")],
        outDir: join(dir, "out"),
        name: "n",
        description: "d",
      }),
    ).toThrow(/not both/);
  });

  it("throws when given neither skillsDir nor skillsDirs", () => {
    expect(() =>
      lib.writeSkillPlugin({
        outDir: join(dir, "out"),
        name: "n",
        description: "d",
      }),
    ).toThrow(/is required/);
  });

  it("throws when skillsDirs is an empty array", () => {
    expect(() =>
      lib.writeSkillPlugin({
        skillsDirs: [],
        outDir: join(dir, "out"),
        name: "n",
        description: "d",
      }),
    ).toThrow(/must not be empty/);
  });

  it("throws naming the skill when two skillsDirs entries both contain it", () => {
    const dirA = join(dir, "a");
    const dirB = join(dir, "b");
    mkdirSync(join(dirA, "dup-skill"), { recursive: true });
    writeFileSync(
      join(dirA, "dup-skill", "SKILL.md"),
      "---\nname: dup-skill\n---\n",
    );
    mkdirSync(join(dirB, "dup-skill"), { recursive: true });
    writeFileSync(
      join(dirB, "dup-skill", "SKILL.md"),
      "---\nname: dup-skill\n---\n",
    );
    expect(() =>
      lib.writeSkillPlugin({
        skillsDirs: [dirA, dirB],
        outDir: join(dir, "out"),
        name: "n",
        description: "d",
      }),
    ).toThrow(/dup-skill/);
  });

  it("throws when a skillsDirs entry does not exist on disk", () => {
    const dirA = join(dir, "a");
    mkdirSync(join(dirA, "skill-a"), { recursive: true });
    writeFileSync(
      join(dirA, "skill-a", "SKILL.md"),
      "---\nname: skill-a\n---\n",
    );
    const missing = join(dir, "does-not-exist");
    expect(() =>
      lib.writeSkillPlugin({
        skillsDirs: [dirA, missing],
        outDir: join(dir, "out"),
        name: "n",
        description: "d",
      }),
    ).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not half-merge: a collision detected in a later dir leaves an earlier, non-colliding dir's skill uncopied", () => {
    const dirA = join(dir, "a");
    const dirB = join(dir, "b");
    mkdirSync(join(dirA, "skill-a"), { recursive: true });
    writeFileSync(
      join(dirA, "skill-a", "SKILL.md"),
      "---\nname: skill-a\n---\n",
    );
    // dirB collides with dirA on "skill-a", so pass 1 must throw before any
    // copy happens -- even though dirA alone would have succeeded.
    mkdirSync(join(dirB, "skill-a"), { recursive: true });
    writeFileSync(
      join(dirB, "skill-a", "SKILL.md"),
      "---\nname: skill-a (dup)\n---\n",
    );
    const out = join(dir, "out");
    expect(() =>
      lib.writeSkillPlugin({
        skillsDirs: [dirA, dirB],
        outDir: out,
        name: "n",
        description: "d",
      }),
    ).toThrow(/dup/i);
    expect(existsSync(join(out, "skills", "skill-a"))).toBe(false);
  });

  it("leaves writeHarnessPlugin's manifest byte-identical after the extraction", () => {
    const skillsDir = join(dir, "src");
    mkdirSync(join(skillsDir, "starting-work"), { recursive: true });
    writeFileSync(join(skillsDir, "starting-work", "SKILL.md"), "---\n---\n");
    const out = join(dir, "out");
    lib.writeHarnessPlugin({ skillsDir, corpus: [good], outDir: out });
    expect(
      JSON.parse(
        readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"),
      ),
    ).toEqual({
      name: "m3l-baseline-harness",
      version: "0.0.0",
      description:
        "Throwaway wrapper over templates/core's skills, generated to evaluate their triggering.",
      author: { name: "m3l-groundwork" },
    });
  });
});

describe("writeToolchainPlugin", () => {
  let dir: string;
  let skillsDir: string;
  let casesDir: string;
  const cliPath = "/opt/m3l/packages/cli/bin/m3l-groundwork.mjs";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-lib-"));
    skillsDir = join(dir, "skills-src");
    casesDir = join(dir, "cases");
    mkdirSync(join(skillsDir, "typescript-guidance"), { recursive: true });
    writeFileSync(
      join(skillsDir, "typescript-guidance", "SKILL.md"),
      "---\nname: typescript-guidance\n---\n",
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCase(name: string, omit: string[] = []): void {
    const caseDir = join(casesDir, name);
    mkdirSync(join(caseDir, "graders"), { recursive: true });
    const files: Record<string, string> = {
      "case.yaml": "name: x\n",
      "prompt.md": "hi\n",
      "fixture.sh": `#!/bin/sh\nCLI="${lib.CLI_PLACEHOLDER}"\nnode "$CLI" .\n`,
    };
    for (const [file, content] of Object.entries(files)) {
      if (!omit.includes(file)) writeFileSync(join(caseDir, file), content);
    }
    if (!omit.includes("graders")) {
      writeFileSync(join(caseDir, "graders", "g.md"), "---\ntype: llm\n---\n");
    } else {
      rmSync(join(caseDir, "graders"), { recursive: true });
    }
  }

  it("wraps the skills and installs each authored case with the CLI path baked in", () => {
    writeCase("repair");
    const out = join(dir, "out");
    const count = lib.writeToolchainPlugin({
      skillsDir,
      casesDir,
      outDir: out,
      cliPath,
    });
    expect(count).toBe(1);
    expect(
      JSON.parse(
        readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"),
      ) as { name: string },
    ).toMatchObject({ name: "m3l-baseline-toolchain" });
    expect(
      existsSync(join(out, "skills", "typescript-guidance", "SKILL.md")),
    ).toBe(true);
    const fixture = readFileSync(
      join(out, "evals", "repair", "fixture.sh"),
      "utf8",
    );
    expect(fixture).toContain(`CLI="${cliPath}"`);
    expect(fixture).not.toContain(lib.CLI_PLACEHOLDER);
    expect(existsSync(join(out, "evals", "repair", "graders", "g.md"))).toBe(
      true,
    );
  });

  it("installs every case directory it finds", () => {
    writeCase("one");
    writeCase("two");
    expect(
      lib.writeToolchainPlugin({
        skillsDir,
        casesDir,
        outDir: join(dir, "out"),
        cliPath,
      }),
    ).toBe(2);
  });

  it("does not modify the authored case it copies from", () => {
    writeCase("repair");
    lib.writeToolchainPlugin({
      skillsDir,
      casesDir,
      outDir: join(dir, "out"),
      cliPath,
    });
    expect(
      readFileSync(join(casesDir, "repair", "fixture.sh"), "utf8"),
    ).toContain(lib.CLI_PLACEHOLDER);
  });

  it.each(["case.yaml", "prompt.md", "fixture.sh", "graders"])(
    "throws when a case is missing %s",
    (missing) => {
      writeCase("repair", [missing]);
      expect(() =>
        lib.writeToolchainPlugin({
          skillsDir,
          casesDir,
          outDir: join(dir, "out"),
          cliPath,
        }),
      ).toThrow(new RegExp(`missing ${missing}`));
    },
  );

  it("throws when there are no cases, rather than evaluating nothing", () => {
    mkdirSync(casesDir, { recursive: true });
    expect(() =>
      lib.writeToolchainPlugin({
        skillsDir,
        casesDir,
        outDir: join(dir, "out"),
        cliPath,
      }),
    ).toThrow(/no cases found/);
  });

  it("throws when a fixture never uses the CLI placeholder", () => {
    writeCase("repair");
    writeFileSync(join(casesDir, "repair", "fixture.sh"), "#!/bin/sh\ntrue\n");
    expect(() =>
      lib.writeToolchainPlugin({
        skillsDir,
        casesDir,
        outDir: join(dir, "out"),
        cliPath,
      }),
    ).toThrow(/never uses __M3L_CLI__/);
  });

  it.each(['/a"b', "/a$b", "/a`b", "/a b", "/a\\b"])(
    "rejects a CLI path that could break out of the quoted shell assignment: %s",
    (bad) => {
      writeCase("repair");
      expect(() =>
        lib.writeToolchainPlugin({
          skillsDir,
          casesDir,
          outDir: join(dir, "out"),
          cliPath: bad,
        }),
      ).toThrow(/plain path/);
    },
  );

  it("accepts the repo's real authored case", () => {
    const out = join(dir, "real");
    expect(
      lib.writeToolchainPlugin({
        skillsDir: corePath,
        casesDir: join(repoRoot, "evals", "core-toolchain"),
        outDir: out,
        cliPath,
      }),
    ).toBeGreaterThan(0);
    expect(readdirSync(join(out, "evals"))).toContain("toolchain-repair");
    const graders = readdirSync(
      join(out, "evals", "toolchain-repair", "graders"),
    );
    expect(graders.sort()).toEqual([
      "holds-the-floor.md",
      "names-the-findings.md",
      "never-edits.md",
      "skill-fired.md",
    ]);
  });
});

describe("evalArgs", () => {
  const base = {
    target: "/t",
    jsonPath: "/t/r.json",
    outputDir: "/t/out",
    runs: 3,
    maxCostUsd: 5,
    model: "m",
    judgeModel: "j",
    ablation: "none",
  };

  it("always trusts the plugin and refuses to publish the report", () => {
    const args = lib.evalArgs(base);
    expect(args.slice(0, 3)).toEqual(["plugin", "eval", "/t"]);
    expect(args).toContain("--trust-plugin");
    expect(args).toContain("--no-publish");
    expect(args.join(" ")).toContain(
      "--runs 3 --max-cost-usd 5 --model m --judge-model j --ablation none",
    );
  });

  it("adds --threshold, --scaffold, --keep-temp, and --case only when asked", () => {
    expect(lib.evalArgs(base)).not.toContain("--threshold");
    expect(lib.evalArgs(base)).not.toContain("--scaffold");
    expect(lib.evalArgs(base)).not.toContain("--case");
    expect(lib.evalArgs(base)).not.toContain("--concurrency");
    expect(lib.evalArgs(base)).not.toContain("--allow-tools");
    const args = lib.evalArgs({
      ...base,
      threshold: 0,
      scaffold: true,
      keepTemp: true,
      caseGlob: "adopt-*",
      concurrency: 4,
      allowTools: ["Write", "Edit"],
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--threshold",
        "0",
        "--scaffold",
        "--keep-temp",
        "--case",
        "adopt-*",
        "--concurrency",
        "4",
      ]),
    );
    // Variadic, so it must be last or it swallows whatever follows.
    expect(args.slice(-3)).toEqual(["--allow-tools", "Write", "Edit"]);
  });
});

describe("SUITES", () => {
  it("names the four eval suites", () => {
    expect(lib.SUITES).toEqual(["plugin", "harness", "packs", "toolchain"]);
  });
});

describe("parseArgs", () => {
  it("defaults every option when no flags are given", () => {
    expect(lib.parseArgs([])).toEqual({
      suite: "all",
      runs: 1,
      maxCostUsd: 5,
      model: "claude-sonnet-5",
      judgeModel: "claude-haiku-4-5",
      ablation: "none",
      threshold: undefined,
      caseGlob: undefined,
      concurrency: undefined,
      check: false,
      update: false,
      keepTemp: false,
    });
  });

  it("parses every flag into its option, including the -j alias", () => {
    expect(
      lib.parseArgs([
        "--suite",
        "harness",
        "--runs",
        "3",
        "--max-cost-usd",
        "10",
        "--model",
        "m",
        "--judge-model",
        "j",
        "--ablation",
        "with-without",
        "--threshold",
        "0.8",
        "--case",
        "adopt-*",
        "-j",
        "4",
        "--check",
        "--keep-temp",
      ]),
    ).toEqual({
      suite: "harness",
      runs: 3,
      maxCostUsd: 10,
      model: "m",
      judgeModel: "j",
      ablation: "with-without",
      threshold: 0.8,
      caseGlob: "adopt-*",
      concurrency: 4,
      check: true,
      update: false,
      keepTemp: true,
    });
  });

  it("accepts --concurrency as the long form of -j", () => {
    expect(lib.parseArgs(["--concurrency", "2"]).concurrency).toBe(2);
  });

  it.each([
    ["an unknown --suite value", ["--suite", "bogus"]],
    ["a zero --runs", ["--runs", "0"]],
    ["a non-integer --runs", ["--runs", "1.5"]],
    ["a zero --max-cost-usd", ["--max-cost-usd", "0"]],
    ["a negative --max-cost-usd", ["--max-cost-usd", "-1"]],
    ["a --concurrency below 1", ["--concurrency", "0"]],
    ["a --concurrency above 8", ["--concurrency", "9"]],
    ["a non-integer --concurrency", ["--concurrency", "2.5"]],
    ["an unknown --ablation value", ["--ablation", "bogus"]],
    ["both --check and --update", ["--check", "--update"]],
    ["an unrecognized argument", ["--nope"]],
    ["a flag with no value", ["--suite"]],
    ["a flag given an empty string instead of a value", ["--threshold", ""]],
  ])("throws on %s", (_label, argv) => {
    expect(() => lib.parseArgs(argv)).toThrow();
  });

  it.each([
    ["above 1", "1.5"],
    ["below 0", "-0.1"],
    ["not a number", "abc"],
  ])("rejects a --threshold that is %s", (_label, value) => {
    expect(() => lib.parseArgs(["--threshold", value])).toThrow();
  });

  it("accepts a --threshold within 0..1", () => {
    expect(lib.parseArgs(["--threshold", "0.8"]).threshold).toBe(0.8);
  });

  it.each([
    ["0, the lower inclusive boundary", "0", 0],
    ["1, the upper inclusive boundary", "1", 1],
  ])("accepts a --threshold of %s", (_label, value, expected) => {
    expect(lib.parseArgs(["--threshold", value]).threshold).toBe(expected);
  });

  it("leaves threshold undefined when --threshold is not given", () => {
    expect(lib.parseArgs([]).threshold).toBeUndefined();
  });
});

describe("shouldUpdateBaseline", () => {
  it("refuses to update the baseline from a partial run", () => {
    expect(
      lib.shouldUpdateBaseline({
        cases: [],
        costUsd: 0.1,
        partial: true,
        partialReason: "cost_ceiling",
      }),
    ).toBe(false);
  });

  it("allows updating the baseline from a complete run", () => {
    expect(
      lib.shouldUpdateBaseline({
        cases: [{ name: "a", score: 1 }],
        costUsd: 0.1,
        partial: false,
        partialReason: null,
      }),
    ).toBe(true);
  });
});

describe("baselineMissingForCheck", () => {
  it("flags a --check run when there is no baseline file at all", () => {
    expect(lib.baselineMissingForCheck(true, undefined)).toBe(true);
  });

  it("does not flag a --check run when a baseline document exists", () => {
    expect(lib.baselineMissingForCheck(true, { suites: {} })).toBe(false);
  });

  it("does not flag a run that isn't checking against the baseline", () => {
    expect(lib.baselineMissingForCheck(false, undefined)).toBe(false);
  });
});

describe("suiteMissingForCheck", () => {
  it("flags a --check run when the baseline document has no entry for the suite", () => {
    expect(lib.suiteMissingForCheck(true, { suites: {} }, "harness")).toBe(
      true,
    );
  });

  it("does not flag a suite baselined with zero cases", () => {
    expect(
      lib.suiteMissingForCheck(true, { suites: { harness: {} } }, "harness"),
    ).toBe(false);
  });

  it("does not flag a suite with baselined cases", () => {
    expect(
      lib.suiteMissingForCheck(
        true,
        { suites: { harness: { "case-a": 0.9 } } },
        "harness",
      ),
    ).toBe(false);
  });

  it("does not flag a run that isn't checking at all", () => {
    expect(lib.suiteMissingForCheck(false, { suites: {} }, "harness")).toBe(
      false,
    );
  });

  it("degrades safely to flagged when there is no baseline document at all", () => {
    expect(lib.suiteMissingForCheck(true, undefined, "harness")).toBe(true);
  });
});

describe("summarizeRun / compareToBaseline / withSuiteScores", () => {
  const summary = lib.summarizeRun({
    costUsd: 0.25,
    partial: true,
    partialReason: "cost_ceiling",
    cases: [
      { name: "a", aggregates: { score: 1 } },
      { name: "b", aggregates: { score: 0.5, delta: -0.25 } },
      { name: "c" },
    ],
  });

  it("reduces a result to per-case scores, defaulting a missing score to 0", () => {
    expect(summary.cases).toEqual([
      { name: "a", score: 1, delta: null },
      { name: "b", score: 0.5, delta: -0.25 },
      { name: "c", score: 0, delta: null },
    ]);
    expect(summary.costUsd).toBe(0.25);
    expect(summary.partial).toBe(true);
    expect(summary.partialReason).toBe("cost_ceiling");
  });

  it("flags a score below baseline as a regression, and a case with no baseline as unbaselined", () => {
    const result = lib.compareToBaseline(summary.cases, { a: 1, b: 1 });
    expect(result.regressions).toEqual([{ name: "b", was: 1, now: 0.5 }]);
    expect(result.unbaselined).toEqual(["c"]);
  });

  it("treats an equal or improved score as no regression, and no baseline at all as all unbaselined", () => {
    expect(
      lib.compareToBaseline(summary.cases, { a: 1, b: 0.5, c: 0 }).regressions,
    ).toEqual([]);
    expect(lib.compareToBaseline(summary.cases, undefined).unbaselined).toEqual(
      ["a", "b", "c"],
    );
  });

  it("reports baseline names absent from the run's cases as missing", () => {
    const result = lib.compareToBaseline([{ name: "a", score: 1 }], {
      a: 0.9,
      b: 0.8,
    });
    expect(result.missing).toEqual(["b"]);
  });

  it("reports no missing cases when there is no baseline to be missing from", () => {
    expect(
      lib.compareToBaseline([{ name: "a", score: 1 }], undefined).missing,
    ).toEqual([]);
  });

  it("suppresses missing cases when the run was deliberately filtered (e.g. --case)", () => {
    const result = lib.compareToBaseline(
      [{ name: "a", score: 1 }],
      { a: 0.9, b: 0.8 },
      { filtered: true },
    );
    expect(result.missing).toEqual([]);
  });

  it("defaults filtered to false, so an unfiltered run still reports missing cases", () => {
    const result = lib.compareToBaseline(
      [{ name: "a", score: 1 }],
      { a: 0.9, b: 0.8 },
      {},
    );
    expect(result.missing).toEqual(["b"]);
  });

  it("rounds stored scores to 4 decimals and tolerates that rounding when comparing", () => {
    const stored = lib.withSuiteScores(undefined, "s", [
      { name: "a", score: 2 / 3 },
      { name: "b", score: 0.8000000000000002 },
    ]).suites["s"];
    expect(stored).toEqual({ a: 0.6667, b: 0.8 });
    // 2/3 recorded as 0.6667 must not read as a regression when 2/3 recurs.
    expect(
      lib.compareToBaseline([{ name: "a", score: 2 / 3 }], stored).regressions,
    ).toEqual([]);
  });

  it("keeps the suite's other cases when a filtered run merges, and drops stale ones on a full run", () => {
    const before = { schemaVersion: 1, suites: { s: { a: 1, gone: 1 } } };
    const cases = [{ name: "b", score: 0.5 }];
    expect(lib.withSuiteScores(before, "s", cases, true).suites["s"]).toEqual({
      a: 1,
      gone: 1,
      b: 0.5,
    });
    expect(lib.withSuiteScores(before, "s", cases).suites["s"]).toEqual({
      b: 0.5,
    });
  });

  it("replaces one suite's scores and keeps the others", () => {
    const next = lib.withSuiteScores(
      { schemaVersion: 1, suites: { plugin: { x: 1 }, harness: { old: 1 } } },
      "harness",
      summary.cases,
    );
    expect(next.suites["plugin"]).toEqual({ x: 1 });
    expect(next.suites["harness"]).toEqual({ a: 1, b: 0.5, c: 0 });
    expect(lib.withSuiteScores(undefined, "plugin", []).suites).toEqual({
      plugin: {},
    });
  });
});

describe("the real trigger corpus", () => {
  const corpus = lib.validateCorpus(
    JSON.parse(readFileSync(corpusPath, "utf8")),
  );
  const skillNames = readdirSync(corePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("names only skills that exist in templates/core", () => {
    const unknown = [...new Set(corpus.map((e) => e.skill))].filter(
      (s) => !skillNames.includes(s),
    );
    expect(
      unknown,
      `corpus names skills that do not exist: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("covers every baseline skill with at least one positive and one negative case", () => {
    const gaps = skillNames.filter(
      (skill) =>
        !corpus.some((e) => e.skill === skill && e.should_trigger) ||
        !corpus.some((e) => e.skill === skill && !e.should_trigger),
    );
    expect(
      gaps,
      `skills missing positive or negative trigger coverage: ${gaps.join(", ")}`,
    ).toEqual([]);
  });
});

describe("listPackSkillDirs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-lib-packs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the pack directory that has a files/.claude/skills tree", () => {
    mkdirSync(
      join(dir, "with-skills", "files", ".claude", "skills", "some-skill"),
      { recursive: true },
    );
    mkdirSync(join(dir, "without-skills", "files"), { recursive: true });
    const result = lib.listPackSkillDirs(dir);
    expect(result).toEqual([
      join(dir, "with-skills", "files", ".claude", "skills"),
    ]);
    expect(existsSync(result[0] as string)).toBe(true);
  });

  it("sorts returned paths by pack directory name", () => {
    mkdirSync(join(dir, "zeta", "files", ".claude", "skills", "z-skill"), {
      recursive: true,
    });
    mkdirSync(join(dir, "alpha", "files", ".claude", "skills", "a-skill"), {
      recursive: true,
    });
    expect(lib.listPackSkillDirs(dir)).toEqual([
      join(dir, "alpha", "files", ".claude", "skills"),
      join(dir, "zeta", "files", ".claude", "skills"),
    ]);
  });

  it("returns an empty array when packsRoot does not exist", () => {
    expect(lib.listPackSkillDirs(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("excludes a pack directory with no files/ subtree at all", () => {
    mkdirSync(join(dir, "bare-pack"), { recursive: true });
    expect(lib.listPackSkillDirs(dir)).toEqual([]);
  });
});

describe("coreHarnessParams", () => {
  it("points at templates/core's skills and the real core-harness corpus", () => {
    const params = lib.coreHarnessParams(repoRoot);
    expect(params.skillsDir).toBe(
      join(repoRoot, "templates", "core", ".claude", "skills"),
    );
    expect(Array.isArray(params.corpus)).toBe(true);
    expect((params.corpus as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("packsHarnessParams", () => {
  it("merges templates/core's skills with every pack's skills and the real packs-harness corpus", () => {
    const params = lib.packsHarnessParams(repoRoot);
    const expectedPackDirs = lib.listPackSkillDirs(
      join(repoRoot, "templates", "packs"),
    );
    expect(params.skillsDirs[0]).toBe(
      join(repoRoot, "templates", "core", ".claude", "skills"),
    );
    expect(params.skillsDirs.slice(1)).toEqual(expectedPackDirs);
    expect(Array.isArray(params.corpus)).toBe(true);
    expect((params.corpus as unknown[]).length).toBeGreaterThan(0);
    expect(params.name).toBe("m3l-baseline-packs");
    expect(params.tag).toBe("packs-harness");
  });

  it("writes a working plugin end to end from the real corpus and skill dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-lib-packs-e2e-"));
    try {
      const out = join(dir, "out");
      const count = lib.writeHarnessPlugin({
        ...lib.packsHarnessParams(repoRoot),
        outDir: out,
      });
      expect(count).toBeGreaterThan(0);
      expect(readdirSync(join(out, "evals")).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the real packs trigger corpus", () => {
  const corpus = lib.validateCorpus(
    JSON.parse(readFileSync(packsHarnessCorpusPath, "utf8")),
  );
  const coreSkillNames = readdirSync(corePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const packSkillDirs = lib.listPackSkillDirs(packsRoot);
  const packSkillNames = packSkillDirs.flatMap((skillsDir) =>
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const allSkillNames = [
    ...new Set([...coreSkillNames, ...packSkillNames]),
  ].sort();

  it("names only skills that exist in templates/core or a pack", () => {
    const unknown = [...new Set(corpus.map((e) => e.skill))].filter(
      (s) => !allSkillNames.includes(s),
    );
    expect(
      unknown,
      `corpus names skills that do not exist: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("covers every pack skill with at least one positive and one negative case", () => {
    const gaps = packSkillNames.filter(
      (skill) =>
        !corpus.some((e) => e.skill === skill && e.should_trigger) ||
        !corpus.some((e) => e.skill === skill && !e.should_trigger),
    );
    expect(
      gaps,
      `pack skills missing positive or negative trigger coverage: ${gaps.join(", ")}`,
    ).toEqual([]);
  });

  it("includes the three documented cross-pack negatives, each with a matching positive proving the right skill wins", () => {
    const negativeEntries = (skill: string, substring: string): Entry[] =>
      corpus.filter(
        (e) =>
          e.skill === skill && !e.should_trigger && e.query.includes(substring),
      );
    const hasMatchingPositive = (negative: Entry): boolean =>
      corpus.some(
        (e) =>
          e.skill !== negative.skill &&
          e.should_trigger &&
          e.query.includes(negative.query),
      );

    const knownPairs: [skill: string, substring: string][] = [
      ["recommending-ts-tooling", "tsconfig"],
      ["typescript-guidance", "tooling"],
      ["working-in-worktrees", "Implement"],
      ["watching-pr-checks", "Why did CI fail"],
    ];

    for (const [skill, substring] of knownPairs) {
      const negatives = negativeEntries(skill, substring);
      expect(
        negatives.length,
        `expected a negative entry for "${skill}" matching "${substring}"`,
      ).toBeGreaterThan(0);
      expect(
        negatives.some(hasMatchingPositive),
        `expected a positive entry for a different skill on the same query as ${skill}'s "${substring}" negative`,
      ).toBe(true);
    }
  });
});
