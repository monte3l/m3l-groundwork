// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * DCO on every commit message: bin/lint-commit.mjs and its byte-twin in
 * templates/core must require a Signed-off-by trailer even on messages
 * commitlint's default ignores skip (merge, revert, fixup!, squash!).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const targets = [
  {
    name: "root",
    cwd: repoRoot,
    script: join(repoRoot, "bin", "lint-commit.mjs"),
  },
  {
    name: "twin",
    cwd: join(repoRoot, "templates", "core"),
    script: join(repoRoot, "templates", "core", "bin", "lint-commit.mjs"),
  },
];

const SIGN = "Signed-off-by: A Dev <a@example.com>";

interface Case {
  label: string;
  message: string;
  exit: 0 | 1;
  mentionsSignoff?: boolean;
  /** Fails only where the loaded config enables trailer-exists. */
  needsDco?: boolean;
}

const cases: Case[] = [
  {
    label: "conventional + trailer",
    message: `feat: add y\n\n${SIGN}\n`,
    exit: 0,
  },
  {
    label: "conventional, no trailer",
    message: "feat: add y\n",
    exit: 1,
    mentionsSignoff: true,
    needsDco: true,
  },
  {
    label: "forbidden Claude trailer",
    message: `feat: add y\n\nClaude-Foo: x\n${SIGN}\n`,
    exit: 1,
  },
  {
    label: "Co-Authored-By is fine",
    message: `feat: add y\n\nCo-Authored-By: B <b@example.com>\n${SIGN}\n`,
    exit: 0,
  },
  {
    label: "merge + trailer",
    message: `Merge branch 'x' into main\n\n${SIGN}\n`,
    exit: 0,
  },
  {
    label: "merge, no trailer",
    message: "Merge branch 'x' into main\n",
    exit: 1,
    mentionsSignoff: true,
    needsDco: true,
  },
  {
    label: "revert + trailer",
    message: `Revert "feat: add y"\n\n${SIGN}\n`,
    exit: 0,
  },
  {
    label: "revert, no trailer",
    message: 'Revert "feat: add y"\n',
    exit: 1,
    mentionsSignoff: true,
    needsDco: true,
  },
  {
    label: "fixup!, no trailer",
    message: "fixup! feat: add y\n",
    exit: 1,
    mentionsSignoff: true,
    needsDco: true,
  },
  {
    label: "squash!, no trailer",
    message: "squash! feat: add y\n",
    exit: 1,
    mentionsSignoff: true,
    needsDco: true,
  },
  {
    label: "merge, empty trailer value",
    message: "Merge branch 'x' into main\n\nSigned-off-by:\n",
    exit: 1,
    mentionsSignoff: true,
    needsDco: true,
  },
];

function run(
  t: { cwd: string; script: string },
  message: string,
  form: "inline" | "edit",
): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "lint-commit-"));
  try {
    let args: string[];
    if (form === "edit") {
      const file = join(dir, "COMMIT_EDITMSG");
      writeFileSync(file, message);
      args = [t.script, "--edit", file];
    } else {
      args = [t.script, message];
    }
    const r = spawnSync(process.execPath, args, {
      cwd: t.cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The twin's config (templates/core) has no trailer-exists rule, so DCO is not required there. */
const expectedExit = (name: string, c: Case): 0 | 1 =>
  name === "twin" && c.needsDco === true ? 0 : c.exit;

describe.each(targets)("lint-commit DCO ($name)", (t) => {
  describe.each(["inline", "edit"] as const)("%s form", (form) => {
    it.each(cases)("$label", (c) => {
      const r = run(t, c.message, form);
      expect(r.status).toBe(expectedExit(t.name, c));
      if (c.mentionsSignoff === true && t.name === "root") {
        expect(r.stderr).toContain("Signed-off-by");
      }
    });
  });
});

describe("lint-commit root/twin", () => {
  it.each(cases.filter((c) => c.needsDco === true))(
    "twin enforces the trailer when the loaded config enables trailer-exists: $label",
    (c) => {
      const cfgDir = mkdtempSync(join(tmpdir(), "lint-commit-cfg-"));
      try {
        writeFileSync(
          join(cfgDir, "commitlint.config.js"),
          'module.exports = { rules: { "trailer-exists": [2, "always", "Signed-off-by:"] } };\n',
        );
        const r = run(
          { cwd: cfgDir, script: targets[1]?.script ?? "" },
          c.message,
          "inline",
        );
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("Signed-off-by");
      } finally {
        rmSync(cfgDir, { recursive: true, force: true });
      }
    },
  );
});

/** Mirrors commitlint's own trailer-exists semantics on ignored and normal messages. */
interface RuleCase {
  label: string;
  rule: string;
  message: string;
  exit: 0 | 1;
  stderrIncludes?: string;
}

const A = "A <a@b>";
const ruleCases: RuleCase[] = [
  {
    label: "severity 1 warns only: unsigned conventional message",
    rule: '[1, "always", "Signed-off-by:"]',
    message: "fix: x\n",
    exit: 0,
  },
  {
    label: "severity 1 warns only: unsigned merge message",
    rule: '[1, "always", "Signed-off-by:"]',
    message: "Merge branch 'x'\n",
    exit: 0,
  },
  {
    label: "severity 0 is off: unsigned merge message",
    rule: '[0, "always", "Signed-off-by:"]',
    message: "Merge branch 'x'\n",
    exit: 0,
  },
  {
    label: "never is off: unsigned merge message",
    rule: '[2, "never", "Signed-off-by:"]',
    message: "Merge branch 'x'\n",
    exit: 0,
  },
  {
    label: "configured Reviewed-by present on merge message",
    rule: '[2, "always", "Reviewed-by:"]',
    message: `Merge branch 'x'\n\nReviewed-by: ${A}\n`,
    exit: 0,
  },
  {
    label: "configured Reviewed-by missing on merge message",
    rule: '[2, "always", "Reviewed-by:"]',
    message: `Merge branch 'x'\n\nSigned-off-by: ${A}\n`,
    exit: 1,
    stderrIncludes: "Reviewed-by",
  },
  {
    label: "Signed-off-by line followed by prose is not a trailer block",
    rule: '[2, "always", "Signed-off-by:"]',
    message: `Merge branch 'x'\n\nSigned-off-by: ${A}\n\nmore prose after\n`,
    exit: 1,
    stderrIncludes: "Signed-off-by",
  },
];

function runWithConfig(
  script: string,
  rule: string,
  message: string,
): { status: number | null; stderr: string } {
  const cfgDir = mkdtempSync(join(tmpdir(), "lint-commit-sem-"));
  try {
    writeFileSync(
      join(cfgDir, "commitlint.config.js"),
      `module.exports = { rules: { "trailer-exists": ${rule} } };\n`,
    );
    return run({ cwd: cfgDir, script }, message, "inline");
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
}

describe.each(targets)("lint-commit trailer-exists semantics ($name)", (t) => {
  it.each(ruleCases)("$label", (c) => {
    const r = runWithConfig(t.script, c.rule, c.message);
    expect(r.status).toBe(c.exit);
    if (c.stderrIncludes !== undefined) {
      expect(r.stderr).toContain(c.stderrIncludes);
    }
  });
});

describe("lint-commit root config: trailer block semantics", () => {
  it("a Signed-off-by line followed by prose does not satisfy DCO on an ignored message", () => {
    const r = run(
      targets[0] ?? { cwd: "", script: "" },
      `Merge branch 'x'\n\nSigned-off-by: ${A}\n\nmore prose after\n`,
      "inline",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Signed-off-by");
  });
});
