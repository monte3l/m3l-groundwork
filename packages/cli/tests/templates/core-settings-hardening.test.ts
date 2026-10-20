// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// Pins the hardening contract of the REAL baseline harness
// (templates/core/.claude): hook failure modes, permissions.deny, the
// code-implementer tool list, and load-bearing wording in the docs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "..", "..", "..", "..", "templates", "core");

/** Reads a baseline file with all whitespace runs collapsed to one space. */
function text(...segments: string[]): string {
  return readFileSync(join(core, ...segments), "utf8").replace(/\s+/g, " ");
}

interface Handler {
  command?: string;
  if?: string;
  onFailure?: string;
}
interface Group {
  matcher?: string;
  hooks: Handler[];
}
interface Settings {
  hooks: Record<string, Group[]>;
  permissions?: Record<string, unknown>;
}

const settings = JSON.parse(
  readFileSync(join(core, ".claude", "settings.json"), "utf8"),
) as Settings;

function handlersFor(event: string, script: string): Handler[] {
  return (settings.hooks[event] ?? [])
    .flatMap((g) => g.hooks)
    .filter((h) => (h.command ?? "").includes(script));
}

describe("settings.json hook failure modes", () => {
  it.each([
    "guard-secret-writes.mjs",
    "guard-branch-isolation.mjs",
    "guard-protected-paths.mjs",
  ])("%s fails closed", (script) => {
    const hs = handlersFor("PreToolUse", script);
    expect(hs.length).toBeGreaterThan(0);
    for (const h of hs) expect(h.onFailure).toBe("block");
  });

  it("guard-hub-src-writes.mjs fails closed on both registrations", () => {
    const hs = handlersFor("PreToolUse", "guard-hub-src-writes.mjs");
    expect(hs).toHaveLength(2);
    for (const h of hs) expect(h.onFailure).toBe("block");
  });

  it.each([
    "guard-git-push-signed.mjs",
    "guard-double-background.mjs",
    "guard-js-extension.mjs",
    "guard-no-commonjs.mjs",
  ])("%s stays fail-open (no onFailure key)", (script) => {
    const hs = handlersFor("PreToolUse", script);
    expect(hs.length).toBeGreaterThan(0);
    for (const h of hs) expect(h).not.toHaveProperty("onFailure");
  });

  it("guard-git-push-signed.mjs has no if filter", () => {
    for (const h of handlersFor("PreToolUse", "guard-git-push-signed.mjs")) {
      expect(h).not.toHaveProperty("if");
    }
  });

  it.each(["PostToolUse", "UserPromptSubmit"])(
    "no %s handler sets onFailure",
    (event) => {
      for (const g of settings.hooks[event] ?? []) {
        for (const h of g.hooks) expect(h).not.toHaveProperty("onFailure");
      }
    },
  );
});

describe("settings.json permissions", () => {
  const deny = (settings.permissions?.["deny"] ?? []) as string[];

  it("denies secrets reads and lockfile/.git edits, and sets nothing else", () => {
    expect(deny).toEqual([
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Read(**/credentials.json)",
      "Read(**/secrets.yaml)",
      "Edit(**/pnpm-lock.yaml)",
      "Edit(**/package-lock.json)",
      "Edit(**/yarn.lock)",
      "Edit(**/.git/**)",
    ]);
    expect(Object.keys(settings.permissions ?? {})).toEqual(["deny"]);
  });

  it("every deny entry is a Read(...) or Edit(...) rule", () => {
    expect(deny.length).toBeGreaterThan(0);
    // Write(/MultiEdit(/NotebookEdit( path rules are accepted but never consulted; only Edit( covers every editing tool.
    for (const entry of deny) expect(entry).toMatch(/^(Read|Edit)\(.+\)$/);
  });

  it.each([
    ["pnpm-lock.yaml", "Edit(**/pnpm-lock.yaml)"],
    ["package-lock.json", "Edit(**/package-lock.json)"],
    ["yarn.lock", "Edit(**/yarn.lock)"],
    [".git", "Edit(**/.git/**)"],
  ])("write-protects %s through an Edit( deny rule", (_name, expected) => {
    expect(expected).toMatch(/^Edit\(/);
    expect(deny).toContain(expected);
  });

  it("has no duplicate deny entries", () => {
    expect(new Set(deny).size).toBe(deny.length);
  });
});

describe("code-implementer agent", () => {
  const md = readFileSync(
    join(core, ".claude", "agents", "code-implementer.md"),
    "utf8",
  );
  const toolsLine = /^tools:.*$/m.exec(md)?.[0] ?? "";

  it.each([
    "mcp__context7__resolve-library-id",
    "mcp__context7__query-docs",
    "mcp__plugin_context7_context7__resolve-library-id",
    "mcp__plugin_context7_context7__query-docs",
  ])("tools lists %s", (tool) => {
    expect(toolsLine).toContain(tool);
  });

  it("still declares mcpServers: [context7]", () => {
    expect(md).toContain("mcpServers: [context7]");
  });
});

describe("documentation wording", () => {
  it.each([
    "overrides a spoke's `permissionMode`",
    "onFailure",
    "2.1.295",
    "permissions.deny",
    "grep -r",
  ])("CLAUDE.md mentions %s", (s) => {
    expect(text("CLAUDE.md")).toContain(s);
  });

  it.each([
    "overrides a spoke's `permissionMode`",
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  ])("agent-dispatch.md mentions %s", (s) => {
    expect(text(".claude", "rules", "agent-dispatch.md")).toContain(s);
  });

  it.each(["harness-guidance", "typescript-guidance"])(
    "%s SKILL.md drops the stale subagent claim and keeps disallowedTools",
    (skill) => {
      const t = text(".claude", "skills", skill, "SKILL.md");
      expect(t).not.toContain("a subagent cannot do");
      expect(t).toContain("disallowedTools: Agent");
    },
  );

  it.each(["last-verified=n/a", "no-typescript-toolchain"])(
    "typescript-guidance SKILL.md mentions %s",
    (s) => {
      expect(
        text(".claude", "skills", "typescript-guidance", "SKILL.md"),
      ).toContain(s);
    },
  );

  it.each(["devDependencies", "owner-normative"])(
    "tooling-sources.md mentions %s",
    (s) => {
      expect(
        text(
          ".claude",
          "skills",
          "typescript-guidance",
          "references",
          "tooling-sources.md",
        ),
      ).toContain(s);
    },
  );

  it("harness-guidance SKILL.md mentions oldest version", () => {
    expect(text(".claude", "skills", "harness-guidance", "SKILL.md")).toContain(
      "oldest version",
    );
  });
});
