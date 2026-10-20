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
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fieldList,
  fieldText,
  parseFrontmatter,
} from "../src/harness/frontmatter.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// Plain ESM under bin/, outside every tsconfig -- loaded by URL.
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "eval-lib.mjs")).href
)) as {
  SUITES: string[];
  parseArgs: (argv: string[]) => { suite: string };
  writeAgentPlugin: (params: {
    agentFiles: string[];
    casesDir: string;
    outDir: string;
    name?: string;
  }) => number;
  packAgentsParams: (root: string) => {
    agentFiles: string[];
    casesDir: string;
  };
  suiteExtras: (name: string) => {
    scaffold?: boolean;
    allowTools?: string[];
    ablation?: string;
  };
};

/** Every entry under `dir`, relative and sorted, to prove nothing was written. */
function listing(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("parseArgs --suite agents", () => {
  it("accepts agents as a suite", () => {
    expect(lib.parseArgs(["--suite", "agents"]).suite).toBe("agents");
    expect(lib.SUITES).toContain("agents");
  });

  it("lists agents in the unknown-suite error message", () => {
    expect(() => lib.parseArgs(["--suite", "bogus"])).toThrow(/agents/);
  });
});

describe("writeAgentPlugin", () => {
  let dir: string;
  let agentsSrc: string;
  let casesDir: string;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-agents-"));
    agentsSrc = join(dir, "agents-src");
    casesDir = join(dir, "cases");
    out = join(dir, "out");
    mkdirSync(agentsSrc, { recursive: true });
    mkdirSync(out, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function agent(name: string, subdir = "", fmName?: string): string {
    const d = join(agentsSrc, subdir);
    mkdirSync(d, { recursive: true });
    const file = join(d, name);
    writeFileSync(
      file,
      `---\nname: ${fmName ?? basename(name, ".md")}\n---\nbody\n`,
    );
    return file;
  }

  function writeCase(
    name: string,
    omit: string[] = [],
    yamlName: string = name,
  ): void {
    const caseDir = join(casesDir, name);
    mkdirSync(join(caseDir, "graders"), { recursive: true });
    const files: Record<string, string> = {
      "case.yaml": `name: ${yamlName}\n`,
      "prompt.md": "hi\n",
      "fixture.sh": '#!/bin/sh\nCLI="__M3L_CLI__"\n',
    };
    for (const [file, content] of Object.entries(files)) {
      if (!omit.includes(file)) writeFileSync(join(caseDir, file), content);
    }
    if (omit.includes("graders-file")) {
      rmSync(join(caseDir, "graders"), { recursive: true });
      writeFileSync(join(caseDir, "graders"), "not a directory\n");
    } else if (omit.includes("graders")) {
      rmSync(join(caseDir, "graders"), { recursive: true });
    } else if (!omit.includes("graders-empty")) {
      writeFileSync(join(caseDir, "graders", "g.md"), "---\ntype: llm\n---\n");
    }
  }

  it("installs the manifest, the agent files and each case, returning the case count", () => {
    const a = agent("ui-reviewer.md");
    writeCase("one");
    writeCase("two");
    const count = lib.writeAgentPlugin({
      agentFiles: [a],
      casesDir,
      outDir: out,
    });
    expect(count).toBe(2);
    const manifest = JSON.parse(
      readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "m3l-pack-agents",
      version: "0.0.0",
    });
    expect(typeof manifest["description"]).toBe("string");
    expect(manifest).toHaveProperty("author");
    expect(readFileSync(join(out, "agents", "ui-reviewer.md"), "utf8")).toBe(
      readFileSync(a, "utf8"),
    );
    expect(existsSync(join(out, "evals", "one", "graders", "g.md"))).toBe(true);
    expect(existsSync(join(out, "evals", "two", "case.yaml"))).toBe(true);
  });

  it("copies fixture.sh byte-for-byte without substituting __M3L_CLI__", () => {
    writeCase("one");
    lib.writeAgentPlugin({
      agentFiles: [agent("a.md")],
      casesDir,
      outDir: out,
    });
    expect(readFileSync(join(out, "evals", "one", "fixture.sh"), "utf8")).toBe(
      readFileSync(join(casesDir, "one", "fixture.sh"), "utf8"),
    );
  });

  it("honours an overridden plugin name", () => {
    writeCase("one");
    lib.writeAgentPlugin({
      agentFiles: [agent("a.md")],
      casesDir,
      outDir: out,
      name: "custom-name",
    });
    expect(
      JSON.parse(
        readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"),
      ) as { name: string },
    ).toMatchObject({ name: "custom-name" });
  });

  it("throws before writing when an agent file does not exist", () => {
    writeCase("one");
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [join(agentsSrc, "missing.md")],
        casesDir,
        outDir: out,
      }),
    ).toThrow(/missing\.md/);
    expect(listing(out)).toEqual([]);
  });

  it("throws before writing when an agent file does not end in .md", () => {
    writeCase("one");
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [agent("agent.txt")],
        casesDir,
        outDir: out,
      }),
    ).toThrow(/agent\.txt/);
    expect(listing(out)).toEqual([]);
  });

  it("throws naming both files when two agent files share a basename", () => {
    writeCase("one");
    const first = agent("dup.md", "a");
    const second = agent("dup.md", "b");
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [first, second],
        casesDir,
        outDir: out,
      }),
    ).toThrow(
      new RegExp(
        `${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    expect(listing(out)).toEqual([]);
  });

  it("throws before writing when casesDir does not exist", () => {
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [agent("a.md")],
        casesDir: join(dir, "nope"),
        outDir: out,
      }),
    ).toThrow(/nope/);
    expect(listing(out)).toEqual([]);
  });

  it("throws before writing when casesDir holds no case directory", () => {
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(join(casesDir, "stray.txt"), "not a case");
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [agent("a.md")],
        casesDir,
        outDir: out,
      }),
    ).toThrow();
    expect(listing(out)).toEqual([]);
  });

  it.each([
    ["case.yaml", ["case.yaml"]],
    ["prompt.md", ["prompt.md"]],
    ["fixture.sh", ["fixture.sh"]],
    ["graders", ["graders"]],
    ["graders", ["graders-empty"]],
    ["a graders directory (graders is a file)", ["graders-file"]],
  ])(
    "throws naming the case, and writes nothing, when a case lacks %s",
    (_label, omit) => {
      writeCase("good");
      writeCase("broken-case", omit);
      expect(() =>
        lib.writeAgentPlugin({
          agentFiles: [agent("a.md")],
          casesDir,
          outDir: out,
        }),
      ).toThrow(/broken-case/);
      expect(listing(out)).toEqual([]);
    },
  );

  it("throws naming the agent when its frontmatter name differs from its file name", () => {
    writeCase("one");
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [agent("ui-reviewer.md", "", "other-name")],
        casesDir,
        outDir: out,
      }),
    ).toThrow(/ui-reviewer[\s\S]*other-name|other-name[\s\S]*ui-reviewer/);
    expect(listing(out)).toEqual([]);
  });

  it("throws naming the case when graders is a file, not a raw ENOTDIR", () => {
    writeCase("good");
    writeCase("file-graders", ["graders-file"]);
    let thrown: unknown;
    try {
      lib.writeAgentPlugin({
        agentFiles: [agent("a.md")],
        casesDir,
        outDir: out,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/file-graders/);
    expect((thrown as Error).message).not.toMatch(/ENOTDIR/);
    expect(listing(out)).toEqual([]);
  });

  it("throws naming the case when case.yaml name differs from the directory name", () => {
    writeCase("good");
    writeCase("dir-name", [], "yaml-name");
    expect(() =>
      lib.writeAgentPlugin({
        agentFiles: [agent("a.md")],
        casesDir,
        outDir: out,
      }),
    ).toThrow(/dir-name/);
    expect(listing(out)).toEqual([]);
  });
});

describe("suiteExtras", () => {
  it.each(["plugin", "toolchain"])(
    "%s scaffolds and grants Write and Edit",
    (name) => {
      expect(lib.suiteExtras(name)).toEqual({
        scaffold: true,
        allowTools: ["Write", "Edit"],
      });
    },
  );

  it("agents scaffolds with ablation none and grants no tools at all", () => {
    const extras = lib.suiteExtras("agents");
    expect(extras).toEqual({ scaffold: true, ablation: "none" });
    expect("allowTools" in extras).toBe(false);
  });

  it.each(["harness", "packs"])("%s adds nothing", (name) => {
    expect(lib.suiteExtras(name)).toEqual({});
  });
});

describe("packAgentsParams", () => {
  it("points at the two pack agents and the authored cases", () => {
    expect(lib.packAgentsParams(repoRoot)).toEqual({
      agentFiles: [
        join(
          repoRoot,
          "templates",
          "packs",
          "frontend",
          "files",
          ".claude",
          "agents",
          "ui-reviewer.md",
        ),
        join(
          repoRoot,
          "templates",
          "packs",
          "service",
          "files",
          ".claude",
          "agents",
          "performance-analyzer.md",
        ),
      ],
      casesDir: join(repoRoot, "evals", "pack-agents"),
    });
  });
});

describe("the authored pack-agents corpus", () => {
  // Literal names so the suite registers (and fails per test) before the
  // exports exist; the real agent files are cross-checked below.
  const agentNames = ["ui-reviewer", "performance-analyzer"];
  const params = {
    get casesDir(): string {
      return lib.packAgentsParams(repoRoot).casesDir;
    },
    get agentFiles(): string[] {
      return lib.packAgentsParams(repoRoot).agentFiles;
    },
  };
  const caseNames = (): string[] =>
    existsSync(params.casesDir)
      ? readdirSync(params.casesDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : [];

  function read(caseName: string, ...rest: string[]): string {
    return readFileSync(join(params.casesDir, caseName, ...rest), "utf8");
  }

  function graders(caseName: string): Map<string, string>[] {
    const gdir = join(params.casesDir, caseName, "graders");
    return readdirSync(gdir).map((file) => {
      const parsed = parseFrontmatter(readFileSync(join(gdir, file), "utf8"));
      if (!parsed.ok) throw new Error(`${caseName}/${file}: ${parsed.error}`);
      return new Map(
        [...parsed.fields].map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(", ") : v,
        ]),
      );
    });
  }

  it("covers exactly the agents packAgentsParams names", () => {
    expect(params.agentFiles.map((f) => basename(f, ".md"))).toEqual(
      agentNames,
    );
  });

  it("has at least one case directory", () => {
    expect(caseNames().length).toBeGreaterThan(0);
  });

  it.each(
    agentNames.flatMap((a) =>
      ["seeded", "clean", "no-files"].map((k) => [a, k]),
    ),
  )("%s has a %s case", (agentName, kind) => {
    expect(caseNames()).toContain(`${agentName}-${kind}`);
  });

  it("is accepted by writeAgentPlugin", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-agents-real-"));
    try {
      const count = lib.writeAgentPlugin({
        ...params,
        outDir: join(dir, "out"),
      });
      expect(count).toBe(caseNames().length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe.each(
    agentNames.flatMap((a) =>
      ["seeded", "clean", "no-files"].map((k) => `${a}-${k}`),
    ),
  )("case %s", (caseName) => {
    const agentName = caseName.replace(/-(seeded|clean|no-files)$/, "");

    it("is read-only: allowed_tools has Agent/Read/Glob/Grep and no Write/Edit/Bash, with bounds", () => {
      const parsed = parseFrontmatter(read(caseName, "prompt.md"));
      if (!parsed.ok) throw new Error(parsed.error);
      const tools = fieldList(parsed.fields, "allowed_tools") ?? [];
      expect(tools).toEqual(
        expect.arrayContaining(["Agent", "Read", "Glob", "Grep"]),
      );
      for (const banned of ["Write", "Edit", "Bash"]) {
        expect(tools).not.toContain(banned);
      }
      expect(fieldText(parsed.fields, "max_turns")).toBeDefined();
      expect(fieldText(parsed.fields, "timeout_seconds")).toBeDefined();
    });

    it("names the dispatch target in the prompt body", () => {
      const parsed = parseFrontmatter(read(caseName, "prompt.md"));
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.body).toContain(`m3l-pack-agents:${agentName}`);
    });

    it("has an llm grader", () => {
      expect(graders(caseName).some((g) => g.get("type") === "llm")).toBe(true);
    });

    it("has an Agent tool_used grader whose input_match accepts only the namespaced dispatch", () => {
      const dispatch = graders(caseName).filter(
        (g) => g.get("type") === "tool_used" && g.get("tool") === "Agent",
      );
      expect(dispatch.length).toBeGreaterThan(0);
      for (const g of dispatch) {
        const pattern = new RegExp(g.get("input_match") ?? "(?!)");
        expect(
          pattern.test(`{"subagent_type":"m3l-pack-agents:${agentName}"}`),
        ).toBe(true);
        expect(
          pattern.test(
            `{"subagent_type":"general-purpose","prompt":"act as the ${agentName}"}`,
          ),
        ).toBe(false);
        expect(pattern.test(`{"description":"${agentName}"}`)).toBe(false);
      }
    });

    it("has a case.yaml name equal to its directory name", () => {
      expect(read(caseName, "case.yaml")).toMatch(
        new RegExp(`^name:\\s*["']?${caseName}["']?\\s*$`, "m"),
      );
    });

    it("declares schema 1.1 and scaffolds from fixture.sh", () => {
      const yaml = read(caseName, "case.yaml");
      expect(yaml).toMatch(/^schema_version: "1\.1"$/m);
      expect(yaml).toMatch(/^context:/m);
      expect(yaml).toMatch(/^\s+scaffold_script: fixture\.sh$/m);
    });

    it("has a fixture free of network, install, push and CLI placeholders", () => {
      const fixture = read(caseName, "fixture.sh");
      for (const banned of [
        "curl",
        "wget",
        "npm",
        "pnpm",
        "git push",
        "__M3L_CLI__",
      ]) {
        expect(fixture).not.toContain(banned);
      }
    });
  });

  describe.each(agentNames.map((a) => `${a}-no-files`))(
    "no-files case %s",
    (caseName) => {
      it("tells the dispatcher to pass the request on without naming any files", () => {
        expect(read(caseName, "prompt.md")).toMatch(
          /without naming any files/i,
        );
      });
    },
  );

  it("every case directory's case.yaml name equals the directory name", () => {
    expect(caseNames().length).toBeGreaterThan(0);
    for (const c of caseNames()) {
      const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(
        read(c, "case.yaml"),
      );
      expect(m?.[1], c).toBe(c);
    }
  });

  describe.each(agentNames.map((a) => `${a}-seeded`))(
    "seeded case %s",
    (caseName) => {
      it("has a set -eu fixture that creates at least two files", () => {
        const fixture = read(caseName, "fixture.sh");
        expect(fixture).toMatch(/^set -eu\b/m);
        const creations =
          fixture.match(
            /<<\s*['"]?\w+['"]?\s*$|(?:^|\s)>{1,2}\s*[\w./"'$-]+|\btouch\s+\S+/gm,
          ) ?? [];
        expect(creations.length).toBeGreaterThanOrEqual(2);
      });
    },
  );
});

describe("bin/eval.mjs agents branch", () => {
  const source = readFileSync(join(repoRoot, "bin", "eval.mjs"), "utf8");

  it("takes per-suite options from suiteExtras and builds the plugin with writeAgentPlugin", () => {
    expect(source).toContain("suiteExtras(");
    expect(source).toContain("writeAgentPlugin");
  });

  it("spreads the suite extras after the ablation field so a suite can override it", () => {
    const ablation = source.indexOf("ablation: opts.ablation");
    const spread = source.indexOf("...extra");
    expect(ablation).toBeGreaterThanOrEqual(0);
    expect(spread).toBeGreaterThan(ablation);
  });
});
