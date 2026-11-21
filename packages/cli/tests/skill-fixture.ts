// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/** Shared fixture for the generic skill-installer tests: a fake "demo" skill and a fake plugin source dir. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillSpec } from "../src/skill-spec.js";

export const DEMO_FILES: Readonly<Record<string, string>> = {
  "data.txt": "demo data\n",
  "step-1.md": "# step one\n",
  "SKILL.md": "# demo skill\n",
};

export const DEMO_SPEC: SkillSpec = {
  name: "demo",
  entryFile: "SKILL.md",
  writeOrder: ["data.txt", "step-1.md", "SKILL.md"],
  claudeSegments: [".claude", "skills", "demo"],
  fallbackSegments: [".groundwork", "demo"],
  sourceFile: (sourceDir, fileName) =>
    fileName.endsWith(".md")
      ? join(sourceDir, "skills", "demo", fileName)
      : join(sourceDir, "src", fileName),
};

/** Writes the demo payload under `sourceDir` where {@link DEMO_SPEC} reads it. */
export function writeDemoSource(sourceDir: string): void {
  for (const [name, content] of Object.entries(DEMO_FILES)) {
    const from = DEMO_SPEC.sourceFile(sourceDir, name);
    mkdirSync(dirname(from), { recursive: true });
    writeFileSync(from, content);
  }
}
