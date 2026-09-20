import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rulesUrl = pathToFileURL(
  join(
    here,
    "..",
    "..",
    "..",
    "..",
    "templates",
    "core",
    "bin",
    "lib",
    "harness-rules.mjs",
  ),
).href;

interface Reporter {
  ok: (message: string) => void;
  warn: (message: string) => void;
}

// Plain ESM outside every tsconfig, loaded by URL (see harness-parity.test.ts).
const { reportOfficialValidation } = (await import(rulesUrl)) as {
  reportOfficialValidation: (root: string, reporter: Reporter) => void;
};

let root: string;
let binDir: string;
let originalPath: string | undefined;

function collect(): { reporter: Reporter; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    reporter: {
      ok: (message) => lines.push(`ok ${message}`),
      warn: (message) => lines.push(`warn ${message}`),
    },
  };
}

/** Installs a stub `claude` that prints `stdout` and exits 0. */
function stubClaude(stdout: string): void {
  const script = join(binDir, "claude");
  writeFileSync(script, `#!/bin/sh\ncat <<'STUB_EOF'\n${stdout}\nSTUB_EOF\n`);
  chmodSync(script, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "official-validate-root-"));
  binDir = mkdtempSync(join(tmpdir(), "official-validate-bin-"));
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  originalPath = process.env["PATH"];
  // Only the stub dir plus /bin (for `cat`/`sh`): no real `claude` can win.
  process.env["PATH"] = `${binDir}:/bin`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe("reportOfficialValidation", () => {
  it("skips quietly, as an ok line, when the claude CLI is not installed", () => {
    const { reporter, lines } = collect();
    reportOfficialValidation(root, reporter);
    expect(lines).toEqual([
      "ok claude CLI not found -- skipped Anthropic's own validator",
    ]);
  });

  it("reports a clean run when the validator has no findings", () => {
    stubClaude(JSON.stringify({ success: true, contents: [] }));
    const { reporter, lines } = collect();
    reportOfficialValidation(root, reporter);
    expect(lines).toEqual(["ok claude plugin validate: no findings"]);
  });

  it("relays every error and warning as a warn line, with a root-relative file", () => {
    stubClaude(
      JSON.stringify({
        success: false,
        contents: [
          {
            file: join(root, ".claude", "skills", "bad", "SKILL.md"),
            errors: [{ path: "frontmatter", message: "broken" }],
            warnings: [{ path: "description", message: "thin" }],
          },
        ],
      }),
    );
    const { reporter, lines } = collect();
    reportOfficialValidation(root, reporter);
    // Each of the two directories is validated, so the stub answers twice.
    expect(lines).toContain(
      "warn [claude-validate] .claude/skills/bad/SKILL.md -- frontmatter: broken",
    );
    expect(lines).toContain(
      "warn [claude-validate] .claude/skills/bad/SKILL.md -- description: thin",
    );
    expect(lines.some((line) => line.startsWith("ok "))).toBe(false);
  });

  it("warns, rather than failing, when the validator's output is unreadable", () => {
    stubClaude("this is not json");
    const { reporter, lines } = collect();
    reportOfficialValidation(root, reporter);
    expect(lines).toEqual([
      "warn claude plugin validate gave no readable report for .claude/skills",
      "warn claude plugin validate gave no readable report for .claude/agents",
    ]);
  });

  it("does nothing when neither .claude/skills nor .claude/agents exists", () => {
    rmSync(join(root, ".claude"), { recursive: true, force: true });
    stubClaude(JSON.stringify({ contents: [] }));
    const { reporter, lines } = collect();
    reportOfficialValidation(root, reporter);
    expect(lines).toEqual([]);
  });
});
