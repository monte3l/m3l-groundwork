// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures for the upgrade-plan tests: tiny template trees written
 * under a temp directory, and a project built the way fresh mode builds one
 * (`emitTemplate` + `installPack` + `buildManifest`).
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { emitTemplate } from "../src/emit.js";
import { buildManifest, sha256Hex } from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import { installPack, loadPack } from "../src/packs.js";

/** One release of the fixture templates: the baseline and its packs. */
export interface FixtureRelease {
  /** Baseline files, relative path to content (tokens allowed). */
  core: Readonly<Record<string, string>>;
  /** Packs by name. */
  packs: Readonly<
    Record<
      string,
      {
        files: Readonly<Record<string, string>>;
        scripts?: Readonly<Record<string, string>>;
        /** `.claude/settings.json` hook wiring, event to matcher entries. */
        hooks?: Readonly<
          Record<
            string,
            readonly { matcher?: string; hooks: readonly object[] }[]
          >
        >;
        requires?: readonly string[];
      }
    >
  >;
}

export interface WrittenRelease {
  templatesDir: string;
  packsRoot: string;
}

function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Writes `release` under `<base>/core` and `<base>/packs`. */
export function writeRelease(
  base: string,
  release: FixtureRelease,
): WrittenRelease {
  const templatesDir = join(base, "core");
  const packsRoot = join(base, "packs");
  mkdirSync(templatesDir, { recursive: true });
  mkdirSync(packsRoot, { recursive: true });
  writeTree(templatesDir, release.core);
  for (const [name, pack] of Object.entries(release.packs)) {
    const packDir = join(packsRoot, name);
    writeTree(join(packDir, "files"), pack.files);
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        schemaVersion: 1,
        name,
        description: `fixture pack ${name}`,
        modes: ["fresh"],
        budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
        requires: { paths: [...(pack.requires ?? [])] },
        wiring: {
          settings: { ...pack.hooks },
          packageScripts: { ...pack.scripts },
          verifySteps: [],
        },
      }),
    );
  }
  return { templatesDir, packsRoot };
}

/** Builds a project in `targetDir` exactly as fresh mode would, plus its manifest. */
export function buildProject(params: {
  written: WrittenRelease;
  packNames: readonly string[];
  targetDir: string;
  tokens: Record<string, string>;
  cliVersion: string;
}): Manifest {
  const { written, packNames, targetDir, tokens, cliVersion } = params;
  mkdirSync(targetDir, { recursive: true });
  const files = [
    ...emitTemplate(written.templatesDir, targetDir, tokens).filesWritten,
  ];
  for (const name of packNames) {
    const pack = loadPack(name, written.packsRoot);
    files.push(...installPack(pack, targetDir, tokens).filesWritten);
  }
  return buildManifest({
    targetDir,
    cliVersion,
    tokens,
    packs: packNames,
    files: files.map((file) => file.split("\\").join("/")),
  });
}

/** Every entry under `root` as `path -> description` (file hash, symlink target, or `dir`). */
export function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        out[rel] = `link:${readlinkSync(abs)}`;
      } else if (stat.isDirectory()) {
        out[rel] = "dir";
        visit(abs, rel);
      } else {
        out[rel] = `file:${sha256Hex(readFileSync(abs))}`;
      }
    }
  };
  visit(root, "");
  return out;
}
