/**
 * Follows one tsconfig's `extends` chain and folds `compilerOptions` the way
 * TypeScript does: array entries (TS 5.0+) left to right, the file's own
 * options last. Shared by the toolchain grader and the adopt-mode survey so
 * the two can never disagree about what a project's effective flags are.
 *
 * Handles a relative target (`x`, `x.json`, `x/tsconfig.json`) and a bare
 * package specifier looked up under every ancestor `node_modules`. A package
 * `exports` map is out of scope -- such a specifier simply stays unresolved.
 * Nothing here throws: a file that cannot be read or parsed is recorded on
 * the chain, and the chain is marked incomplete.
 */
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readJsoncFile } from "../jsonc.js";

interface ChainFile {
  /** Absolute path. */
  abs: string;
  /** Path relative to the project root, forward slashes. */
  rel: string;
  /** Why the file could not be used, or `undefined` when it parsed. */
  error: string | undefined;
  /** This file's own `compilerOptions`, unmerged. */
  options: Record<string, unknown>;
}

export interface ChainLink {
  /** The file (project-relative) holding the `extends`. */
  from: string;
  specifier: string;
  kind: "relative" | "package";
  resolved: boolean;
  /** Absolute path a relative specifier points at; what a missing-file message names. */
  attempted: string;
}

export interface TsconfigChain {
  /** The entry file, project-relative. */
  entry: string;
  /** Effective `compilerOptions` after folding the whole chain. */
  options: Record<string, unknown>;
  /** False if any file in the chain existed but failed to parse. */
  parsed: boolean;
  /** False if any file failed to parse or any `extends` could not be followed. */
  complete: boolean;
  /** Every file visited, entry first (child-first), each once. */
  files: ChainFile[];
  links: ChainLink[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The `extends` value as a list: a string, or TypeScript 5.0+'s array form. */
function extendsList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

interface Resolution {
  kind: "relative" | "package";
  abs: string | undefined;
  attempted: string;
}

function resolveExtends(specifier: string, fromAbs: string): Resolution {
  const candidates = (base: string): string[] => [
    base,
    `${base}.json`,
    join(base, "tsconfig.json"),
  ];
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const base = resolve(dirname(fromAbs), specifier);
    return {
      kind: "relative",
      abs: candidates(base).find(isFile),
      attempted: base.endsWith(".json") ? base : `${base}.json`,
    };
  }
  let dir = dirname(fromAbs);
  for (;;) {
    const base = join(dir, "node_modules", specifier);
    const abs = candidates(base).find(isFile);
    if (abs !== undefined) return { kind: "package", abs, attempted: base };
    const parent = dirname(dir);
    if (parent === dir)
      return { kind: "package", abs: undefined, attempted: base };
    dir = parent;
  }
}

/** Loads `entry` (project-relative) under `root` and folds its `extends` chain. */
export function loadTsconfigChain(root: string, entry: string): TsconfigChain {
  const files: ChainFile[] = [];
  const links: ChainLink[] = [];
  let parsed = true;
  let complete = true;

  const visit = (abs: string, stack: string[]): Record<string, unknown> => {
    if (stack.includes(abs)) return {};
    const read = readJsoncFile(abs);
    const usable = read.ok && isRecord(read.value);
    const value = read.ok && isRecord(read.value) ? read.value : undefined;
    const own =
      value !== undefined && isRecord(value["compilerOptions"])
        ? value["compilerOptions"]
        : {};
    if (!files.some((file) => file.abs === abs)) {
      files.push({
        abs,
        rel: relative(root, abs).split("\\").join("/"),
        error: usable
          ? undefined
          : read.ok
            ? "top level is not an object"
            : read.error,
        options: own,
      });
    }
    if (value === undefined) {
      parsed = false;
      complete = false;
      return {};
    }

    let merged: Record<string, unknown> = {};
    const from = relative(root, abs).split("\\").join("/");
    for (const specifier of extendsList(value["extends"])) {
      const target = resolveExtends(specifier, abs);
      if (!links.some((l) => l.from === from && l.specifier === specifier)) {
        links.push({
          from,
          specifier,
          kind: target.kind,
          resolved: target.abs !== undefined,
          attempted: target.attempted,
        });
      }
      if (target.abs === undefined) {
        complete = false;
        continue;
      }
      merged = { ...merged, ...visit(target.abs, [...stack, abs]) };
    }
    return { ...merged, ...own };
  };

  const options = visit(join(root, entry), []);
  return { entry, options, parsed, complete, files, links };
}
