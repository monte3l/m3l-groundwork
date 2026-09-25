/**
 * Decides whether the CLI is writing a fresh project into an empty directory
 * or adopting an already-established one. Adopt mode never overwrites
 * project files -- see conflicts.ts and inventory.ts for what it does
 * instead. Detection is a fact-check, never a guess it hides: the signal
 * that chose the mode is always carried alongside it so an auto-detection
 * is never a silent surprise.
 */
import { existsSync, readdirSync } from "node:fs";
import { extname } from "node:path";

type Mode = "fresh" | "adopt";

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
}

/**
 * Applies `--adopt`/`--fresh` overrides onto an auto-detected mode. Throws
 * if both are passed -- an explicit contradiction should never resolve
 * silently to one of the two.
 */
export function resolveMode(
  detected: ModeDetection,
  flags: ModeFlags,
): ModeDetection {
  if (flags.adopt && flags.fresh) {
    throw new Error("--adopt and --fresh are mutually exclusive");
  }
  if (flags.adopt) {
    return { mode: "adopt", signal: "--adopt forced" };
  }
  if (flags.fresh) {
    return { mode: "fresh", signal: "--fresh forced" };
  }
  return detected;
}
