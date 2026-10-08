// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers the 2026-10-01 Anthropic model-deprecations refresh:
 * `claude-sonnet-5-5` is the one new Active model id joining `CURRENT_MODELS`
 * in both the TypeScript grader and its emitted `.mjs` twin.
 * `model-pin-currency` must accept an agent pinned to it, while still
 * flagging an id outside the list -- unknown, deprecated, or simply not yet
 * added -- by name in the finding message. `claude-sonnet-4-5-20250929` is
 * deprecated (announced 2026-09-30, retires 2026-11-30), not retired: it is
 * still a real, if sunsetting, model id, and must stay flagged until it
 * actually joins the list or `model-pin-currency` grows a separate
 * "deprecated" level.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gradeHarness } from "../../src/harness/grade.js";
import { CURRENT_MODELS } from "../../src/harness/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesCoreDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "core",
);
const libDir = join(templatesCoreDir, "bin", "lib");

interface EmittedFinding {
  ruleId: string;
  subject: string;
  message: string;
}
interface EmittedGrade {
  findings: EmittedFinding[];
}
interface EmittedRules {
  gradeHarness: (rootDir: string) => EmittedGrade;
}

// The emitted twin is plain ESM under templates/, outside every tsconfig, so
// it is loaded by file URL at test time rather than imported statically --
// same pattern as harness-parity.test.ts.
const emitted = (await import(
  pathToFileURL(join(libDir, "harness-rules.mjs")).href
)) as EmittedRules;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "current-models-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A minimal agent fixture pinned to the given `model:` value. */
function writeAgentPinnedTo(model: string): void {
  write(
    ".claude/agents/pinned.md",
    `---\nname: pinned\ndescription: Exercises model-pin-currency against a single pinned model id.\ntools: Read\nmodel: ${model}\n---\nbody\n`,
  );
}

interface MinimalFinding {
  subject: string;
  message: string;
}

function modelPinFindings(grade: {
  findings: { ruleId: string; subject: string; message: string }[];
}): MinimalFinding[] {
  return grade.findings
    .filter((finding) => finding.ruleId === "model-pin-currency")
    .map((finding) => ({ subject: finding.subject, message: finding.message }));
}

describe("CURRENT_MODELS -- cheap invariants", () => {
  it("has no duplicate ids", () => {
    expect(new Set(CURRENT_MODELS).size).toBe(CURRENT_MODELS.length);
  });

  it.each(["inherit", "opus", "sonnet", "haiku", "fable"])(
    "includes the alias %s",
    (alias) => {
      expect(CURRENT_MODELS).toContain(alias);
    },
  );
});

describe("model-pin-currency -- accepts the 2026-10-01 refresh's new id", () => {
  it("produces no finding for an agent pinned to claude-sonnet-5-5", () => {
    writeAgentPinnedTo("claude-sonnet-5-5");

    const ts = gradeHarness(root);
    expect(modelPinFindings(ts)).toEqual([]);

    const emittedGrade = emitted.gradeHarness(root);
    expect(modelPinFindings(emittedGrade)).toEqual([]);
  });
});

describe("model-pin-currency -- accepts Haiku 5.5 and keeps Haiku 4.5", () => {
  it.each([
    "claude-haiku-5-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
  ])("produces no finding for an agent pinned to %s", (id) => {
    writeAgentPinnedTo(id);

    expect(modelPinFindings(gradeHarness(root))).toEqual([]);
    expect(modelPinFindings(emitted.gradeHarness(root))).toEqual([]);
  });

  it("lists claude-haiku-5-5 and both Haiku 4.5 ids in CURRENT_MODELS", () => {
    expect(CURRENT_MODELS).toEqual(
      expect.arrayContaining([
        "claude-haiku-5-5",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
      ]),
    );
  });
});

describe("model-pin-currency -- an id outside CURRENT_MODELS is flagged by name", () => {
  it("flags a still-unlisted id (claude-sonnet-9-9)", () => {
    writeAgentPinnedTo("claude-sonnet-9-9");

    const ts = gradeHarness(root);
    const tsFindings = modelPinFindings(ts);
    expect(tsFindings).toEqual([
      {
        subject: ".claude/agents/pinned.md",
        message:
          "`model: claude-sonnet-9-9` is not a known-current model id or alias",
      },
    ]);
    expect(tsFindings[0]?.message).toContain("claude-sonnet-9-9");

    const emittedGrade = emitted.gradeHarness(root);
    expect(modelPinFindings(emittedGrade)).toEqual(tsFindings);
  });

  it("flags an unknown model id (claude-3-opus)", () => {
    writeAgentPinnedTo("claude-3-opus");

    const ts = gradeHarness(root);
    const tsFindings = modelPinFindings(ts);
    expect(tsFindings).toEqual([
      {
        subject: ".claude/agents/pinned.md",
        message:
          "`model: claude-3-opus` is not a known-current model id or alias",
      },
    ]);
    expect(tsFindings[0]?.message).toContain("claude-3-opus");

    const emittedGrade = emitted.gradeHarness(root);
    expect(modelPinFindings(emittedGrade)).toEqual(tsFindings);
  });

  it("flags a deprecated model id (claude-sonnet-4-5-20250929, retires 2026-11-30)", () => {
    writeAgentPinnedTo("claude-sonnet-4-5-20250929");

    const ts = gradeHarness(root);
    const tsFindings = modelPinFindings(ts);
    expect(tsFindings).toEqual([
      {
        subject: ".claude/agents/pinned.md",
        message:
          "`model: claude-sonnet-4-5-20250929` is not a known-current model id or alias",
      },
    ]);
    expect(tsFindings[0]?.message).toContain("claude-sonnet-4-5-20250929");

    const emittedGrade = emitted.gradeHarness(root);
    expect(modelPinFindings(emittedGrade)).toEqual(tsFindings);
  });
});
