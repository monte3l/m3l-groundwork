// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Template-contract tests for SKILL.md frontmatter across the baseline and
 * every pack: `allowed-tools` pre-approves read-only Bash rules (it does not
 * restrict), `disallowed-tools` removes write tools from review-only skills,
 * `argument-hint` documents autocomplete text, and no skill is gated with
 * `disable-model-invocation`. `templates/**` is excluded from vitest
 * discovery, so the files are read by path.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const templatesDir = join(repoRoot, "templates");
const coreSkills = join(templatesDir, "core", ".claude", "skills");
const packsDir = join(templatesDir, "packs");

interface Skill {
  readonly label: string;
  readonly scope: string;
  readonly name: string;
  readonly path: string;
  readonly content: string;
}

function skillsIn(root: string, scope: string): Skill[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .map((path) => {
      const name = path.split("/").at(-2) ?? "";
      return {
        label: `${scope}/${name}`,
        scope,
        name,
        path,
        content: readFileSync(path, "utf8"),
      };
    });
}

function discover(): Skill[] {
  const all = skillsIn(coreSkills, "core");
  for (const pack of readdirSync(packsDir, { withFileTypes: true })) {
    if (pack.isDirectory()) {
      all.push(
        ...skillsIn(
          join(packsDir, pack.name, "files", ".claude", "skills"),
          pack.name,
        ),
      );
    }
  }
  return all;
}

const skills = discover();

function find(scope: string, name: string): Skill {
  const hit = skills.find((s) => s.scope === scope && s.name === name);
  if (!hit) {
    throw new Error(`skill not found: ${scope}/${name}`);
  }
  return hit;
}

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

function unquote(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const m = /^(["'])([\s\S]*)\1$/u.exec(value);
  return m ? m[2] : value;
}

function fm(skill: Skill): string {
  return split(skill.content).frontmatter;
}

function allowedTools(skill: Skill): string | undefined {
  return unquote(field(fm(skill), "allowed-tools"));
}

/** Splits a space-separated rule string, keeping `Bash(...)` rules whole. */
function rules(value: string | undefined): string[] {
  return (value ?? "").match(/[A-Za-z]+\([^)]*\)|\S+/gu) ?? [];
}

const ALLOWED: readonly (readonly [string, string, string])[] = [
  [
    "core",
    "creating-prs",
    "Bash(git status --porcelain) Bash(git fetch origin) Bash(git log origin/main..HEAD --oneline) Bash(gh pr view *)",
  ],
  [
    "core",
    "finishing-work",
    "Bash(git status --porcelain) Bash(git worktree list --porcelain) Bash(gh pr view *)",
  ],
  [
    "core",
    "starting-work",
    "Bash(git status --porcelain) Bash(git rev-parse --abbrev-ref HEAD) Bash(git rev-parse --git-path hooks) Bash(node --version)",
  ],
  [
    "core",
    "triaging-ci",
    "Bash(gh run list *) Bash(gh run view *) Bash(git rev-parse --abbrev-ref HEAD)",
  ],
  ["core", "writing-commits", "Bash(git status --porcelain)"],
  [
    "github",
    "reviewing-dependabot-prs",
    "Bash(gh pr list *) Bash(gh pr view *) Bash(gh pr checks *)",
  ],
  [
    "github",
    "watching-pr-checks",
    "Bash(gh pr view *) Bash(gh pr checks *) Bash(gh run view *)",
  ],
  [
    "worktrees",
    "working-in-worktrees",
    "Bash(git worktree list --porcelain) Bash(git status --porcelain)",
  ],
];

const HINTS: readonly (readonly [string, string, string])[] = [
  ["core", "harness-guidance", "[research <question> | refresh]"],
  ["core", "typescript-guidance", "[research <question> | refresh | gaps]"],
  [
    "worktrees",
    "working-in-worktrees",
    "[start <slug> | status | sync <slug> | finish <slug> | fan-out]",
  ],
  ["frontend", "new-component", "[component-name]"],
  ["service", "api-doc", "[output-path]"],
];

const WRITERS: readonly (readonly [string, string])[] = [
  ["core", "finishing-work"],
  ["core", "harness-guidance"],
  ["core", "typescript-guidance"],
  ["core", "writing-commits"],
  ["core", "creating-prs"],
  ["core", "triaging-ci"],
  ["core", "starting-work"],
  ["worktrees", "working-in-worktrees"],
  ["frontend", "new-component"],
  ["service", "api-doc"],
];

const READ_ONLY_RULE =
  /^Bash\((?:git (?:status|fetch|log|rev-parse|worktree list)|gh (?:pr (?:view|list|checks)|run (?:list|view))|node --version)(?: [^)]*)?\)$/u;

const FORBIDDEN = [
  "git push",
  "git commit",
  "git merge",
  "gh pr merge",
  "gh pr close",
  "gh pr create",
  "gh api",
  "rm ",
  "git branch -d",
  "git worktree add",
  "git worktree remove",
  "git switch",
  "git checkout",
  "pnpm install",
];

const FORBIDDEN_FLAGS = ["--output", "--upload-pack", "--ext-diff", "--exec"];

describe("skill discovery", () => {
  it("finds the core skills and pack skills", () => {
    expect(skills.length).toBeGreaterThanOrEqual(13);
  });
});

describe("allowed-tools contract", () => {
  it.each(ALLOWED)(
    "%s/%s pre-approves exactly its read-only rules",
    (scope, name, value) => {
      expect(allowedTools(find(scope, name))).toBe(value);
    },
  );
});

