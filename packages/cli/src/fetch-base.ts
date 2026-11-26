// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--fetch-base`: the one network step of `--check-update` and `--update`.
 * Rebuilds a published release's templates from `npm pack` of
 * `@monte3l/groundwork` at that exact version, read in memory, so a base the project only
 * knows by hash can be compared by content. Opt-in, and only ever for the
 * release the base resolution named.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import { readTemplateTarball } from "./tarball.js";
import type { FileSource } from "./theirs-tree.js";
import { CliUsageError } from "./usage.js";

/**
 * What an `npm` run reports: its exit status (`null` when killed), the
 * signal that killed it (when one did), its output, and the spawn failure
 * (npm missing, a timeout) when there is one.
 *
 * @example
 * ```ts
 * const result: NpmResult = { status: 0, stdout: "[]", stderr: "" };
 * ```
 */
interface NpmResult {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

/**
 * Runs `npm` with `args` in `cwd` and reports how it went; never throws for
 * a failed run.
 *
 * @example
 * ```ts
 * const runNpm: RunNpm = () => ({ status: 1, stdout: "", stderr: "offline" });
 * ```
 */
export type RunNpm = (args: readonly string[], cwd: string) => NpmResult;

/**
 * A release's templates, rebuilt from its npm tarball: `core` keyed by
 * project path (dotfile names restored), and each pack's `files/` keyed the
 * same way. Bytes are as published, tokens unapplied.
 *
 * @example
 * ```ts
 * const base: FetchedBase = { version: "1.0.0", core: new Map(), packs: new Map() };
 * ```
 */
export interface FetchedBase {
  readonly version: string;
  readonly core: ReadonlyMap<string, Uint8Array>;
  readonly packs: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
}

const PACKAGE = "@monte3l/groundwork";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** How long `npm pack` may take before it is abandoned. */
const NPM_TIMEOUT_MS = 120_000;
/** The most stdout or stderr bytes captured from `npm pack` (16 MiB). */
const NPM_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PACK_FILES = /^packs\/([^/]+)\/files\/(.+)$/;

/**
 * The default {@link RunNpm}: `npm` spawned directly (no shell), in `cwd`,
 * output captured, bounded by a timeout.
 */
const spawnNpm: RunNpm = (args, cwd) => {
  const result = spawnSync("npm", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: NPM_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A usage error that says how to carry on without the fetch. */
function fetchFailure(
  version: string,
  detail: string,
  cause?: unknown,
): CliUsageError {
  return new CliUsageError(
    `--fetch-base could not fetch ${PACKAGE}@${version} from npm: ${detail} -- re-run without --fetch-base (files whose base is known only by hash are then left for review), or with --base-version <x.y.z> if the project was installed from another release`,
    cause === undefined ? undefined : { cause },
  );
}

/** The tarball file name `npm pack --json` reported, as a bare file name. */
function packedFileName(version: string, stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw fetchFailure(version, "npm pack printed no JSON", cause);
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const filename: unknown =
    typeof first === "object" && first !== null && "filename" in first
      ? first.filename
      : undefined;
  if (typeof filename !== "string") {
    throw fetchFailure(version, "npm pack reported no tarball");
  }
  if (
    filename === "" ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw fetchFailure(
      version,
      `npm pack reported an unexpected tarball name ${JSON.stringify(filename)}`,
    );
  }
  return filename;
}

/** Sorts the tarball's template files into core and per-pack maps. */
function splitTemplates(
  version: string,
  files: ReadonlyMap<string, Uint8Array>,
): FetchedBase {
  const core = new Map<string, Uint8Array>();
  const packs = new Map<string, Map<string, Uint8Array>>();
  for (const [key, bytes] of files) {
    if (key.startsWith("core/")) {
      core.set(restoreDotfilePath(key.slice("core/".length)), bytes);
      continue;
    }
    const match = PACK_FILES.exec(key);
    const [, name, rest] = match ?? [];
    if (name === undefined || rest === undefined) continue;
    const pack = packs.get(name) ?? new Map<string, Uint8Array>();
    pack.set(restoreDotfilePath(rest), bytes);
    packs.set(name, pack);
  }
  if (core.size === 0) {
    throw fetchFailure(version, "its tarball holds no templates/core files");
  }
  return { version, core, packs };
}

/** Runs `npm pack` into `dir` and returns the tarball's bytes. */
function packInto(version: string, dir: string, runNpm: RunNpm): Uint8Array {
  const destination = join(dir, "pack");
  // npm pack does not create its --pack-destination; it fails ENOENT.
  mkdirSync(destination);
  const result = runNpm(
    [
      "pack",
      `${PACKAGE}@${version}`,
      "--pack-destination",
      destination,
      "--json",
      "--ignore-scripts",
    ],
    dir,
  );
  if (result.error !== undefined) {
    throw fetchFailure(
      version,
      `npm could not be run (${result.error.message}); --fetch-base needs npm on PATH and network access`,
      result.error,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim().split("\n").slice(-3).join("; ");
    const how =
      result.status === null && result.signal != null
        ? `was killed by ${result.signal}`
        : `exited with ${String(result.status)}`;
    throw fetchFailure(
      version,
      `npm pack ${how}${stderr === "" ? "" : ` (${stderr})`}`,
    );
  }
  const filename = packedFileName(version, result.stdout);
  try {
    return readFileSync(join(destination, filename));
  } catch (cause) {
    throw fetchFailure(
      version,
      `the tarball npm reported (${filename}) could not be read (${messageOf(cause)})`,
      cause,
    );
  }
}

/** A fresh temporary directory, its creation failure a usage error. */
function makeTempDir(version: string): string {
  try {
    return mkdtempSync(join(tmpdir(), "m3l-groundwork-fetch-"));
  } catch (cause) {
    throw fetchFailure(
      version,
      `no temporary directory could be created (${messageOf(cause)})`,
      cause,
    );
  }
}

/** Removes `dir`; a failure only warns, naming the leftover directory. */
function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (cause) {
    // Best effort: a leftover directory in the system temp directory never
    // replaces the fetch's own outcome, but the owner is told where it is.
    console.warn(
      `--fetch-base could not remove its temporary directory ${dir} (${messageOf(cause)}); delete it by hand`,
    );
  }
}

/**
 * Fetches `version`'s templates with `npm pack --ignore-scripts` of
 * `@monte3l/groundwork` at `version` (through `runNpm`, default: `npm` spawned with no shell)
 * into a fresh temporary directory, which is also npm's working directory so
 * no project `.npmrc` applies, and reads the tarball in memory. The user's
 * `~/.npmrc`, the global npmrc and `npm_config_*` environment variables
 * still apply (registry, proxy, auth). The temporary directory is always
 * removed; if that fails, a warning names it and the fetch's outcome stands.
 * Nothing else is written. On Windows `npm` is `npm.cmd`, which a shell-less
 * spawn does not resolve, so the fetch fails with the "needs npm on PATH"
 * message there.
 *
 * @throws `CliUsageError` (exit 2), naming `--fetch-base` and
 * `--base-version`, when `version` is not a plain `x.y.z` (before npm runs),
 * no temporary directory can be created, npm cannot be run, fails or is
 * killed, its output names no readable tarball, or the
 * tarball is corrupt, hostile or holds no core templates.
 *
 * @example
 * ```ts
 * import { fetchBase, fetchedBaseFile } from "./fetch-base.js";
 *
 * const base = fetchBase({ version: "1.0.0" });
 * const bytes = fetchedBaseFile(base, "core", ".gitignore");
 * ```
 */
export function fetchBase(options: {
  readonly version: string;
  readonly runNpm?: RunNpm | undefined;
}): FetchedBase {
  const { version } = options;
  if (!VERSION_PATTERN.test(version)) {
    throw new CliUsageError(
      `--fetch-base needs a plain release version x.y.z, not ${JSON.stringify(version)} -- pass --base-version <x.y.z>, or re-run without --fetch-base`,
    );
  }
  const dir = makeTempDir(version);
  try {
    const tgz = packInto(version, dir, options.runNpm ?? spawnNpm);
    let files: ReadonlyMap<string, Uint8Array>;
    try {
      files = readTemplateTarball(tgz);
    } catch (cause) {
      throw fetchFailure(
        version,
        `its tarball could not be read (${messageOf(cause)})`,
        cause,
      );
    }
    return splitTemplates(version, files);
  } finally {
    removeTempDir(dir);
  }
}

/**
 * The fetched bytes of the file `path` (a project path) from `source`:
 * `core` looks in the core templates, `pack:<name>` in that pack's
 * `files/`; `skill`, an unknown pack or an unknown path is `undefined`.
 *
 * @example
 * ```ts
 * import { fetchBase, fetchedBaseFile } from "./fetch-base.js";
 *
 * const base = fetchBase({ version: "1.0.0" });
 * fetchedBaseFile(base, "pack:quality", ".npmrc");
 * ```
 */
export function fetchedBaseFile(
  base: FetchedBase,
  source: FileSource,
  path: string,
): Uint8Array | undefined {
  if (source === "core") return base.core.get(path);
  if (source.startsWith("pack:")) {
    return base.packs.get(source.slice("pack:".length))?.get(path);
  }
  return undefined;
}
