// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

interface Pack {
  name: string;
  modes: string[] | null;
}
interface DocParity {
  default(input: { root: string }): string[];
  flagsInSource(mainSource: string): string[];
  documentedFlags(flagsSection: string): string[];
  packRows(
    body: string,
    nameHeader: string,
    textHeader: string,
  ): { name: string; text: string }[];
  packProblems(input: {
    readme: string;
    packsReadme: string;
    packs: Pack[];
  }): string[];
  requirementProblems(input: {
    readme: string;
    nodeVersion: string;
    cliEnginesNode: string;
    packageManager: string;
  }): string[];
  skillProblems(input: { readme: string; skillDirs: string[] }): string[];
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "doc-parity.mjs")).href
)) as DocParity;

const table = (header: string[], rows: string[][]): string =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

describe("flagsInSource", () => {
  it("collects the long flags of the *_FLAGS sets once, and no other literal", () => {
    const source = [
      'const VALUE_FLAGS = new Set(["--name"]);',
      'const REPEATABLE_VALUE_FLAGS = new Set(["--pack"]);',
      "const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([",
      '  "--force",',
      '  "--force",',
      '  "-h",',
      "  ...HELP_FLAGS,",
      "]);",
      'spawn("pnpm", ["install", "--frozen-lockfile"]);',
      '  "  --adopt   Force adopt mode",',
      '  "With no --adopt/--fresh override, the target is inspected",',
      'throw new Error("--shell is not a flag");',
    ].join("\n");
    expect(lib.flagsInSource(source).sort()).toEqual([
      "--force",
      "--name",
      "--pack",
    ]);
  });

  it("finds none when main.ts stops declaring its flags that way", () => {
    expect(lib.flagsInSource('const flags = ["--name"];')).toEqual([]);
  });
});

describe("documentedFlags", () => {
  it("takes the flag from each code span, drops the value placeholder and short flags", () => {
    const section = table(
      ["Flag", "Effect"],
      [
        ["`--name <project-name>`", "Override the name."],
        ["`--pack=<name>`", "Install a pack."],
        ["`--adopt`", "Force adopt."],
        ["`--help`, `--version`", "Print usage."],
        ["`-h`", "Short."],
      ],
    );
    expect(lib.documentedFlags(section)).toEqual([
      "--name",
      "--pack",
      "--adopt",
      "--help",
      "--version",
    ]);
  });
});

describe("packRows", () => {
  it("pairs each pack name with the text of its own row", () => {
    const body = table(
      ["Pack", "Contents"],
      [
        ["`quality`", "A gate."],
        ["`github`", "Skills. Fresh mode only."],
      ],
    );
    expect(lib.packRows(body, "Pack", "Contents")).toEqual([
      { name: "quality", text: "A gate." },
      { name: "github", text: "Skills. Fresh mode only." },
    ]);
  });

  it("keeps a name with its own text when another row has two code spans or none", () => {
    const body = table(
      ["Pack", "Contents"],
      [
        ["`a`, `b`", "Two names in one cell."],
        ["no name here", "A row with no code span."],
        ["`licensing`", "Fresh mode only."],
      ],
    );
    expect(lib.packRows(body, "Pack", "Contents")).toEqual([
      { name: "a", text: "Two names in one cell." },
      { name: "licensing", text: "Fresh mode only." },
    ]);
  });
});

const packs: Pack[] = [
  { name: "quality", modes: ["fresh", "adopt"] },
  { name: "licensing", modes: ["fresh"] },
];
const packTable = (rows: string[][]): string =>
  table(["Pack", "Contents"], rows);
const readmeWith = (rows: string[][]): string =>
  `# R\n\n## Packs\n\n${packTable(rows)}\n\n## Next\n`;
const packsReadmeWith = (rows: string[][]): string =>
  `# P\n\n## Available packs\n\n${packTable(rows)}\n`;