describe("disallowed-tools contract", () => {
  it.each([
    "reviewing-dependabot-prs",
    "triaging-scan-alerts",
    "watching-pr-checks",
  ])("github/%s removes the write tools", (name) => {
    expect(unquote(field(fm(find("github", name)), "disallowed-tools"))).toBe(
      "Write, Edit, NotebookEdit",
    );
  });
});

describe("argument-hint contract", () => {
  it.each(HINTS)("%s/%s declares a quoted hint", (scope, name, hint) => {
    const raw = field(fm(find(scope, name)), "argument-hint");
    expect(raw).toMatch(/^["']/u);
    expect(unquote(raw)).toBe(hint);
  });
});

describe("every skill", () => {
  it.each(skills.map((s) => [s.label, s] as const))(
    "%s is never gated with disable-model-invocation",
    (_label, skill) => {
      expect(skill.content).not.toContain("disable-model-invocation");
    },
  );

  it.each(skills.map((s) => [s.label, s] as const))(
    "%s allowed-tools holds only read-only Bash rules",
    (_label, skill) => {
      const value = allowedTools(skill);
      if (value === undefined) {
        return;
      }
      const entries = rules(value);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry).toMatch(READ_ONLY_RULE);
        expect(entry).not.toMatch(/^(?:Bash|Bash\(\*\)|Write|Edit)$/u);
        for (const bad of FORBIDDEN) {
          expect(entry).not.toContain(bad);
        }
        for (const flag of FORBIDDEN_FLAGS) {
          expect(entry).not.toContain(flag);
        }
        if (entry.startsWith("Bash(git ")) {
          expect(entry).not.toContain("*");
        }
      }
    },
  );

  it.each(skills.map((s) => [s.label, s] as const))(
    "%s keeps name equal to its directory and a bounded description",
    (_label, skill) => {
      const front = fm(skill);
      expect(unquote(field(front, "name"))).toBe(skill.name);
      const description = field(front, "description") ?? "";
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
    },
  );
});

describe("skills that write files by design", () => {
  it.each(WRITERS)("%s/%s does not disallow Write or Edit", (scope, name) => {
    const value = field(fm(find(scope, name)), "disallowed-tools") ?? "";
    expect(value).not.toMatch(/\b(?:Write|Edit)\b/u);
  });
});

describe("starting-work Environment preflight", () => {
  const { body } = split(find("core", "starting-work").content);
  const start = body.indexOf("Environment preflight");
  const section = start === -1 ? "" : body.slice(start);
  const end = section.indexOf("Recommend each decision");
  const preflight = end === -1 ? section : section.slice(0, end);

  it("sits after git-state inspection and before the Recommend step", () => {
    const inspect = body.indexOf("### 1");
    const recommend = body.indexOf("Recommend each decision");
    expect(inspect).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(inspect);
    expect(recommend).toBeGreaterThan(start);
  });

  it.each([".node-version", "node_modules", "lefthook"])(
    "mentions %s",
    (term) => {
      expect(preflight).toContain(term);
    },
  );

  it("names the hooks-path command", () => {
    expect(preflight).toContain("git rev-parse --git-path hooks");
  });

  it("reports and never installs, read-only", () => {
    expect(preflight).toMatch(/\breport\b/u);
    expect(preflight).toMatch(/never install/iu);
    expect(preflight).toMatch(/read-only/iu);
  });
});

const CORE_NAMES = [
  "creating-prs",
  "finishing-work",
  "harness-guidance",
  "starting-work",
  "triaging-ci",
  "typescript-guidance",
  "writing-commits",
];
const GITHUB_NAMES = [
  "reviewing-dependabot-prs",
  "triaging-scan-alerts",
  "watching-pr-checks",
];
const ADOPTED: readonly (readonly [string, string])[] = [
  ...CORE_NAMES.map((n) => ["core", n] as const),
  ...GITHUB_NAMES.map((n) => ["github", n] as const),
];

function rootCopy(name: string): string {
  const path = join(repoRoot, ".claude", "skills", name, "SKILL.md");
  expect(existsSync(path), `root copy missing: ${path}`).toBe(true);
  return readFileSync(path, "utf8");
}

describe("root self-adoption copies", () => {
  it.each(ADOPTED)(
    "%s/%s root copy carries the same tool frontmatter keys",
    (scope, name) => {
      const template = fm(find(scope, name));
      const root = split(rootCopy(name)).frontmatter;
      for (const key of [
        "allowed-tools",
        "disallowed-tools",
        "argument-hint",
      ]) {
        expect(field(root, key)).toBe(field(template, key));
      }
    },
  );

  it.each(CORE_NAMES.filter((n) => n !== "typescript-guidance"))(
    "core/%s root copy body matches the template body",
    (name) => {
      expect(split(rootCopy(name)).body).toBe(
        split(find("core", name).content).body,
      );
    },
  );

  it("root typescript-guidance keeps its repo-specific body", () => {
    expect(split(rootCopy("typescript-guidance")).body).toContain(
      "this repo has no",
    );
  });
});

describe("github skills with disallowed-tools explain the restriction", () => {
  it.each(GITHUB_NAMES)("github/%s body", (name) => {
    const { body } = split(find("github", name).content);
    expect(body).toMatch(/[^.]*unavailable[^.]*Write|Write[^.]*unavailable/iu);
    expect(body).toMatch(/fresh request/iu);
  });
});
