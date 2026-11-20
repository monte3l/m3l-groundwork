// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// Fails when the documentation and the code disagree: the packs the README and
// templates/packs/README.md list against the pack directories (and, in both,
// the "Fresh mode only" claim against each pack's `modes`), the flags the README
// lists against the flags the CLI declares, the Node and pnpm versions the README
// names against `engines` and `packageManager`, and the `/customize` skill
// against the plugin's skills.
//
// The docs kit runs this as a parity module (docs.config.mjs `parity`), and
// `build.mjs --check` is part of `pnpm verify`, so a drift fails the same gate as
// a broken link. Standalone: `node bin/doc-parity.mjs` prints ok or the drift and
// exits 1. A file it cannot read or parse is reported as a message, never thrown,
// because a pack scaffolded without its pack.json is an ordinary state in the
// middle of a change.
//
// Not covered, on purpose: the exit-code and mode-signal prose, which is written
// as sentences about `fatal.ts` and `mode.ts` and would need a parser as
// brittle as the text it checks.
//
// Limits it inherits from the kit's table helper: a cell is cut at every `|`
// (so a pipe inside a cell breaks that row), and only the first table under a
// heading is read.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSame,
  assertSameSet,
  codeSpans,
  section,
  tableColumn,
} from "../design/source/docs-kit/lib/parity.mjs";

const read = (root, path) => readFileSync(join(root, path), "utf8");

/** Runs one group of checks; a file it cannot read becomes a message, not a crash. */
const guarded = (what, fn) => {
  try {
    return fn();
  } catch (error) {
    return [`cannot check ${what}: ${error.message}`];
  }
};

/**
 * The flags the CLI declares: every `"--flag"` literal inside a `*_FLAGS` set in
 * main.ts, such as `const VALUE_FLAGS = new Set(["--name"])`. A literal anywhere
 * else (an argument passed to a child process, a message) is not a flag.
 */
export const flagsInSource = (mainSource) => [
  ...new Set(
    [
      ...mainSource.matchAll(
        /const\s+[A-Z][A-Z_]*_FLAGS\b[^=]*=\s*new Set\(\[([^\]]*)\]/g,
      ),
    ].flatMap((set) =>
      [...set[1].matchAll(/"(--[a-z][a-z0-9-]*)"/g)].map((flag) => flag[1]),
    ),
  ),
];

/** The long flags the README's Flags table documents (`--name <value>` and `--name=<value>` are `--name`). */
export const documentedFlags = (flagsSection) =>
  tableColumn(flagsSection, 0)
    .flatMap(codeSpans)
    .map((span) => span.split(/[\s=]/)[0])
    .filter((word) => word.startsWith("--"));

/**
 * The packs a README table lists, in order, with the text of each row. A row
 * with no code span in its name cell is not a pack and is skipped, so a name
 * can never be paired with the text of another row.
 *
 * @param {string} body the section holding the table
 * @param {string} nameHeader the header of the column that names the pack
 * @param {string} textHeader the header of the column that describes it
 * @returns {{ name: string, text: string }[]}
 */
export function packRows(body, nameHeader, textHeader) {
  const texts = tableColumn(body, textHeader);
  return tableColumn(body, nameHeader)
    .map((cell, i) => ({ name: codeSpans(cell)[0], text: texts[i] ?? "" }))
    .filter((row) => row.name !== undefined);
}

/** A row says it runs in fresh mode only when its text contains those words. */
const claimsFreshOnly = (text) => /\bfresh mode only\b/i.test(text);

/**
 * The "Fresh mode only" claim of each row of one README table against the
 * `modes` of the pack, both ways. A pack whose modes are unknown (its pack.json
 * could not be read) is skipped: that is reported on its own.
 */
function modeClaimProblems(where, rows, modesOf) {
  const problems = [];
  for (const { name, text } of rows) {
    const modes = modesOf.get(name);
    if (!Array.isArray(modes)) continue;
    const isFreshOnly = modes.length === 1 && modes[0] === "fresh";
    if (claimsFreshOnly(text) && !isFreshOnly) {
      problems.push(
        `${where} says pack "${name}" is fresh mode only, but its pack.json modes are ${JSON.stringify(modes)}`,
      );
    }
    if (isFreshOnly && !claimsFreshOnly(text)) {
      problems.push(
        `pack "${name}" runs in fresh mode only, but its ${where} row does not say so`,
      );
    }
  }
  return problems;
}

/**
 * Pack problems: the two README tables against the pack directories, and the
 * "Fresh mode only" claim in each against each pack's `modes`.
 *
 * @param {{
 *   readme: string,
 *   packsReadme: string,
 *   packs: { name: string, modes: string[] | null }[],
 * }} input `modes` is null for a pack whose pack.json could not be read
 * @returns {string[]}
 */