const goodRows = [
  ["`quality`", "A gate. Adopt-capable."],
  ["`licensing`", "A header gate. Fresh mode only."],
];
const [qualityRow = [], licensingRow = []] = goodRows;

describe("packProblems", () => {
  it("accepts tables that match the pack directories and the modes", () => {
    expect(
      lib.packProblems({
        readme: readmeWith(goodRows),
        packsReadme: packsReadmeWith(goodRows),
        packs,
      }),
    ).toEqual([]);
  });

  it("names a pack the README lacks, and one that the directories lack", () => {
    const problems = lib.packProblems({
      readme: readmeWith([qualityRow, ["`bogus`", "Nothing."]]),
      packsReadme: packsReadmeWith(goodRows),
      packs,
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("in code, not in the docs: licensing"),
        expect.stringContaining("in the docs, not in code: bogus"),
      ]),
    );
  });

  it("checks the second README's table against the directories as well", () => {
    const problems = lib.packProblems({
      readme: readmeWith(goodRows),
      packsReadme: packsReadmeWith([qualityRow]),
      packs,
    });
    expect(problems).toEqual([
      expect.stringContaining(
        "templates/packs/README.md packs table: in code, not in the docs: licensing",
      ),
    ]);
  });

  it.each([
    ["README", readmeWith, packsReadmeWith],
    ["templates/packs/README.md", packsReadmeWith, readmeWith],
  ] as const)(
    "reports a %s that claims fresh mode only for a pack that also adopts",
    (where, withBad, withGood) => {
      const bad = withBad([
        ["`quality`", "A gate. Fresh mode only."],
        licensingRow,
      ]);
      const good = withGood(goodRows);
      const problems =
        where === "README"
          ? lib.packProblems({ readme: bad, packsReadme: good, packs })
          : lib.packProblems({ readme: good, packsReadme: bad, packs });
      expect(problems).toEqual([
        `${where} says pack "quality" is fresh mode only, but its pack.json modes are ["fresh","adopt"]`,
      ]);
    },
  );

  it.each([
    ["README", readmeWith, packsReadmeWith],
    ["templates/packs/README.md", packsReadmeWith, readmeWith],
  ] as const)(
    "reports a fresh-only pack whose %s row does not say so",
    (where, withBad, withGood) => {
      const bad = withBad([qualityRow, ["`licensing`", "A header gate."]]);
      const good = withGood(goodRows);
      const problems =
        where === "README"
          ? lib.packProblems({ readme: bad, packsReadme: good, packs })
          : lib.packProblems({ readme: good, packsReadme: bad, packs });
      expect(problems).toEqual([
        `pack "licensing" runs in fresh mode only, but its ${where} row does not say so`,
      ]);
    },
  );

  it("does not compare a claim with a pack whose pack.json could not be read", () => {
    const unknown: Pack[] = [
      { name: "quality", modes: null },
      { name: "licensing", modes: ["fresh"] },
    ];
    expect(
      lib.packProblems({
        readme: readmeWith(goodRows),
        packsReadme: packsReadmeWith(goodRows),
        packs: unknown,
      }),
    ).toEqual([]);
  });

  it("says so when a README section is missing", () => {
    expect(
      lib.packProblems({ readme: "# R\n", packsReadme: "", packs }),
    ).toEqual(["README has no Packs section"]);
    expect(
      lib.packProblems({
        readme: readmeWith(goodRows),
        packsReadme: "# P\n",
        packs,
      }),
    ).toEqual(["templates/packs/README.md has no Available packs section"]);
  });
});

const requirements = (node: string, pnpm: string): string =>
  `# R\n\n## Requirements\n\n- **Node ${node}+**. \`.node-version\` is the authority.\n- **pnpm**. This repo pins ${pnpm} through \`packageManager\`.\n`;

