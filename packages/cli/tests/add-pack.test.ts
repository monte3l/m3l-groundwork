// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `m3l-groundwork <dir> --add-pack <name>...` (issue #377, slice 3): the CLI
 * STAGES packs into an already-bootstrapped or adopted project, writing
 * nothing outside `<dir>/.groundwork/add-pack/<name>/`. Fixtures are real: a
 * bootstrapped project is `templates/core` plus a real pack emitted into a
 * per-test mkdtemp sandbox; an adopted one is hand-built around a schema-6
 * `.groundwork/inventory.json`. Every refusal is a CliUsageError (exit 2) that
 * leaves the whole tree byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chmodIneffective } from "./chmod-ineffective.js";
import {
  ADD_PACK_PLAN_FILE,
  ADD_PACK_PLAN_SCHEMA_VERSION,
  STAGED_ADD_PACK_DIR,
  assertAddPackWriteScope,
  runAddPack,
} from "../src/add-pack.js";
import { emitTemplate } from "../src/emit.js";
import { resolveCliVersion } from "../src/inventory.js";
import {
  CliUsageError,
  main,
  parseArgs,
  templatesCoreDir,
} from "../src/main.js";
import { stagePacks } from "../src/pack-stage.js";
import { installPack, loadPack, packsRootDir } from "../src/packs.js";
import { installCustomizeSkill } from "../src/plugin.js";

const TOKENS = { PROJECT_NAME: "acme", YEAR: "2026" };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "add-pack-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** A bootstrapped project: the real baseline plus the named real packs. */
function bootstrap(packs: string[] = []): string {
  const dir = join(root, "project");
  emitTemplate(templatesCoreDir(), dir, TOKENS);
  for (const name of packs) {
    installPack(loadPack(name), dir, TOKENS);
  }
  return dir;
}

/** An adopted project with every `.groundwork/` artifact a prior adopt + /customize leaves. */
function adopted(): string {
  const dir = join(root, "app");
  write(dir, "package.json", '{"name":"legacy-app","scripts":{"test":"x"}}\n');
  write(dir, "src/index.ts", "export const x = 1;\n");
  write(dir, ".groundwork/inventory.json", '{"schemaVersion":6}\n');
  write(dir, ".groundwork/adoption-report.md", "# report\n");
  write(dir, ".groundwork/adoption-decisions.json", '{"decided":true}\n');
  write(dir, ".groundwork/customization-report.md", "# customized\n");
  write(
    dir,
    ".groundwork/installed-packs.json",
    '{"schemaVersion":1,"packs":[{"name":"github"}]}\n',
  );
  write(dir, ".groundwork/packs/github/pack.json.staged", "{}\n");
  write(dir, ".groundwork/baseline/a.txt.staged", "a\n");
  write(dir, ".groundwork/customize/SKILL.md", "# skill\n");
  write(dir, ".groundwork/add-pack/other/plan.json", '{"other":1}\n');
  return dir;
}

/** Every entry under `dir`, by relative path: a directory, a symlink (with its target) or a file (with its sha256). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full).split("\\").join("/");
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        out[rel] = `l ${readlinkSync(full)}`;
      } else if (stat.isDirectory()) {
        out[rel] = "d";
        walk(full);
      } else {
        out[rel] =
          `f ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** Entries of `snap` at or under `prefix`. */
function subtree(
  snap: Record<string, string>,
  prefix: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snap).filter(
      ([key]) => key === prefix || key.startsWith(`${prefix}/`),
    ),
  );
}

/**
 * Asserts the run only ADDED entries, all under `.groundwork/add-pack/<name>`
 * for a requested pack (plus the two parent directories), and changed or
 * removed nothing that existed before.
 */
function expectOnlyAddPackAdditions(
  before: Record<string, string>,
  after: Record<string, string>,
  names: string[],
): void {
  for (const [key, value] of Object.entries(before)) {
    expect(after[key], `${key} must be untouched`).toBe(value);
  }
  const allowed = names.map((name) => `${STAGED_ADD_PACK_DIR}/${name}`);
  const added = Object.keys(after).filter((key) => !(key in before));
  for (const key of added) {
    const ok =
      key === ".groundwork" ||
      key === STAGED_ADD_PACK_DIR ||
      allowed.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
    expect(ok, `unexpected new entry ${key}`).toBe(true);
  }
}

interface Captured {
  lines: string[];
  thrown: unknown;
}

function run(argv: string[]): Captured {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let thrown: unknown;
  try {
    main(argv);
  } catch (error) {
    thrown = error;
  }
  const lines = logSpy.mock.calls.flatMap(([line]) => String(line).split("\n"));
  logSpy.mockRestore();
  return { lines, thrown };
}

/** Runs and requires success. */
function runOk(argv: string[]): string[] {
  const { lines, thrown } = run(argv);
  if (thrown !== undefined) throw thrown as Error;
  return lines;
}

function expectUsageError(argv: string[], ...patterns: RegExp[]): void {
  const { thrown } = run(argv);
  expect(thrown).toBeInstanceOf(CliUsageError);
  // The same mapping bin/m3l-groundwork.mjs applies at the real process exit.
  expect(thrown instanceof CliUsageError ? 2 : 1).toBe(2);
  for (const pattern of patterns) {
    expect((thrown as Error).message).toMatch(pattern);
  }
}

