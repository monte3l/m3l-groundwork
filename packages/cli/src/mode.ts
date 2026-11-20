// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Decides which of the CLI's three modes runs: writing a fresh project into
 * an empty directory, adopting an already-established one, or planning an
 * upgrade of a project that has a manifest. Only fresh and adopt are ever
 * auto-detected; upgrade runs only when `--upgrade` asks for it. Adopt mode
 * never overwrites project files -- see conflicts.ts and inventory.ts for
 * what it does instead -- and neither does upgrade mode, which writes only
 * under `.groundwork/upgrade/`. Detection is a fact-check, never a guess it
 * hides: the signal that chose the mode is always carried alongside it so an
 * auto-detection is never a silent surprise.
 */
import { existsSync, readdirSync } from "node:fs";
import { extname } from "node:path";

type Mode = "fresh" | "adopt" | "upgrade";

export interface ModeDetection {
  mode: Mode;
  signal: string;
}

const LOOSE_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js"]);

/** Inspects `dir` and reports which mode it implies, and why. */
export function detectMode(dir: string): ModeDetection {
  if (!existsSync(dir)) {
    return { mode: "fresh", signal: `${dir} does not exist yet` };
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) {
    return { mode: "fresh", signal: `${dir} is empty` };
  }

  if (
    entries.some((entry) => entry.isFile() && entry.name === "package.json")
  ) {
    return { mode: "adopt", signal: "found package.json" };
  }

  // A worktree or submodule checkout has `.git` as a file (`gitdir: <path>`),
  // not a directory -- both mean an established repository.
  const gitEntry = entries.find((entry) => entry.name === ".git");
  if (gitEntry !== undefined) {
    return {
      mode: "adopt",
      signal: gitEntry.isDirectory()
        ? "found a .git directory"
        : "found a .git file (a worktree or submodule)",
    };
  }

  const looseSource = entries.find(
    (entry) =>
      entry.isFile() && LOOSE_SOURCE_EXTENSIONS.has(extname(entry.name)),
  );
  if (looseSource !== undefined) {
    return { mode: "adopt", signal: `found ${looseSource.name}` };
  }

  return {
    mode: "fresh",
    signal: `${dir} exists but has no recognizable project markers`,
  };
}

export interface ModeFlags {
  adopt: boolean;
  fresh: boolean;
  upgrade: boolean;
}

/**
 * Applies `--adopt`/`--fresh`/`--upgrade` overrides onto an auto-detected
 * mode. Throws if any two are passed -- an explicit contradiction should
 * never resolve silently to one of them.
 */
export function resolveMode(
  detected: ModeDetection,
  flags: ModeFlags,
): ModeDetection {
  if (flags.adopt && flags.fresh) {
    throw new Error("--adopt and --fresh are mutually exclusive");
  }
  if (flags.upgrade && (flags.adopt || flags.fresh)) {
    const other = flags.adopt ? "--adopt" : "--fresh";
    throw new Error(`--upgrade and ${other} are mutually exclusive`);
  }
  if (flags.upgrade) {
    return { mode: "upgrade", signal: "--upgrade forced" };
  }
  if (flags.adopt) {
    return { mode: "adopt", signal: "--adopt forced" };
  }
  if (flags.fresh) {
    return { mode: "fresh", signal: "--fresh forced" };
  }
  return detected;
}