describe("requirementProblems", () => {
  const ok = {
    readme: requirements("24", "12.8.1"),
    nodeVersion: "26\n",
    cliEnginesNode: ">=24",
    packageManager: "pnpm@12.8.1",
  };

  it("accepts a README that matches the manifests, with .node-version above the floor", () => {
    expect(lib.requirementProblems(ok)).toEqual([]);
  });

  it("accepts harmless rewording and notation", () => {
    expect(
      lib.requirementProblems({
        ...ok,
        readme:
          "# R\n\n## Requirements\n\n- **Node 24 or newer**.\n- pnpm, which this repo pins\n  12.8.1 through `packageManager`.\n",
        cliEnginesNode: ">=24.0.0",
        nodeVersion: "v24.1.0\n",
      }),
    ).toEqual([]);
  });

  it("reports a Node floor that differs from engines.node", () => {
    expect(
      lib.requirementProblems({ ...ok, readme: requirements("25", "12.8.1") }),
    ).toEqual([expect.stringContaining('docs say "25", code says "24"')]);
  });

  it("reports an engines.node that is not a >=N floor", () => {
    expect(lib.requirementProblems({ ...ok, cliEnginesNode: "^24" })).toEqual([
      expect.stringContaining("something other than >=N (^24)"),
    ]);
  });

  it("reports a .node-version below the floor the README promises", () => {
    expect(lib.requirementProblems({ ...ok, nodeVersion: "22.1.0\n" })).toEqual(
      ["README requires Node 24+, but .node-version is 22.1.0"],
    );
  });

  it("reports a pnpm version that differs from packageManager", () => {
    expect(
      lib.requirementProblems({ ...ok, readme: requirements("24", "12.9.0") }),
    ).toEqual([
      expect.stringContaining(
        'docs say "pnpm@12.9.0", code says "pnpm@12.8.1"',
      ),
    ]);
  });

  it("says so when the README stops stating a version, or has no section", () => {
    expect(
      lib.requirementProblems({
        ...ok,
        readme: "# R\n\n## Requirements\n\n- Some Node.\n",
      }),
    ).toEqual([
      "README Requirements does not say **Node N+**",
      "README Requirements does not say which pnpm version it pins through `packageManager`",
    ]);
    expect(lib.requirementProblems({ ...ok, readme: "# R\n" })).toEqual([
      "README has no Requirements section",
    ]);
  });
});

describe("skillProblems", () => {
  it("wants the customize skill when the README sends readers to it", () => {
    expect(
      lib.skillProblems({
        readme: "Run /customize.",
        skillDirs: ["customize"],
      }),
    ).toEqual([]);
    expect(
      lib.skillProblems({ readme: "Run /customize.", skillDirs: [] }),
    ).toHaveLength(1);
    expect(lib.skillProblems({ readme: "No skill.", skillDirs: [] })).toEqual(
      [],
    );
  });
});

describe("the documentation and the code of this repository", () => {
  it("agree", () => {
    expect(lib.default({ root: repoRoot })).toEqual([]);
  });

  it("agree when run as a program", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "bin", "doc-parity.mjs")],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ok: the documentation matches the code");
    expect(result.status).toBe(0);
  });
});

