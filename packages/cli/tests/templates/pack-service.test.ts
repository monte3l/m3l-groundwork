// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Template-contract tests for the `service` pack: its manifest, the read-only
 * `performance-analyzer` agent (a static review whose Node checklist is pinned
 * to nodejs.org's "Don't Block the Event Loop (or the Worker Pool)") and the
 * `api-doc` skill with its OpenAPI 3.2 template (spec.openapis.org, v3.2.1).
 * `templates/**` is excluded from vitest discovery, so the files are read by
 * path.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPack } from "../../src/packs.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "..", "..", "..", "templates");
const packDir = join(templatesDir, "packs", "service");
const agentPath = join(
  packDir,
  "files",
  ".claude",
  "agents",
  "performance-analyzer.md",
);
const skillDir = join(packDir, "files", ".claude", "skills", "api-doc");
const skillPath = join(skillDir, "SKILL.md");
const openapiPath = join(skillDir, "openapi-template.yaml");

function split(content: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) {
    throw new Error("no frontmatter block found");
  }
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

function field(frontmatter: string, key: string): string | undefined {
  return new RegExp(`^${key}:[ \\t]*(.*)$`, "mu")
    .exec(frontmatter)?.[1]
    ?.trim();
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Colors of every agent file shipped under `templates/`, other than this one. */
function otherAgentColors(): string[] {
  const colors: string[] = [];
  for (const rel of readdirSync(templatesDir, {
    recursive: true,
  }) as string[]) {
    const norm = rel.split("\\").join("/");
    if (!/(^|\/)agents\/[^/]+\.md$/u.test(norm)) {
      continue;
    }
    const full = join(templatesDir, rel);
    if (full === agentPath) {
      continue;
    }
    const color = field(split(readFileSync(full, "utf8")).frontmatter, "color");
    if (color !== undefined && color.length > 0) {
      colors.push(color);
    }
  }
  return colors;
}

describe("service pack manifest", () => {
  it("loads through loadPack with the contracted shape", () => {
    const { manifest } = loadPack("service");
    expect(manifest.name).toBe("service");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.modes).toEqual(["fresh", "adopt"]);
    expect(manifest.budget).toEqual({
      agents: 1,
      skills: 1,
      hooks: 0,
      workflows: 0,
      scripts: 0,
    });
    expect(manifest.requires).toBeUndefined();
    expect(manifest.wiring.packageScripts).toEqual({});
    expect(manifest.wiring.verifySteps).toEqual([]);
    expect(manifest.description.trim().length).toBeGreaterThan(0);
    expect(manifest.adoptNotes?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("has exactly the contracted raw fields: no requires key, empty wiring", () => {
    const raw = JSON.parse(
      readFileSync(join(packDir, "pack.json"), "utf8"),
    ) as {
      requires?: unknown;
      wiring: unknown;
      schemaVersion: number;
      name: string;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.name).toBe("service");
    expect("requires" in raw).toBe(false);
    expect(raw.wiring).toEqual({
      settings: {},
      packageScripts: {},
      verifySteps: [],
    });
  });
});

describe("performance-analyzer agent", () => {
  const { frontmatter, body } = split(readFileSync(agentPath, "utf8"));
  const description = field(frontmatter, "description") ?? "";

  it("is named performance-analyzer, on the medium-effort sonnet model with 40 turns", () => {
    expect(field(frontmatter, "name")).toBe("performance-analyzer");
    expect(field(frontmatter, "model")).toBe("claude-sonnet-5-5");
    expect(field(frontmatter, "effort")).toBe("medium");
    expect(field(frontmatter, "maxTurns")).toBe("40");
  });

  it("is read-only: tools are exactly Read, Grep, Glob and Agent is disallowed", () => {
    const tools = list(field(frontmatter, "tools"));
    expect([...tools].sort()).toEqual(["Glob", "Grep", "Read"]);
    for (const forbidden of [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
      "Agent",
    ]) {
      expect(tools).not.toContain(forbidden);
    }
    expect(list(field(frontmatter, "disallowedTools"))).toContain("Agent");
  });

  it("has a single-line 40-1024 character description", () => {
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("is colored pink, and no other template agent uses that color", () => {
    expect(field(frontmatter, "color")).toBe("pink");
    expect(otherAgentColors()).not.toContain("pink");
  });

  it("states it is read-only and never edits", () => {
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/never (edit|write|modify)/i);
  });

  it("returns immediately when given no file list, since it has no shell to find files", () => {
    expect(body).toContain("return immediately");
  });

  it("is a STATIC review that reports anything needing measurement as NOT CHECKED", () => {
    expect(body).toContain("STATIC");
    expect(body).toContain("NOT CHECKED");
    expect(body).toMatch(/profil/i);
    expect(body).toMatch(/load test/i);
  });

  describe("describes cost by what grows, never by speed words", () => {
    const flat = body.replace(/\s+/gu, " ");

    it("forbids describing a cost as slow, fast or large in one sentence", () => {
      expect(flat).toMatch(
        /never describe[^.]*\bslow\b[^.]*\bfast\b[^.]*\blarge\b|never describe[^.]*\b(slow|fast|large)\b(?=[^.]*\bslow\b)(?=[^.]*\bfast\b)(?=[^.]*\blarge\b)/i,
      );
    });

    it("forbids latency formulas and estimates", () => {
      expect(flat).toMatch(/latency (formula|estimate)/i);
    });

    it.each([/round trips/i, /bytes buffered/i, /event loop is blocked/i])(
      "says what grows instead: %s",
      (pattern) => {
        expect(flat).toMatch(pattern);
      },
    );

    it.each([
      /tag (each|every) finding[^.]*\[heuristic\]/i,
      /at any severity/i,
      /never[^.]*as proven/i,
    ])(
      "tags heuristic findings and never presents them as proven: %s",
      (pattern) => {
        expect(flat).toMatch(pattern);
      },
    );

    it("leaves how much to NOT CHECKED", () => {
      expect(flat).toMatch(/how much[^.]*NOT CHECKED/i);
    });
  });

  it("bounds its inline digest at about 8,000 characters and never writes a file", () => {
    expect(body).toContain("at most about 8,000 characters");
    expect(body).toMatch(/never write a file/i);
  });

  it.each(["Must-fix", "Should-fix", "Nit"])(
    "uses the %s severity tier",
    (tier) => {
      expect(body).toContain(tier);
    },
  );

  it.each([
    "crypto.pbkdf2Sync",
    "crypto.randomFillSync",
    "zlib.inflateSync",
    "zlib.deflateSync",
    "child_process.execSync",
    "child_process.spawnSync",
    "child_process.execFileSync",
  ])("names %s as a blocking API", (api) => {
    expect(body).toContain(api);
  });

  it("names the synchronous fs APIs, the ReDoS shapes and JSON on large input", () => {
    expect(body).toMatch(/synchronous\s+`?fs/i);
    expect(body).toContain("(a+)*");
    expect(body).toContain("(a|a)*");
    expect(body).toContain("JSON.parse");
    expect(body).toContain("JSON.stringify");
  });

  it("cites the Node.js guide title", () => {
    expect(body).toContain("Don't Block the Event Loop");
  });

  it.each([
    /N\+1/,
    /pagination|limit/i,
    /independent calls/i,
    /timeout/i,
    /buffer/i,
  ])("lists the language-neutral heuristic %s", (pattern) => {
    expect(body).toMatch(pattern);
  });

  it("labels the language-neutral items as heuristics, not sourced", () => {
    expect(body).toMatch(/heuristic/i);
    expect(body).toMatch(/not sourced/i);
  });

  it("applies the Node items only when the project runs Node", () => {
    expect(body).toMatch(/only (when|if) the project runs Node/i);
  });
});

describe("api-doc skill", () => {
  const { frontmatter, body } = split(readFileSync(skillPath, "utf8"));
  const description = field(frontmatter, "description") ?? "";

  it("has a name equal to its directory name", () => {
    expect(field(frontmatter, "name")).toBe("api-doc");
  });

  it("has a 40-1024 character description with its trigger phrases", () => {
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("/api-doc");
    expect(description).toContain("document the API");
    expect(description).toContain("OpenAPI");
  });

  it("has no shell injection (a bang followed by a backtick)", () => {
    expect(body).not.toMatch(/!`/u);
  });

  it("stays under 500 lines", () => {
    expect(body.split("\n").length).toBeLessThan(500);
  });

  it("points at the shipped template", () => {
    expect(body).toContain("openapi-template.yaml");
  });

  it("is framework-neutral: never adds a dependency, never writes under src/ or tests/, and the hub never writes src", () => {
    expect(body).toMatch(/never add(s)? a dependency/i);
    expect(body).toMatch(/never write(s)? under `?src\//i);
    expect(body).toContain("tests/");
    expect(body).toMatch(/hub never writes/i);
    expect(body).toContain("docs/api/openapi.yaml");
  });

  it.each([
    "`openapi` and `info` are required",
    "`components`, `paths` or `webhooks`",
    "`operationId` must be unique",
    "`required: true`",
    "TODO",
    "unverified",
    "never invent",
  ])("states the verified OpenAPI rule: %s", (text) => {
    expect(body).toContain(text);
  });
});

describe("api-doc openapi-template.yaml", () => {
  const yaml = readFileSync(openapiPath, "utf8");

  it("declares an OpenAPI 3.2 version string at the top level", () => {
    expect(yaml).toMatch(/^openapi:\s*["']?3\.2/mu);
  });

  it("has info with title and version", () => {
    expect(yaml).toMatch(/^info:/mu);
    expect(yaml).toMatch(/^ {2}title:/mu);
    expect(yaml).toMatch(/^ {2}version:/mu);
  });

  it("has a paths map with a path starting with /", () => {
    expect(yaml).toMatch(/^paths:/mu);
    expect(yaml).toMatch(/^ {2}["']?\/\S*:/mu);
  });

  it("gives every response a description", () => {
    expect(yaml).toMatch(/responses:/u);
    expect(yaml).toMatch(/^\s+description:/mu);
  });

  it("marks operationId as present and unique", () => {
    expect(yaml).toMatch(/operationId:/u);
    expect(yaml).toMatch(/unique/i);
  });

  it("declares components with securitySchemes", () => {
    expect(yaml).toMatch(/^components:/mu);
    expect(yaml).toMatch(/securitySchemes:/u);
  });

  it("shows a path parameter with in: path and required: true", () => {
    expect(yaml).toMatch(/in:\s*path/u);
    expect(yaml).toMatch(/required:\s*true/u);
  });
});