interface PlanShape {
  schemaVersion: number;
  kind: string;
  cliVersion: string;
  generatedAt: string;
  targetDir: string;
  origin: {
    kind: string;
    evidence: string[];
    inventorySchemaVersion?: number;
  };
  requiredMode: string;
  reinstall: boolean;
  tokens: Record<string, string>;
  pack: Record<string, unknown>;
  staged: {
    name: string;
    dir: string;
    suffix: string;
    manifest: { path: string; staged: string; sha256: string };
    files: { path: string; staged: string; sha256: string }[];
  };
  fileConflicts: { relPath: string; status: string }[];
  wiringObservations: string[];
  requires: { path: string; present: boolean }[];
  caps: {
    current: Record<string, number>;
    pack: Record<string, number>;
    total: Record<string, number>;
    limits: Record<string, number>;
    overCap: string[];
  };
  installation: { status: string; source: string };
  undetermined: string[];
}

function readPlan(dir: string, name: string): PlanShape {
  return JSON.parse(
    readFileSync(
      join(dir, ".groundwork", "add-pack", name, ADD_PACK_PLAN_FILE),
      "utf8",
    ),
  ) as PlanShape;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("constants", () => {
  it("pins the staging directory, the plan file name and the plan schema version", () => {
    expect(STAGED_ADD_PACK_DIR).toBe(".groundwork/add-pack");
    expect(ADD_PACK_PLAN_FILE).toBe("plan.json");
    expect(ADD_PACK_PLAN_SCHEMA_VERSION).toBe(1);
  });
});

describe("staging into a bootstrapped project", () => {
  it("writes exactly pack.json.staged, files/<path>.staged and plan.json under add-pack/<name>/, and nothing else anywhere", () => {
    const dir = bootstrap();
    const before = snapshot(dir);
    runOk([dir, "--add-pack", "quality"]);
    const after = snapshot(dir);

    expectOnlyAddPackAdditions(before, after, ["quality"]);
    const files = Object.keys(subtree(after, ".groundwork/add-pack/quality"))
      .filter((key) => after[key] !== "d")
      .map((key) => key.slice(".groundwork/add-pack/quality/".length))
      .sort();
    expect(files).toEqual(
      [
        "files/.claude/agents/type-design-analyzer.md.staged",
        "files/bin/check-file-budget.mjs.staged",
        "files/bin/file-budget-baseline.json.staged",
        "pack.json.staged",
        "plan.json",
      ].sort(),
    );
  });

  it("stages every file byte-for-byte (no token substitution) with sha256s matching the SOURCE bytes", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality"]);
    const plan = readPlan(dir, "quality");
    const packRoot = join(dir, ".groundwork/add-pack/quality");
    const source = join(packsRootDir(), "quality", "files");

    expect(plan.staged.name).toBe("quality");
    expect(plan.staged.dir).toBe(".groundwork/add-pack/quality");
    expect(plan.staged.suffix).toBe(".staged");
    expect(plan.staged.files.map((f) => f.path)).toEqual([
      ".claude/agents/type-design-analyzer.md",
      "bin/check-file-budget.mjs",
      "bin/file-budget-baseline.json",
    ]);
    for (const file of plan.staged.files) {
      expect(file.staged).toBe(`${file.path}.staged`);
      const sourceBytes = readFileSync(join(source, file.path));
      const stagedBytes = readFileSync(join(packRoot, "files", file.staged));
      expect(stagedBytes.equals(sourceBytes)).toBe(true);
      expect(file.sha256).toBe(sha256(sourceBytes));
    }
    expect(plan.staged.manifest.path).toBe("pack.json");
    expect(plan.staged.manifest.staged).toBe("pack.json.staged");
    expect(plan.staged.manifest.sha256).toBe(
      sha256(readFileSync(join(packRoot, "pack.json.staged"))),
    );
    expect(
      JSON.parse(readFileSync(join(packRoot, "pack.json.staged"), "utf8")),
    ).toEqual(loadPack("quality").manifest);
  });

  it("survives a published tarball's escaped names: a fresh-only pack stages tools/release/package-lock.json as .staged", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "publishing"]);
    const packRoot = join(dir, ".groundwork/add-pack/publishing");
    expect(
      readFileSync(
        join(packRoot, "files/tools/release/package-lock.json.staged"),
      ).length,
    ).toBeGreaterThan(0);
    expect(readPlan(dir, "publishing").requiredMode).toBe("fresh");
  });

  it("stages several packs in sorted order, deduplicated, each with its own complete plan.json", () => {
    const dir = bootstrap();
    const lines = runOk([
      dir,
      "--add-pack",
      "statusline",
      "--add-pack",
      "quality",
      "--add-pack",
      "quality",
    ]);
    const stagedLines = lines.filter((line) => line.startsWith("add-pack "));
    expect(stagedLines).toHaveLength(2);
    expect(stagedLines[0]).toMatch(/^add-pack quality: staged /);
    expect(stagedLines[1]).toMatch(/^add-pack statusline: staged /);
    expect(readPlan(dir, "quality").staged.name).toBe("quality");
    expect(readPlan(dir, "statusline").staged.name).toBe("statusline");
  });

  it("the exported runAddPack does the same as main()", () => {
    const dir = bootstrap();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAddPack(parseArgs([dir, "--add-pack", "quality"]));
    logSpy.mockRestore();
    expect(readPlan(dir, "quality").staged.name).toBe("quality");
  });

  it("does not run any mode detection or write the /customize skill copy", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality"]);
    const after = snapshot(dir);
    expect(
      Object.keys(after).filter((k) =>
        k.startsWith(".claude/skills/customize"),
      ),
    ).toEqual([]);
    expect(
      Object.keys(after).filter((k) => k === ".groundwork/inventory.json"),
    ).toEqual([]);
  });
});

