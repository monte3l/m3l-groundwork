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
  buildTriggerCases: (corpus: Entry[]) => Case[];
  writeHarnessPlugin: (params: {
    skillsDir: string;
    corpus: unknown;
    outDir: string;
  }) => number;
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
  ) => {
    regressions: { name: string; was: number; now: number }[];
    unbaselined: string[];
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
