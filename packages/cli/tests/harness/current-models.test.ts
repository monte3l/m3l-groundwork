// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers the 2026-10-01 Anthropic model-deprecations refresh: three new
 * Active model ids (`claude-sonnet-5-5`, `claude-fable-5`, `claude-opus-4-8`)
 * must join `CURRENT_MODELS` in both the TypeScript grader and its emitted
 * `.mjs` twin, without dropping any previously-current id, and
 * `model-pin-currency` must accept every id in the list while still
 * flagging an unknown or retired one.
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

// The emitted twin is plain ESM under templates/, outside every tsconfig, so
// it is loaded by file URL at test time rather than imported statically --
// same pattern as harness-parity.test.ts.
interface EmittedRules {
  CURRENT_MODELS: string[];
}

const emitted = (await import(
  pathToFileURL(join(libDir, "harness-rules.mjs")).href
)) as EmittedRules;

const PREVIOUSLY_CURRENT = [
  "inherit",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];

const NEW_ACTIVE_MODELS = [
  "claude-sonnet-5-5",
  "claude-fable-5",
  "claude-opus-4-8",
];

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

/** A minimal agent fixture pinned to the given `model:` value (or omitting the field entirely when `model` is `undefined`). */
function writeAgentPinnedTo(model: string | undefined): void {
  const modelLine = model === undefined ? "" : `model: ${model}\n`;
  write(
    ".claude/agents/pinned.md",
    `---\nname: pinned\ndescription: Exercises model-pin-currency against a single pinned model id.\ntools: Read\n${modelLine}---\nbody\n`,
  );
}

function modelPinFindings(): string[] {
  return gradeHarness(root)
    .findings.filter((finding) => finding.ruleId === "model-pin-currency")
    .map((finding) => finding.subject);
}

describe("CURRENT_MODELS -- the 2026-10-01 Anthropic model refresh", () => {
  it("includes every previously-current id", () => {
    for (const id of PREVIOUSLY_CURRENT) {
      expect(CURRENT_MODELS, id).toContain(id);
    }
  });

  it.each(NEW_ACTIVE_MODELS)("includes the new Active id %s", (id) => {
    expect(CURRENT_MODELS).toContain(id);
  });

  it("the emitted .mjs twin carries the same list", () => {
    expect(emitted.CURRENT_MODELS).toEqual([...CURRENT_MODELS]);
  });
});

describe("model-pin-currency -- every id in CURRENT_MODELS is accepted", () => {
  it.each(CURRENT_MODELS)(
    "an agent pinned to %s produces no model-pin-currency finding",
    (model) => {
      writeAgentPinnedTo(model);
      expect(modelPinFindings()).toEqual([]);
    },
  );
});

describe("model-pin-currency -- an id outside CURRENT_MODELS is flagged", () => {
  it("flags an unknown model id (claude-3-opus) with a named subject", () => {
    writeAgentPinnedTo("claude-3-opus");
    expect(modelPinFindings()).toEqual([".claude/agents/pinned.md"]);
  });

  it("flags a retired model id (claude-sonnet-4-5-20250929) with a named subject", () => {
    writeAgentPinnedTo("claude-sonnet-4-5-20250929");
    expect(modelPinFindings()).toEqual([".claude/agents/pinned.md"]);
  });
});