export function packProblems({ readme, packsReadme, packs }) {
  const names = packs.map((pack) => pack.name);
  const mainSection = section(readme, "Packs");
  if (mainSection === null) return ["README has no Packs section"];
  const mainRows = packRows(mainSection, "Pack", "Contents");
  const problems = assertSameSet(
    "README packs table",
    mainRows.map((row) => row.name),
    names,
  );
  const modesOf = new Map(packs.map((pack) => [pack.name, pack.modes]));
  problems.push(...modeClaimProblems("README", mainRows, modesOf));

  const detail = section(packsReadme, "Available packs");
  if (detail === null) {
    problems.push("templates/packs/README.md has no Available packs section");
  } else {
    const detailRows = packRows(detail, "Pack", "Contents");
    problems.push(
      ...assertSameSet(
        "templates/packs/README.md packs table",
        detailRows.map((row) => row.name),
        names,
      ),
      ...modeClaimProblems("templates/packs/README.md", detailRows, modesOf),
    );
  }
  return problems;
}

/**
 * The Node and pnpm versions the README's Requirements section names, against
 * what the manifests say. The README promises `Node N+`; the published CLI's
 * `engines.node` must have N as its floor (`>=N`, `>=N.0.0`) and the repository's
 * `.node-version` must be at least N (a leading `v` is fine).
 *
 * @param {{
 *   readme: string,
 *   nodeVersion: string,
 *   cliEnginesNode: string,
 *   packageManager: string,
 * }} input
 * @returns {string[]}
 */
export function requirementProblems({
  readme,
  nodeVersion,
  cliEnginesNode,
  packageManager,
}) {
  const body = section(readme, "Requirements");
  if (body === null) return ["README has no Requirements section"];
  const problems = [];
  const node = /\*\*Node (\d+)(?:\+| or (?:newer|later))\*\*/.exec(body);
  if (node === null) {
    problems.push("README Requirements does not say **Node N+**");
  } else {
    const floor = /^>=\s*v?(\d+)/.exec(String(cliEnginesNode ?? ""))?.[1];
    problems.push(
      ...assertSame(
        "README Node requirement against packages/cli engines.node",
        node[1],
        floor ?? `something other than >=N (${cliEnginesNode})`,
      ),
    );
    const major = Number.parseInt(nodeVersion.trim().replace(/^v/, ""), 10);
    if (!(major >= Number(node[1]))) {
      problems.push(
        `README requires Node ${node[1]}+, but .node-version is ${nodeVersion.trim()}`,
      );
    }
  }
  const pnpm = /pins\s+(\d+\.\d+\.\d+)\s+through\s+`packageManager`/.exec(body);
  if (pnpm === null) {
    problems.push(
      "README Requirements does not say which pnpm version it pins through `packageManager`",
    );
  } else {
    problems.push(
      ...assertSame(
        "README pnpm version against package.json packageManager",
        `pnpm@${pnpm[1]}`,
        packageManager,
      ),
    );
  }
  return problems;
}

/** The `/customize` skill the README sends readers to must exist in the plugin. */
export const skillProblems = ({ readme, skillDirs }) =>
  readme.includes("/customize") && !skillDirs.includes("customize")
    ? [
        "README sends readers to the /customize skill, but packages/plugin/skills has no customize directory",
      ]
    : [];

/**
 * Every pack directory with its modes. A pack.json that cannot be read, is not
 * JSON, or has `modes` that is not an array is a problem, and the pack is kept
 * with `modes: null` so the tables are still compared by name.
 */
function loadPacks(root) {
  const problems = [];
  const packs = readdirSync(join(root, "templates", "packs"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = `templates/packs/${entry.name}/pack.json`;
      try {
        const { modes } = JSON.parse(read(root, file));
        if (Array.isArray(modes)) return { name: entry.name, modes };
        problems.push(`${file}: "modes" must be an array`);
      } catch (error) {
        problems.push(`${file}: cannot read it as JSON: ${error.message}`);
      }
      return { name: entry.name, modes: null };
    });
  return { packs, problems };
}

/** Returns one message per drift; empty when the documentation matches the code. */
export default function check({ root }) {
  return [
    ...guarded("the packs", () => {
      const { packs, problems } = loadPacks(root);
      return [
        ...problems,
        ...packProblems({
          readme: read(root, "README.md"),
          packsReadme: read(root, "templates/packs/README.md"),
          packs,
        }),
      ];
    }),
    ...guarded("the flags", () => {
      const flagsSection = section(read(root, "README.md"), "Flags");
      if (flagsSection === null) return ["README has no Flags section"];
      const declared = flagsInSource(read(root, "packages/cli/src/main.ts"));
      if (declared.length === 0) {
        return [
          "packages/cli/src/main.ts declares no flags in a `*_FLAGS` set any more, so the flags table cannot be checked",
        ];
      }
      return assertSameSet(
        "README flags table",
        documentedFlags(flagsSection),
        declared,
      );
    }),
    ...guarded("the requirements", () =>
      requirementProblems({
        readme: read(root, "README.md"),
        nodeVersion: read(root, ".node-version"),
        cliEnginesNode: JSON.parse(read(root, "packages/cli/package.json"))
          .engines?.node,
        packageManager: JSON.parse(read(root, "package.json")).packageManager,
      }),
    ),
    ...guarded("the plugin skills", () =>
      skillProblems({
        readme: read(root, "README.md"),
        skillDirs: readdirSync(join(root, "packages", "plugin", "skills"), {
          withFileTypes: true,
        })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      }),
    ),
  ];
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = check({ root });
  if (problems.length === 0) {
    console.log("ok: the documentation matches the code");
  } else {
    for (const problem of problems) console.error(`doc-parity: ${problem}`);
    process.exitCode = 1;
  }
}