describe("plan.json", () => {
  it("records schema, kind, versions, origin, mode, tokens and the pack's manifest facts", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-02-03T04:05:06.000Z"));
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality"]);
    const plan = readPlan(dir, "quality");
    const manifest = loadPack("quality").manifest;

    expect(plan.schemaVersion).toBe(1);
    expect(plan.kind).toBe("m3l-groundwork/add-pack-plan");
    expect(plan.cliVersion).toBe(resolveCliVersion());
    expect(plan.generatedAt).toBe("2031-02-03T04:05:06.000Z");
    expect(plan.targetDir).toBe(dir);
    expect(plan.origin.kind).toBe("bootstrapped");
    expect(plan.origin.evidence.length).toBeGreaterThan(0);
    expect(Object.hasOwn(plan.origin, "inventorySchemaVersion")).toBe(false);
    expect(plan.requiredMode).toBe("fresh");
    expect(plan.reinstall).toBe(false);
    expect(plan.tokens).toEqual({ PROJECT_NAME: "acme", YEAR: "2031" });
    expect(plan.pack).toMatchObject({
      name: "quality",
      description: manifest.description,
      modes: ["fresh", "adopt"],
      budget: { agents: 1, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: { paths: ["bin/lib/report.mjs"] },
      adoptNotes: manifest.adoptNotes,
    });
    expect(Object.hasOwn(plan.pack, "wiring")).toBe(true);
    expect(Object.hasOwn(plan.pack, "setupSteps")).toBe(true);
  });

  it("records fileConflicts (posix relPath) with the divergent file, the wiring observations, requires and the installation verdict", () => {
    const dir = bootstrap();
    write(dir, "bin/check-file-budget.mjs", "// my own\n");
    const lines = runOk([dir, "--add-pack", "quality"]);
    const plan = readPlan(dir, "quality");

    const byPath = Object.fromEntries(
      plan.fileConflicts.map((c) => [c.relPath, c.status]),
    );
    expect(byPath["bin/check-file-budget.mjs"]).toBe("divergent");
    expect(byPath["bin/file-budget-baseline.json"]).toBe("absent");
    expect(byPath[".claude/agents/type-design-analyzer.md"]).toBe("absent");
    expect(Array.isArray(plan.wiringObservations)).toBe(true);
    expect(plan.requires).toEqual([
      { path: "bin/lib/report.mjs", present: true },
    ]);
    expect(plan.installation.status).toBe("partial");
    expect(plan.installation.source).toBe("detected");
    expect(Array.isArray(plan.undetermined)).toBe(true);
    // 3 files, 1 divergent conflict, status word "partial".
    expect(lines).toContain(
      "add-pack quality: staged .groundwork/add-pack/quality/ (partial; 3 file(s), 1 conflict(s))",
    );
  });

  it("records the caps: current, the pack's budget, total, the limits, and overCap", () => {
    const dir = bootstrap();
    const agentsBefore = readdirSync(join(dir, ".claude/agents")).filter((n) =>
      n.endsWith(".md"),
    ).length;
    runOk([dir, "--add-pack", "quality"]);
    const { caps } = readPlan(dir, "quality");
    expect(caps.current["agents"]).toBe(agentsBefore);
    expect(caps.pack).toEqual({
      agents: 1,
      skills: 0,
      hooks: 0,
      workflows: 0,
      scripts: 0,
    });
    expect(caps.limits).toEqual({
      agents: 5,
      skills: 8,
      hooks: 10,
      workflows: 3,
      scripts: 12,
    });
    for (const key of ["agents", "skills", "hooks", "workflows", "scripts"]) {
      expect(caps.total[key]).toBe(
        (caps.current[key] ?? 0) + (caps.pack[key] ?? 0),
      );
    }
    const expectedOver = Object.keys(caps.limits).filter(
      (key) => (caps.total[key] ?? 0) > (caps.limits[key] ?? 0),
    );
    expect(caps.overCap).toEqual(expectedOver);
  });

  it("warns on an over-cap project but still stages and succeeds", () => {
    const dir = bootstrap();
    for (let i = 0; i < 5; i++) {
      write(dir, `.claude/agents/extra-${String(i)}.md`, "# extra\n");
    }
    const lines = runOk([dir, "--add-pack", "quality"]);
    const plan = readPlan(dir, "quality");
    expect(plan.caps.overCap).toContain("agents");
    expect(lines.some((line) => line.includes("over cap: agents"))).toBe(true);
    expect(plan.staged.files).toHaveLength(3);
  });

  it("prints the caps summary labelled project: while the default label stays templates/core:", () => {
    const dir = bootstrap();
    const lines = runOk([dir, "--add-pack", "quality"]);
    expect(lines.some((l) => /^project:(?!:) .*\(caps: /.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("templates/core:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("+ quality: "))).toBe(true);
  });

  it("plan.json is the same as a fresh run's: pretty JSON ending in a newline", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality"]);
    const text = readFileSync(
      join(dir, ".groundwork/add-pack/quality/plan.json"),
      "utf8",
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1');
  });
});

describe("tokens proposal", () => {
  it("prefers --name over everything", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality", "--name", "custom-name"]);
    expect(readPlan(dir, "quality").tokens["PROJECT_NAME"]).toBe("custom-name");
  });

  it("uses package.json's valid name over the directory basename when --name is absent", () => {
    const dir = bootstrap(); // emitted with name "acme"; the directory is "project"
    runOk([dir, "--add-pack", "quality"]);
    expect(readPlan(dir, "quality").tokens["PROJECT_NAME"]).toBe("acme");
  });

  it("falls back to the directory basename when package.json's name is not a valid package name", () => {
    const dir = bootstrap();
    write(dir, "package.json", '{"name":"Not Valid!","scripts":{}}\n');
    runOk([dir, "--add-pack", "quality"]);
    expect(readPlan(dir, "quality").tokens["PROJECT_NAME"]).toBe("project");
  });

  it("rejects an invalid --name as a usage error and writes nothing", () => {
    const dir = bootstrap();
    const before = snapshot(root);
    expectUsageError(
      [dir, "--add-pack", "quality", "--name", "Bad Name"],
      /--name/,
    );
    expect(snapshot(root)).toEqual(before);
  });
});

describe("staging into an adopted project", () => {
  it("leaves every project file and every existing .groundwork artifact byte-identical, adding only add-pack/<name>/", () => {
    const dir = adopted();
    const before = snapshot(dir);
    runOk([dir, "--add-pack", "statusline", "--add-pack", "quality"]);
    const after = snapshot(dir);
    expectOnlyAddPackAdditions(before, after, ["quality", "statusline"]);
    // The planted ledger, decisions, report, staged packs/baseline survive.
    for (const rel of [
      ".groundwork/inventory.json",
      ".groundwork/adoption-decisions.json",
      ".groundwork/customization-report.md",
      ".groundwork/installed-packs.json",
      ".groundwork/packs/github/pack.json.staged",
      ".groundwork/baseline/a.txt.staged",
      ".groundwork/add-pack/other/plan.json",
      "package.json",
      "src/index.ts",
    ]) {
      expect(after[rel], rel).toBe(before[rel]);
    }
  });

  it("records origin adopted with its inventory schema version, requiredMode adopt, and a missing required path as a fact, not an error", () => {
    const dir = adopted();
    runOk([dir, "--add-pack", "quality"]);
    const plan = readPlan(dir, "quality");
    expect(plan.origin.kind).toBe("adopted");
    expect(plan.origin.inventorySchemaVersion).toBe(6);
    expect(plan.requiredMode).toBe("adopt");
    expect(plan.requires).toEqual([
      { path: "bin/lib/report.mjs", present: false },
    ]);
  });

  it("proposes PROJECT_NAME from package.json's name (not the directory basename)", () => {
    const dir = adopted();
    runOk([dir, "--add-pack", "quality"]);
    expect(readPlan(dir, "quality").tokens["PROJECT_NAME"]).toBe("legacy-app");
  });

  it("reports the printed status word for a pack the adopted project does not have", () => {
    const dir = adopted();
    const lines = runOk([dir, "--add-pack", "statusline"]);
    const plan = readPlan(dir, "statusline");
    expect(plan.installation.status).toBe("not-installed");
    expect(lines).toContain(
      `add-pack statusline: staged .groundwork/add-pack/statusline/ (not installed; ${String(plan.staged.files.length)} file(s), 0 conflict(s))`,
    );
    expect(plan.staged.files).toHaveLength(6);
  });
});

describe("an outdated ledger pack", () => {
  /** A bootstrapped project whose ledger records `statusline` from an older CLI with a stale manifest. */
  function outdatedProject(): string {
    const dir = bootstrap(["statusline"]);
    write(
      dir,
      ".groundwork/installed-packs.json",
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            name: "statusline",
            cliVersion: "0.0.1",
            manifestSha256: "0".repeat(64),
          },
        ],
      }),
    );
    return dir;
  }

  it("refuses without --reinstall, saying it is installed and outdated and naming --reinstall, and writes nothing", () => {
    const dir = outdatedProject();
    const before = snapshot(root);
    const { thrown } = run([dir, "--add-pack", "statusline"]);
    expect(thrown).toBeInstanceOf(CliUsageError);
    // Only the refusal text: every usage error appends USAGE, which
    // documents --update.
    const message = (thrown as Error).message.split("\n\n")[0] ?? "";
    expect(message).toMatch(/statusline/);
    expect(message).toMatch(/installed/);
    expect(message).toMatch(/outdated/);
    expect(message).toMatch(/--reinstall/);
    // Both ways out: bring the whole project forward, or restage this pack.
    expect(message).toMatch(/--update/);
    expect(message).toMatch(/whole project/);
    expect(message).toMatch(/just this pack|only this pack/);
    expect(snapshot(root)).toEqual(before);
  });

  it("stages with --reinstall and records outdated in the plan", () => {
    const dir = outdatedProject();
    const before = snapshot(dir);
    const lines = runOk([dir, "--add-pack", "statusline", "--reinstall"]);
    expectOnlyAddPackAdditions(before, snapshot(dir), ["statusline"]);
    const plan = readPlan(dir, "statusline");
    expect(plan.reinstall).toBe(true);
    expect(plan.installation.status).toBe("outdated");
    expect(
      lines.some(
        (l) =>
          l.startsWith("add-pack statusline: staged ") &&
          l.includes("(outdated;"),
      ),
    ).toBe(true);
  });
});

