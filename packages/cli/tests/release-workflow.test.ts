// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural checks on `.github/workflows/release.yml`, by text: the repo has
 * no YAML parser dependency (the CLI ships none and parses no YAML), and the
 * workflow's layout (two-space jobs, six-space `- ` steps) is fixed by
 * Prettier, so a line scan is enough.
 */
const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "release.yml",
);

/** The file with whole-line comments dropped, so prose cannot satisfy a check. */
const lines = readFileSync(workflowPath, "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line));
const text = lines.join("\n");

interface Step {
  text: string;
  run: string;
  /** Raw `env:` lines of the step, e.g. `VERSION: ${{ ... }}`. */
  env: string[];
  condition: string | undefined;
}

interface JobBlock {
  /** Everything above the job's `steps:` key. */
  header: string;
  steps: Step[];
}

function jobBlock(name: string): JobBlock {
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) throw new Error(`job ${name} is missing`);
  let end = lines.findIndex(
    (l, i) => i > start && /^ {2}[A-Za-z][\w-]*:/.test(l),
  );
  if (end === -1) end = lines.length;
  const body = lines.slice(start, end);
  const stepsAt = body.findIndex((l) => l === "    steps:");
  const headerLines = stepsAt === -1 ? body : body.slice(0, stepsAt);
  const stepLines = stepsAt === -1 ? [] : body.slice(stepsAt + 1);
  const groups: string[][] = [];
  for (const line of stepLines) {
    if (line.startsWith("      - ")) groups.push([line]);
    else groups.at(-1)?.push(line);
  }
  return {
    header: headerLines.join("\n"),
    steps: groups.map((g) => {
      const stepText = g.join("\n");
      const envAt = g.findIndex((l) => /^ {8}env:$/.test(l));
      const env: string[] = [];
      if (envAt !== -1) {
        for (const l of g.slice(envAt + 1)) {
          if (!/^ {10}\S/.test(l)) break;
          env.push(l.trim());
        }
      }
      const runAt = g.findIndex((l) => /^( {8}|\s{6}- )run:/.test(l));
      const run = runAt === -1 ? "" : g.slice(runAt).join("\n");
      return {
        text: stepText,
        run,
        env,
        condition: /^ {8}if: (.*)$/m.exec(stepText)?.[1],
      };
    }),
  };
}

const publish = jobBlock("publish");
const isStage = (s: Step): boolean =>
  /node\s+bin\/npm-stage-publish\.mjs/.test(s.run);

function stageStep(): Step {
  const found = publish.steps.find(isStage);
  if (found === undefined) throw new Error("no staging step in publish");
  return found;
}

describe("release.yml", () => {
  describe("publish job gate", () => {
    it("runs only when a release was created", () => {
      expect(publish.header).toMatch(
        /^ {4}if: needs\.prepare\.outputs\.releases_created == 'true'$/m,
      );
    });
  });

  describe("the staging step", () => {
    it("passes --expect built from an env VERSION sourced from the prepare job", () => {
      const stage = stageStep();
      expect(stage.env).toContain(
        "VERSION: ${{ needs.prepare.outputs.version }}",
      );
      expect(stage.run).toMatch(/--expect[^\n]*\$\{?VERSION\b/);
    });

    it("names the package in --expect, not just the version", () => {
      expect(stageStep().run).toMatch(/--expect[^\n]*@monte3l\/groundwork@/);
    });

    it("keeps `${{ }}` expressions out of the shell body", () => {
      expect(stageStep().run).not.toContain("${{");
    });

    it("publishes to latest as public", () => {
      expect(stageStep().run).toMatch(/--tag latest\b/);
      expect(stageStep().run).toMatch(/--access public\b/);
    });
  });

  describe("step order in publish", () => {
    const steps = publish.steps;
    const stageIndex = steps.findIndex(isStage);
    const indexOf = (pred: (s: Step) => boolean): number =>
      steps.findIndex(pred);

    it.each([
      [
        "the provenance attestation",
        (s: Step) => /actions\/attest-build-provenance@/.test(s.text),
      ],
      [
        "the SBOM attestation",
        (s: Step) => /uses: actions\/attest@/.test(s.text),
      ],
      [
        "the asset upload to the draft",
        (s: Step) => /gh release upload/.test(s.run),
      ],
      ["the release-tag check", (s: Step) => /git ls-remote/.test(s.run)],
    ])("stages after %s", (_label, pred) => {
      const at = indexOf(pred);
      expect(at, "step is missing").toBeGreaterThanOrEqual(0);
      expect(stageIndex).toBeGreaterThan(at);
    });

    it("makes staging the last mutating step: only an always() step may follow", () => {
      expect(stageIndex).toBeGreaterThanOrEqual(0);
      for (const later of steps.slice(stageIndex + 1)) {
        expect(later.condition).toMatch(/always\(\)/);
      }
    });
  });

  describe("the staged-ids step", () => {
    const show = publish.steps.find((s) => /Show the staged ids/.test(s.text));
    const elseBranch = (): string => {
      const run = show?.run ?? "";
      const at = run.search(/^\s*else\s*$/m);
      expect(at, "no else branch").toBeGreaterThanOrEqual(0);
      return run.slice(at);
    };

    it("does not claim nothing was staged when no id was recorded", () => {
      expect(elseBranch()).not.toMatch(/no staged version/i);
    });

    it("points at `npm stage list` and emits a ::warning annotation", () => {
      expect(elseBranch()).toMatch(/npm stage list/i);
      expect(elseBranch()).toMatch(/::warning/);
    });
  });

  describe("supply chain", () => {
    it("pins every action and reusable workflow to a 40-hex commit SHA", () => {
      const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map(
        (m) => m[1] ?? "",
      );
      expect(uses.length).toBeGreaterThan(0);
      expect(uses.filter((u) => !/^[^@\s]+@[0-9a-f]{40}$/.test(u))).toEqual([]);
    });

    it("resets top-level permissions instead of granting write-all", () => {
      const top = lines.filter((l) => /^permissions:/.test(l));
      expect(top).toEqual(["permissions: {}"]);
      expect(text).not.toMatch(/write-all/);
    });
  });
});