// The same module against copies of the real files, one thing broken at a time:
// this is what proves the file reading is wired to the right paths, which the
// pure functions above cannot.
describe("against copies of the real files", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function copyOfRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "doc-parity-"));
    dirs.push(dir);
    for (const rel of ["README.md", ".node-version", "package.json"]) {
      cpSync(join(repoRoot, rel), join(dir, rel));
    }
    mkdirSync(join(dir, "packages", "cli", "src"), { recursive: true });
    for (const rel of [
      "packages/cli/src/main.ts",
      "packages/cli/package.json",
    ]) {
      cpSync(join(repoRoot, rel), join(dir, rel));
    }
    for (const rel of ["templates/packs", "packages/plugin/skills"]) {
      cpSync(join(repoRoot, rel), join(dir, rel), { recursive: true });
    }
    return dir;
  }
  const edit = (dir: string, rel: string, fn: (text: string) => string): void =>
    writeFileSync(join(dir, rel), fn(readFileSync(join(dir, rel), "utf8")));

  it("is clean on an untouched copy", () => {
    expect(lib.default({ root: copyOfRepo() })).toEqual([]);
  });

  it("notices a pack row that is gone from the README", () => {
    const dir = copyOfRepo();
    edit(dir, "README.md", (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("| `quality`"))
        .join("\n"),
    );
    expect(lib.default({ root: dir })).toEqual([
      "README packs table: in code, not in the docs: quality",
    ]);
  });

  it("notices a flag the CLI gains that the README does not document", () => {
    const dir = copyOfRepo();
    edit(dir, "packages/cli/src/main.ts", (text) =>
      text.replace('"--skip-install",', '"--skip-install",\n  "--shiny",'),
    );
    expect(lib.default({ root: dir })).toEqual([
      "README flags table: in code, not in the docs: --shiny",
    ]);
  });

  it("says so when main.ts no longer declares its flags in *_FLAGS sets", () => {
    const dir = copyOfRepo();
    edit(dir, "packages/cli/src/main.ts", (text) =>
      text.replaceAll("_FLAGS", "_OPTIONS"),
    );
    expect(lib.default({ root: dir })).toEqual([
      expect.stringContaining("declares no flags in a `*_FLAGS` set any more"),
    ]);
  });

  it("notices a pnpm version that has moved on", () => {
    const dir = copyOfRepo();
    edit(dir, "package.json", (text) =>
      text.replace(
        /"packageManager": "pnpm@[^"]+"/,
        '"packageManager": "pnpm@99.0.0"',
      ),
    );
    expect(lib.default({ root: dir })).toEqual([
      expect.stringContaining('code says "pnpm@99.0.0"'),
    ]);
  });

  it("notices a pack that stopped being fresh mode only, in both READMEs", () => {
    const dir = copyOfRepo();
    edit(dir, "templates/packs/publishing/pack.json", (text) =>
      text.replace(/"modes": \[[^\]]*\]/, '"modes": ["fresh", "adopt"]'),
    );
    expect(lib.default({ root: dir })).toEqual([
      expect.stringContaining(
        'README says pack "publishing" is fresh mode only',
      ),
      expect.stringContaining(
        'templates/packs/README.md says pack "publishing" is fresh mode only',
      ),
    ]);
  });

  it("notices the customize skill disappearing", () => {
    const dir = copyOfRepo();
    rmSync(join(dir, "packages", "plugin", "skills", "customize"), {
      recursive: true,
    });
    expect(lib.default({ root: dir })).toEqual([
      expect.stringContaining("no customize directory"),
    ]);
  });

  it("reports, and does not throw, for a pack scaffolded without its pack.json", () => {
    const dir = copyOfRepo();
    mkdirSync(join(dir, "templates", "packs", "newpack"));
    const problems = lib.default({ root: dir });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "templates/packs/newpack/pack.json: cannot read it as JSON",
        ),
        expect.stringContaining(
          "README packs table: in code, not in the docs: newpack",
        ),
      ]),
    );
  });

  it("reports, and does not throw, for a pack.json that is not JSON or has modes that is not an array", () => {
    const dir = copyOfRepo();
    writeFileSync(
      join(dir, "templates", "packs", "quality", "pack.json"),
      "{ nope",
    );
    edit(dir, "templates/packs/github/pack.json", (text) =>
      text.replace(/"modes": \[[^\]]*\]/, '"modes": "fresh"'),
    );
    const problems = lib.default({ root: dir });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "templates/packs/quality/pack.json: cannot read it as JSON",
        ),
        'templates/packs/github/pack.json: "modes" must be an array',
      ]),
    );
  });

  it("reports, and does not throw, for a file that is missing", () => {
    const dir = copyOfRepo();
    rmSync(join(dir, ".node-version"));
    expect(lib.default({ root: dir })).toEqual([
      expect.stringContaining("cannot check the requirements"),
    ]);
  });
});