describe("--reinstall", () => {
  it("refuses an installed pack without --reinstall, naming the pack and the flag", () => {
    const dir = bootstrap(["statusline"]);
    const before = snapshot(root);
    expectUsageError(
      [dir, "--add-pack", "statusline"],
      /statusline/,
      /--reinstall/,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("stages an installed pack with --reinstall and records it in the plan", () => {
    const dir = bootstrap(["statusline"]);
    const before = snapshot(dir);
    const lines = runOk([dir, "--add-pack", "statusline", "--reinstall"]);
    expectOnlyAddPackAdditions(before, snapshot(dir), ["statusline"]);
    const plan = readPlan(dir, "statusline");
    expect(plan.reinstall).toBe(true);
    expect(plan.installation.status).toBe("installed");
    expect(
      lines.some(
        (l) =>
          l.startsWith("add-pack statusline: staged ") &&
          l.includes("(installed;"),
      ),
    ).toBe(true);
  });

  it("proceeds for a partially installed pack and records partial", () => {
    const dir = bootstrap(["statusline"]);
    rmSync(join(dir, ".claude/hooks/statusline.mjs"));
    runOk([dir, "--add-pack", "statusline"]);
    expect(readPlan(dir, "statusline").installation.status).toBe("partial");
  });

  it("refuses an installed pack that the ledger lists, too (adopted project)", () => {
    const dir = adopted(); // the ledger lists github
    const before = snapshot(root);
    expectUsageError([dir, "--add-pack", "github"], /github/, /--reinstall/);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("refusals (exit 2, tree byte-identical)", () => {
  const cases: [string, () => string[], RegExp[]][] = [
    [
      "a missing target directory",
      () => [join(root, "nope"), "--add-pack", "quality"],
      [/nope/],
    ],
    [
      "an empty directory",
      () => {
        const dir = join(root, "empty");
        mkdirSync(dir);
        return [dir, "--add-pack", "quality"];
      },
      [/nothing to add a pack to/, /--pack <name>/],
    ],
    [
      "a directory that is not a groundwork project",
      () => {
        const dir = join(root, "plain");
        write(dir, "package.json", "{}\n");
        return [dir, "--add-pack", "quality"];
      },
      [/not a groundwork project/, /m3l-groundwork/],
    ],
    [
      "an interrupted adopt run",
      () => {
        const dir = join(root, "half");
        write(dir, "package.json", "{}\n");
        write(dir, ".groundwork/packs/x/pack.json.staged", "{}\n");
        return [dir, "--add-pack", "quality"];
      },
      [/did not complete/, /m3l-groundwork/],
    ],
    [
      "a fresh-only pack (publishing) on an adopted project",
      () => [adopted(), "--add-pack", "publishing"],
      [/publishing/, /adopt/],
    ],
    [
      "a fresh-only pack (licensing) on an adopted project",
      () => [adopted(), "--add-pack", "licensing"],
      [/licensing/, /adopt/],
    ],
    [
      "a valid pack beside a fresh-only one on an adopted project (nothing staged for the valid one)",
      () => [adopted(), "--add-pack", "quality", "--add-pack", "publishing"],
      [/publishing/],
    ],
    [
      "an unknown pack name, listing the available packs",
      () => [bootstrap(), "--add-pack", "no-such-pack"],
      [/no-such-pack/, /quality/, /statusline/],
    ],
    [
      "a valid pack beside an unknown one (nothing staged for the valid one)",
      () => [
        bootstrap(),
        "--add-pack",
        "quality",
        "--add-pack",
        "no-such-pack",
      ],
      [/no-such-pack/],
    ],
    [
      "a missing required path on a bootstrapped project",
      () => {
        const dir = bootstrap();
        rmSync(join(dir, "bin/lib/report.mjs"));
        return [dir, "--add-pack", "quality"];
      },
      [/bin\/lib\/report\.mjs/],
    ],
    [
      "--add-pack with --pack",
      () => [bootstrap(), "--add-pack", "quality", "--pack", "statusline"],
      [/--add-pack/, /--pack/, /usage: m3l-groundwork/],
    ],
    [
      "--add-pack with --adopt",
      () => [bootstrap(), "--add-pack", "quality", "--adopt"],
      [/--add-pack/, /--adopt/],
    ],
    [
      "--add-pack with --fresh",
      () => [bootstrap(), "--add-pack", "quality", "--fresh"],
      [/--add-pack/, /--fresh/],
    ],
    [
      "--add-pack with --force",
      () => [bootstrap(), "--add-pack", "quality", "--force"],
      [/--add-pack/, /--force/],
    ],
    [
      "--add-pack with --skip-install",
      () => [bootstrap(), "--add-pack", "quality", "--skip-install"],
      [/--add-pack/, /--skip-install/],
    ],
    [
      "--reinstall without --add-pack",
      () => [bootstrap(), "--reinstall"],
      [/--reinstall/, /--add-pack/],
    ],
    [
      "--add-pack without a target directory",
      () => ["--add-pack", "quality"],
      [/usage: m3l-groundwork/],
    ],
  ];

  it.each(cases)("%s", (_label, setup, patterns) => {
    const argv = setup();
    const before = snapshot(root);
    expectUsageError(argv, ...patterns);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("assertAddPackWriteScope", () => {
  const TARGET = "/work/app";
  const PREFIX = "add-pack mode wrote outside its scope:";

  it.each([
    [".groundwork/add-pack/quality/plan.json"],
    [join(TARGET, ".groundwork", "add-pack", "quality", "files", "x.staged")],
  ])("accepts the in-scope path %s", (path) => {
    expect(() => {
      assertAddPackWriteScope(TARGET, [path]);
    }).not.toThrow();
  });

  it("accepts an empty path list", () => {
    expect(() => {
      assertAddPackWriteScope(TARGET, []);
    }).not.toThrow();
  });

  it.each([
    ["a project file", join(TARGET, "package.json")],
    ["an existing .groundwork artifact", ".groundwork/inventory.json"],
    ["adopt's packs/ staging", ".groundwork/packs/quality/pack.json.staged"],
    ["a ../ escape", ".groundwork/add-pack/../inventory.json"],
    ["the look-alike .groundwork-evil/", ".groundwork-evil/add-pack/x"],
    [
      "the look-alike .groundwork/add-pack-evil/",
      ".groundwork/add-pack-evil/x",
    ],
    [
      "the /customize skill dir adopt mode may write",
      ".claude/skills/customize/SKILL.md",
    ],
  ])(
    "rejects %s with the scope message naming the resolved path",
    (_l, path) => {
      let thrown: unknown;
      try {
        assertAddPackWriteScope(TARGET, [path]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AssertionError);
      expect((thrown as AssertionError).message).toContain(PREFIX);
    },
  );

  it("names the first offending path and stops there", () => {
    let thrown: unknown;
    try {
      assertAddPackWriteScope(TARGET, [
        ".groundwork/add-pack/a/plan.json",
        ".groundwork-evil/x",
        "package.json",
      ]);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as AssertionError).message;
    expect(message).toContain(join(TARGET, ".groundwork-evil", "x"));
    expect(message).not.toContain(join(TARGET, "package.json"));
  });
});

describe.skipIf(process.platform === "win32")(
  "symlink refusals happen before ANY write",
  () => {
    function expectRefused(dir: string, argv: string[], outside: string): void {
      const before = snapshot(root);
      const outsideBefore = snapshot(outside);
      const { thrown } = run(argv);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/symlink/i);
      expect(snapshot(root)).toEqual(before);
      expect(snapshot(outside)).toEqual(outsideBefore);
      void dir;
    }

    it("refuses a symlinked .groundwork", () => {
      const dir = bootstrap();
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(dir, ".groundwork"));
      expectRefused(dir, [dir, "--add-pack", "quality"], outside);
    });

    it("refuses a symlinked .groundwork/add-pack", () => {
      const dir = bootstrap();
      const outside = join(root, "outside");
      mkdirSync(outside);
      mkdirSync(join(dir, ".groundwork"));
      symlinkSync(outside, join(dir, ".groundwork/add-pack"));
      expectRefused(dir, [dir, "--add-pack", "quality"], outside);
    });

    it("refuses a symlinked .groundwork/add-pack/<name>, even for the SECOND pack, before the first is staged", () => {
      const dir = bootstrap();
      const outside = join(root, "outside");
      mkdirSync(outside);
      mkdirSync(join(dir, ".groundwork/add-pack"), { recursive: true });
      symlinkSync(outside, join(dir, ".groundwork/add-pack/statusline"));
      expectRefused(
        dir,
        [dir, "--add-pack", "quality", "--add-pack", "statusline"],
        outside,
      );
    });
  },
);

describe("restaging and the stale-work-dir sweep", () => {
  it("staging pack B leaves add-pack/A/ byte-identical", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality"]);
    const quality = subtree(snapshot(dir), ".groundwork/add-pack/quality");
    runOk([dir, "--add-pack", "statusline"]);
    expect(subtree(snapshot(dir), ".groundwork/add-pack/quality")).toEqual(
      quality,
    );
    expect(readPlan(dir, "statusline").staged.name).toBe("statusline");
  });

  it("restaging A replaces only add-pack/A/ (a stale file in it is gone) and leaves B byte-identical", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "quality", "--add-pack", "statusline"]);
    write(dir, ".groundwork/add-pack/quality/files/stale.txt.staged", "old\n");
    const statusline = subtree(
      snapshot(dir),
      ".groundwork/add-pack/statusline",
    );
    const before = snapshot(dir);
    runOk([dir, "--add-pack", "quality"]);
    const after = snapshot(dir);
    expect(
      after[".groundwork/add-pack/quality/files/stale.txt.staged"],
    ).toBeUndefined();
    expect(subtree(after, ".groundwork/add-pack/statusline")).toEqual(
      statusline,
    );
    expect(after[".groundwork/add-pack/quality/plan.json"]).toBeDefined();
    // Everything outside add-pack/quality is unchanged.
    for (const [key, value] of Object.entries(before)) {
      if (key.startsWith(".groundwork/add-pack/quality")) continue;
      expect(after[key], key).toBe(value);
    }
  });

  it("sweeps only .<name>-* work dirs of the pack being staged, never a sibling pack's directory or work dir", () => {
    const dir = bootstrap();
    runOk([dir, "--add-pack", "statusline"]);
    write(dir, ".groundwork/add-pack/.quality-AbC123/previous/x", "x\n");
    write(dir, ".groundwork/add-pack/.statusline-ZzZ999/previous/y", "y\n");
    const statusline = subtree(
      snapshot(dir),
      ".groundwork/add-pack/statusline",
    );
    runOk([dir, "--add-pack", "quality"]);
    const after = snapshot(dir);
    expect(after[".groundwork/add-pack/.quality-AbC123"]).toBeUndefined();
    expect(
      after[".groundwork/add-pack/.statusline-ZzZ999/previous/y"],
    ).toBeDefined();
    for (const [key, value] of Object.entries(statusline)) {
      expect(after[key], key).toBe(value);
    }
  });
});

describe("output", () => {
  it("prints one line per pack, the caps summary, and the update-the-plugin next line when /customize is absent", () => {
    const dir = bootstrap();
    const lines = runOk([
      dir,
      "--add-pack",
      "quality",
      "--add-pack",
      "statusline",
    ]);
    expect(lines[0]).toBe(
      "add-pack quality: staged .groundwork/add-pack/quality/ (not installed; 3 file(s), 0 conflict(s))",
    );
    expect(lines[1]).toBe(
      "add-pack statusline: staged .groundwork/add-pack/statusline/ (not installed; 6 file(s), 0 conflict(s))",
    );
    expect(lines.at(-1)).toBe(
      "next: update the groundwork plugin (or replace .claude/skills/customize/ with the current copy), then run /customize add-pack quality statusline",
    );
  });

  it("prints the plain next line when the project's /customize copy is current", () => {
    const dir = bootstrap();
    installCustomizeSkill(dir);
    const lines = runOk([dir, "--add-pack", "quality"]);
    expect(lines.at(-1)).toBe("next: run /customize add-pack quality");
  });

  it("prints the update line when the project's /customize copy is stale, and never rewrites it", () => {
    const dir = bootstrap();
    installCustomizeSkill(dir);
    write(dir, ".claude/skills/customize/SKILL.md", "# an older copy\n");
    const before = subtree(snapshot(dir), ".claude/skills/customize");
    const lines = runOk([dir, "--add-pack", "quality"]);
    expect(lines.at(-1)).toMatch(/^next: update the groundwork plugin /);
    expect(subtree(snapshot(dir), ".claude/skills/customize")).toEqual(before);
  });

  it("emits no raw terminal control characters even for a hostile directory name", () => {
    const hostile = join(root, "evil\u001b[2Jdir");
    emitTemplate(templatesCoreDir(), hostile, TOKENS);
    write(hostile, "package.json", '{"name":"Not Valid\\u001b[31m"}\n');
    const lines = runOk([hostile, "--add-pack", "quality"]);
    for (const line of lines) {
      // eslint-disable-next-line no-control-regex -- asserting the absence of control characters is the point
      expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    }
  });
});

describe("adopt's stagePacks is unchanged by the writePack refactor (characterization)", () => {
  it("still writes packs/<name>/pack.json.staged and files/<path>.staged only, records the literal .groundwork/packs/<name> dir and the source-byte hashes, and never writes a plan.json", () => {
    const groundwork = join(root, ".groundwork");
    const pack = loadPack("quality");
    const staged = stagePacks([pack], groundwork, TOKENS);
    expect(staged).toHaveLength(1);
    const [entry] = staged;
    expect(entry?.dir).toBe(".groundwork/packs/quality");
    expect(entry?.suffix).toBe(".staged");
    expect(entry?.manifest).toMatchObject({
      path: "pack.json",
      staged: "pack.json.staged",
    });
    const snap = snapshot(groundwork);
    const files = Object.keys(snap)
      .filter((k) => snap[k] !== "d")
      .sort();
    expect(files).toEqual(
      [
        "packs/quality/files/.claude/agents/type-design-analyzer.md.staged",
        "packs/quality/files/bin/check-file-budget.mjs.staged",
        "packs/quality/files/bin/file-budget-baseline.json.staged",
        "packs/quality/pack.json.staged",
      ].sort(),
    );
    for (const file of entry?.files ?? []) {
      const source = readFileSync(join(pack.filesDir, file.path));
      expect(file.sha256).toBe(sha256(source));
      expect(
        readFileSync(
          join(groundwork, "packs/quality/files", file.staged),
        ).equals(source),
      ).toBe(true);
    }
  });
});

describe.skipIf(chmodIneffective)(
  "an unwritable .groundwork leaves the tree unchanged",
  () => {
    it("fails without leaving a partial add-pack/<name>/ when .groundwork cannot be written", () => {
      const dir = bootstrap();
      mkdirSync(join(dir, ".groundwork"));
      chmodSync(join(dir, ".groundwork"), 0o500);
      try {
        const before = snapshot(root);
        const { thrown } = run([dir, "--add-pack", "quality"]);
        expect(thrown).toBeInstanceOf(Error);
        expect(snapshot(root)).toEqual(before);
      } finally {
        chmodSync(join(dir, ".groundwork"), 0o700);
      }
    });
  },
);

describe("runAddPack called directly", () => {
  it("rejects an invalid projectName as a usage error and writes nothing", () => {
    const dir = bootstrap();
    const options = parseArgs([dir, "--add-pack", "quality"]);
    const before = snapshot(root);
    let thrown: unknown;
    try {
      runAddPack({ ...options, projectName: "Not Valid" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toMatch(/--name must be a valid npm/);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("a path that cannot be checked is a plain error, not a usage error", () => {
  function expectCheckFailure(thrown: unknown, path: string): void {
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toContain(`could not check ${path}`);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  }

  it.skipIf(chmodIneffective)(
    "names the target when its parent is unsearchable",
    () => {
      const dir = bootstrap();
      const before = snapshot(root);
      chmodSync(root, 0o600);
      let thrown: unknown;
      try {
        thrown = run([dir, "--add-pack", "quality"]).thrown;
      } finally {
        chmodSync(root, 0o700);
      }
      expectCheckFailure(thrown, dir);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "names a required path that resolves to a symlink loop (ELOOP, not absence)",
    () => {
      const dir = bootstrap();
      const required = join(dir, "bin", "lib", "report.mjs");
      rmSync(required);
      symlinkSync("report.mjs", required);
      const before = snapshot(root);
      const { thrown } = run([dir, "--add-pack", "quality"]);
      expectCheckFailure(thrown, required);
      expect(snapshot(root)).toEqual(before);
    },
  );
});

describe("an unparseable package.json is recorded, not silently under-counted", () => {
  it("still stages, notes package.json by relative path in plan.undetermined, and leaks neither its content nor a parser message", () => {
    const dir = adopted();
    // Assembled at runtime: a secret-shaped value inside a broken JSON file.
    const secret = ["sk-live", "ZZ9-recognisable-secret"].join("_");
    write(dir, "package.json", `{"scripts": {"token": "${secret}"`);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* captured via mock.calls */
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* captured via mock.calls */
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const lines = runOk([dir, "--add-pack", "quality"]);
    const stderr = [
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...stderrSpy.mock.calls,
    ]
      .flat()
      .map(String);

    const planText = readFileSync(
      join(dir, STAGED_ADD_PACK_DIR, "quality", ADD_PACK_PLAN_FILE),
      "utf8",
    );
    const plan = readPlan(dir, "quality");
    expect(
      plan.undetermined.some((note) => note.includes("package.json")),
    ).toBe(true);
    for (const note of plan.undetermined) {
      expect(note).not.toContain(dir);
    }
    for (const text of [planText, ...lines, ...stderr]) {
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/JSON at position|Unexpected (token|end)/i);
    }
  });

  it("does not add the note when package.json parses", () => {
    const dir = adopted();
    runOk([dir, "--add-pack", "quality"]);
    expect(
      readPlan(dir, "quality").undetermined.some((note) =>
        note.includes("package.json"),
      ),
    ).toBe(false);
  });
});

describe.skipIf(chmodIneffective)(
  "an unlistable target directory is a plain error, not a usage error",
  () => {
    it("names the path and errno, keeps the cause, and writes nothing", () => {
      const dir = bootstrap();
      const before = snapshot(root);
      chmodSync(dir, 0o000);
      let thrown: unknown;
      try {
        thrown = run([dir, "--add-pack", "quality"]).thrown;
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      const message = (thrown as Error).message;
      expect(message).toContain(dir);
      expect(message).toMatch(/EACCES|EPERM/);
      const cause = (thrown as Error).cause as NodeJS.ErrnoException;
      expect(cause).toBeInstanceOf(Error);
      expect(message).toContain(String(cause.code));
      expect(snapshot(root)).toEqual(before);
    });
  },
);

describe("the mode-refusal message", () => {
  it("keeps the pack name, adopt and the modes list, and no longer tells users to copy by hand", () => {
    const { thrown } = run([adopted(), "--add-pack", "publishing"]);
    expect(thrown).toBeInstanceOf(CliUsageError);
    const message = (thrown as Error).message;
    expect(message).toContain("publishing");
    expect(message).toContain("adopt");
    expect(message).toMatch(/modes: /);
    expect(message).not.toContain("by hand");
  });
});
