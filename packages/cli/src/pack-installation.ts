// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Read-only per-project pack installation status, behind
 * `m3l-groundwork --list-packs <dir>`. It classifies how the project came to
 * be (adopted, an interrupted adopt, bootstrapped, or unknown), reads the
 * optional `.groundwork/installed-packs.json` ledger, and compares each pack's
 * files and wiring against the project. Nothing here writes anything.
 *
 * Every project file is external data: a file that is missing where it
 * matters, a symlink, reached through a symlinked directory below the
 * project root, unreadable or unparseable is recorded as a note in an
 * `undetermined` list, never thrown and never read as "absent". A pack the
 * notes could affect is reported `undetermined` rather than `not-installed`.
 * Notes and evidence name paths relative to the project root, with `/`
 * separators.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { planConflicts, templateRelPath } from "./conflicts.js";
import { parseJsonc } from "./jsonc.js";
import {
  MergeCollisionError,
  isPrototypeSensitiveKey,
  isRecord,
  jsonEqual,
  mergePackageScripts,
  mergeSettingsHooks,
  mergeSettingsTopLevel,
  mergeVerifySteps,
} from "./merge-json.js";
import type { SettingsHooksFragment } from "./merge-json.js";
import { listPackNames, loadPack } from "./packs.js";
import type { Pack } from "./packs.js";
import { errnoCode, isAbsentError } from "./survey/internal/read-guard.js";
import { loadTemplateHistory, packHashesAt } from "./template-history.js";
import type { TemplateHistory } from "./template-history.js";
import { resolveCliVersion } from "./inventory.js";
import { buildTokens, isNpmPackageName } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

/**
 * How a project came to be, as far as its files show.
 *
 * @example
 * ```ts
 * const origin: ProjectOrigin = { kind: "unknown", evidence: [] };
 * ```
 */
export type ProjectOrigin =
  | {
      readonly kind: "adopted";
      readonly evidence: readonly string[];
      readonly inventorySchemaVersion: number;
    }
  | { readonly kind: "interrupted-adopt"; readonly evidence: readonly string[] }
  | { readonly kind: "bootstrapped"; readonly evidence: readonly string[] }
  | { readonly kind: "unknown"; readonly evidence: readonly string[] };

/**
 * What the project's tree shows about one pack: which of its files are there
 * (`present` = identical, or identical up to token values; `modified` =
 * there but different) and whether its wiring is merged in.
 *
 * @example
 * ```ts
 * const facts: PackInstallFacts = {
 *   files: { present: ["REUSE.toml"], absent: [], modified: [] },
 *   wiring: "complete",
 * };
 * ```
 */
export interface PackInstallFacts {
  readonly files: {
    readonly present: readonly string[];
    readonly absent: readonly string[];
    readonly modified: readonly string[];
  };
  readonly wiring:
    "complete" | "partial" | "absent" | "not-applicable" | "unknown";
}

/**
 * A pack's installation verdict, with the facts behind it. `source` is
 * `ledger` when `.groundwork/installed-packs.json` lists the pack, otherwise
 * `detected` from the files and wiring.
 *
 * @example
 * ```ts
 * const status: PackInstallStatus = {
 *   status: "not-installed",
 *   source: "detected",
 *   files: { present: [], absent: ["REUSE.toml"], modified: [] },
 *   wiring: "absent",
 * };
 * ```
 */
export interface PackInstallStatus {
  readonly status:
    "not-installed" | "partial" | "installed" | "outdated" | "undetermined";
  readonly source: "ledger" | "detected";
  readonly files: PackInstallFacts["files"];
  readonly wiring: PackInstallFacts["wiring"];
}

type EntryKind =
  | { readonly kind: "file" | "directory" | "symlink" | "other" | "absent" }
  | { readonly kind: "unreadable"; readonly code: string }
  | { readonly kind: "behind-symlink"; readonly dir: string };

/**
 * What sits at `rel` (a `/`-separated path relative to `targetDir`), by
 * `lstat`, never following a symlink: any failure but absence is
 * `unreadable`, and a directory component between `targetDir` (exclusive)
 * and the entry that is a symlink makes it `behind-symlink` without the
 * entry itself being looked at. The one gate every project read in this
 * module goes through: nothing is read unless this answers `file`.
 * `targetDir` itself and its ancestors are not checked, and a component
 * swapped for a symlink after the check is not covered (the same residual
 * risk as adopt mode's guard).
 */
function projectEntry(targetDir: string, rel: string): EntryKind {
  const parts = rel.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    let isSymlink: boolean;
    let isDirectory: boolean;
    try {
      const stat = lstatSync(join(targetDir, ...parts.slice(0, depth)));
      isSymlink = stat.isSymbolicLink();
      isDirectory = stat.isDirectory();
    } catch {
      // A missing or uncheckable component: the entry's own lstat below
      // reports the same absence or errno, so nothing is lost here.
      break;
    }
    if (isSymlink) {
      return { kind: "behind-symlink", dir: parts.slice(0, depth).join("/") };
    }
    if (!isDirectory) break;
  }
  try {
    const stat = lstatSync(join(targetDir, ...parts));
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (stat.isFile()) return { kind: "file" };
    if (stat.isDirectory()) return { kind: "directory" };
    return { kind: "other" };
  } catch (error) {
    if (isAbsentError(error)) return { kind: "absent" };
    return { kind: "unreadable", code: errnoCode(error) ?? "unknown error" };
  }
}

function describeEntry(rel: string, entry: EntryKind): string {
  switch (entry.kind) {
    case "file":
      return `${rel} found`;
    case "directory":
      return `${rel} is a directory, not a file`;
    case "symlink":
      return `${rel} is a symlink -- not followed`;
    case "other":
      return `${rel} is not a regular file`;
    case "absent":
      return `${rel} is missing`;
    case "unreadable":
      return `${rel} could not be checked (${entry.code})`;
    case "behind-symlink":
      return `${rel} is behind a symlinked directory (${entry.dir}) -- not followed`;
    default: {
      const exhaustive: never = entry;
      throw new Error(`unhandled entry kind ${String(exhaustive)}`);
    }
  }
}

function recordOnce(notes: string[], note: string): void {
  if (!notes.includes(note)) notes.push(note);
}

interface ReadFailure {
  readonly ok: false;
  readonly reason: string;
}

type JsonRead = { readonly ok: true; readonly value: unknown } | ReadFailure;

/**
 * A project file's text, read only when {@link projectEntry} answers `file`
 * (never a symlink, never through a symlinked directory). Never throws:
 * every failure is a reason naming `rel` and at most an errno code.
 */
function readProjectFile(
  targetDir: string,
  rel: string,
): { readonly ok: true; readonly text: string } | ReadFailure {
  const entry = projectEntry(targetDir, rel);
  if (entry.kind !== "file") {
    return { ok: false, reason: describeEntry(rel, entry) };
  }
  try {
    return { ok: true, text: readFileSync(join(targetDir, rel), "utf8") };
  } catch (error) {
    return {
      ok: false,
      reason: `${rel} could not be read (${errnoCode(error) ?? "unknown error"})`,
    };
  }
}

/**
 * Reads and parses a JSON(C) project file through {@link readProjectFile}.
 * Never throws: every failure is a reason. The parser's own message is
 * dropped, since it can quote the file's content.
 */
function readJsonFile(targetDir: string, rel: string): JsonRead {
  const read = readProjectFile(targetDir, rel);
  if (!read.ok) return read;
  const parsed = parseJsonc(read.text);
  if (!parsed.ok) return { ok: false, reason: `${rel} is not valid JSON` };
  return { ok: true, value: parsed.value };
}

/** An own integer `schemaVersion` of a parsed record, read once. */
function schemaVersionOf(value: unknown): number | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, "schemaVersion")) {
    return undefined;
  }
  const version: unknown = value["schemaVersion"];
  return typeof version === "number" && Number.isInteger(version)
    ? version
    : undefined;
}

const BOOTSTRAP_MARKERS = [
  "bin/verify.mjs",
  "bin/lib/verify-steps.mjs",
  "bin/lib/verify-steps.packs.json",
  ".claude/settings.json",
] as const;

const GROUNDWORK = ".groundwork";

function isInterruptedAdoptEntry(name: string): boolean {
  return (
    name === "packs" ||
    name === "baseline" ||
    name === "adoption-report.md" ||
    name.startsWith(".packs-") ||
    name.startsWith(".baseline-")
  );
}

const ORIGIN_NOTE_TAIL = "project origin and pack wiring left undetermined";

/** Whether an entry the origin depends on could hide an adopt or a bootstrap. */
function hidesOrigin(entry: EntryKind): boolean {
  return (
    entry.kind === "symlink" ||
    entry.kind === "unreadable" ||
    entry.kind === "behind-symlink"
  );
}

interface OriginSurvey {
  readonly origin: ProjectOrigin;
  readonly notes: readonly string[];
  /**
   * The evidence lines a note restates, each mapped to the short pointer
   * that replaces it in {@link inspectPackInstallations}' report, so one
   * sentence is never printed twice.
   */
  readonly restated: ReadonlyMap<string, string>;
}

/**
 * {@link classifyProjectOrigin}, plus a note for every entry the
 * classification depends on that is a symlink, sits behind a symlinked
 * directory, or could not be checked or listed. Those entries may hide an
 * adopt or a bootstrap, so a caller must not read a pack as `not-installed`
 * while any note stands.
 */
function surveyProjectOrigin(targetDir: string): OriginSurvey {
  const evidence: string[] = [];
  const notes: string[] = [];
  const restated = new Map<string, string>();
  // Evidence that also becomes a note: the full sentence in both channels
  // here, and a pointer in place of the evidence line in the report.
  const addNoted = (rel: string, sentence: string): void => {
    evidence.push(sentence);
    notes.push(`${sentence} -- ${ORIGIN_NOTE_TAIL}`);
    restated.set(sentence, `${rel}: see the note below`);
  };
  const describe = (rel: string, entry: EntryKind): string => {
    const sentence = describeEntry(rel, entry);
    if (hidesOrigin(entry)) {
      notes.push(`${sentence} -- ${ORIGIN_NOTE_TAIL}`);
      restated.set(sentence, `${rel}: see the note below`);
    }
    return sentence;
  };
  const done = (origin: ProjectOrigin): OriginSurvey => ({
    origin,
    notes,
    restated,
  });

  const groundwork = projectEntry(targetDir, GROUNDWORK);
  if (groundwork.kind === "directory") {
    const inventoryRel = `${GROUNDWORK}/inventory.json`;
    const inventoryEntry = projectEntry(targetDir, inventoryRel);
    if (inventoryEntry.kind === "file") {
      const text = readProjectFile(targetDir, inventoryRel);
      if (!text.ok) {
        // A regular file this process cannot read may still be a valid
        // inventory, so it could hide an adopt like an uncheckable one.
        addNoted(inventoryRel, text.reason);
      } else {
        const parsed = parseJsonc(text.text);
        const version = parsed.ok ? schemaVersionOf(parsed.value) : undefined;
        if (version !== undefined) {
          evidence.push(
            `${inventoryRel} found (schemaVersion ${String(version)})`,
          );
          return done({
            kind: "adopted",
            evidence,
            inventorySchemaVersion: version,
          });
        }
        // The parser's own message is dropped: it can quote the content.
        evidence.push(
          parsed.ok
            ? `${inventoryRel} has no integer schemaVersion -- not a valid inventory`
            : `${inventoryRel} is not valid JSON`,
        );
      }
    } else {
      evidence.push(describe(inventoryRel, inventoryEntry));
    }

    let leftovers: string[] = [];
    try {
      leftovers = readdirSync(join(targetDir, GROUNDWORK))
        .filter(isInterruptedAdoptEntry)
        .sort();
    } catch (error) {
      addNoted(
        GROUNDWORK,
        `${GROUNDWORK} could not be listed (${errnoCode(error) ?? "unknown error"})`,
      );
    }
    if (leftovers.length > 0) {
      evidence.push(
        `${GROUNDWORK}/ holds ${leftovers.join(", ")} without a valid inventory.json -- an adopt run that did not complete`,
      );
      return done({ kind: "interrupted-adopt", evidence });
    }
  } else if (groundwork.kind === "file") {
    evidence.push(`${GROUNDWORK} is not a directory`);
  } else if (groundwork.kind !== "absent") {
    evidence.push(describe(GROUNDWORK, groundwork));
  }

  const found: string[] = [];
  const notFound: string[] = [];
  for (const marker of BOOTSTRAP_MARKERS) {
    const entry = projectEntry(targetDir, marker);
    if (entry.kind === "file") {
      found.push(marker);
    } else {
      notFound.push(describe(marker, entry));
    }
  }
  if (found.length > 0) evidence.push(`found ${found.join(", ")}`);
  evidence.push(...notFound);
  return done(
    notFound.length === 0
      ? { kind: "bootstrapped", evidence }
      : { kind: "unknown", evidence },
  );
}

/**
 * Classifies how `targetDir` came to be, from its files alone: `adopted`
 * when `.groundwork/inventory.json` is a regular file that parses to an
 * object with an integer `schemaVersion`; `interrupted-adopt` when it is
 * not, but `.groundwork/` holds an adopt run's leftovers (`packs/`,
 * `baseline/`, `adoption-report.md`, or a `.packs-*`/`.baseline-*` work
 * directory); `bootstrapped` when `bin/verify.mjs`,
 * `bin/lib/verify-steps.mjs`, `bin/lib/verify-steps.packs.json` and
 * `.claude/settings.json` are all regular files; otherwise `unknown`. The
 * first match in that order wins. An entry that is a symlink, or sits
 * behind a symlinked directory below `targetDir`, never counts and is never
 * read through. `evidence` lists what was observed, by paths relative to
 * `targetDir`. Reads only; never throws on the project's own files. A
 * symlinked or uncheckable entry shows only in `evidence` here;
 * {@link inspectPackInstallations} also turns it into an `undetermined` note.
 *
 * @example
 * ```ts
 * const origin = classifyProjectOrigin("/path/to/project");
 * console.log(`project: ${origin.kind} (${origin.evidence.join("; ")})`);
 * ```
 */
export function classifyProjectOrigin(targetDir: string): ProjectOrigin {
  return surveyProjectOrigin(targetDir).origin;
}

/** Splits a template into its literal pieces around the `__KEY__` markers. */
function splitOnMarkers(
  template: string,
  markers: readonly string[],
): string[] {
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    let nextIndex = -1;
    let nextMarker = "";
    for (const marker of markers) {
      const index = template.indexOf(marker, cursor);
      if (index === -1) continue;
      if (
        nextIndex === -1 ||
        index < nextIndex ||
        (index === nextIndex && marker.length > nextMarker.length)
      ) {
        nextIndex = index;
        nextMarker = marker;
      }
    }
    if (nextIndex === -1) break;
    pieces.push(template.slice(cursor, nextIndex));
    cursor = nextIndex + nextMarker.length;
  }
  pieces.push(template.slice(cursor));
  return pieces;
}

function isValidSlot(slot: string): boolean {
  return slot.length > 0 && !slot.includes("\n");
}

/**
 * Whether `actual` is `template` with each `__KEY__` marker (for a key in
 * `tokenKeys`) replaced by some non-empty, newline-free value -- so a file
 * emitted under a different project name or year still matches, while any
 * change to the text outside the markers does not. The literal pieces
 * between markers are located with `indexOf`, in order (the first anchored
 * at the start, the last at the end); no regular expression is built from
 * template text. A template with no markers is plain equality. Text
 * adjacent to a slot is indistinguishable from the slot's value, so an
 * insertion right next to a marker still matches.
 *
 * @example
 * ```ts
 * matchesTokenizedTemplate("name: __PROJECT_NAME__\n", "name: other\n", ["PROJECT_NAME"]); // true
 * matchesTokenizedTemplate("a __YEAR__ b", "a 1 c", ["YEAR"]); // false
 * ```
 */
export function matchesTokenizedTemplate(
  template: string,
  actual: string,
  tokenKeys: readonly string[],
): boolean {
  const markers = tokenKeys.map((key) => `__${key}__`);
  const pieces = splitOnMarkers(template, markers);
  const first = pieces[0] ?? "";
  if (pieces.length === 1) return template === actual;
  if (!actual.startsWith(first)) return false;

  let position = first.length;
  for (let index = 1; index < pieces.length; index++) {
    const piece = pieces[index] ?? "";
    if (index === pieces.length - 1) {
      const end = actual.length - piece.length;
      return (
        end > position &&
        actual.endsWith(piece) &&
        isValidSlot(actual.slice(position, end))
      );
    }
    const found = actual.indexOf(piece, position + 1);
    if (found === -1 || !isValidSlot(actual.slice(position, found))) {
      return false;
    }
    position = found + piece.length;
  }
  return false;
}

const LEDGER_SCHEMA_VERSION = 1;

/**
 * One `.groundwork/installed-packs.json` entry as read: the pack `name`, plus
 * the CLI version that installed it (`cliVersion`) and the sha256 of the
 * `pack.json` it staged (`manifestSha256`) when the entry records them as
 * strings.
 *
 * @example
 * ```ts
 * const entry: LedgerEntry = { name: "quality", cliVersion: "1.4.0" };
 * ```
 */
export interface LedgerEntry {
  readonly name: string;
  readonly cliVersion?: string | undefined;
  readonly manifestSha256?: string | undefined;
}

const LEDGER_SHA256 = /^[0-9a-f]{64}$/;

/**
 * `entry[key]` when it is an own string property (for `manifestSha256`, a
 * lowercase 64-hex sha256), else nothing.
 */
function optionalString(
  entry: Record<string, unknown>,
  key: "cliVersion" | "manifestSha256",
): { readonly [K in typeof key]?: string } {
  const value: unknown = Object.hasOwn(entry, key) ? entry[key] : undefined;
  if (typeof value !== "string") return {};
  if (key === "manifestSha256" && !LEDGER_SHA256.test(value)) return {};
  return { [key]: value };
}

/**
 * Reads the packs `.groundwork/installed-packs.json` records
 * (`{ schemaVersion: 1, packs: [{ name, cliVersion?, manifestSha256?, ... }] }`):
 * `names` in order, without duplicates, and `entries` in step with them (the
 * first entry for a name wins). A missing file is an empty ledger with no
 * notes. A symlinked or non-regular file, one behind a symlinked
 * `.groundwork/`, malformed JSON, a non-object, or a missing, wrong or future
 * `schemaVersion` skips the whole file with a note; an entry whose `name` is
 * not a string, or is `__proto__`/`constructor`/`prototype`, is skipped with
 * a note while the rest are kept. A `cliVersion` that is not a string, or a
 * `manifestSha256` that is not a lowercase 64-hex sha256, is dropped
 * silently, keeping the entry. Notes name the path
 * relative to `targetDir`. Never throws.
 *
 * @example
 * ```ts
 * const ledger = readInstalledPacksLedger("/path/to/project");
 * if (ledger.names.includes("quality")) console.log("quality: installed (ledger)");
 * ```
 */
export function readInstalledPacksLedger(targetDir: string): {
  names: string[];
  entries: LedgerEntry[];
  undetermined: string[];
} {
  const rel = `${GROUNDWORK}/installed-packs.json`;
  const undetermined: string[] = [];
  if (projectEntry(targetDir, rel).kind === "absent") {
    return { names: [], entries: [], undetermined };
  }

  const read = readJsonFile(targetDir, rel);
  if (!read.ok) {
    undetermined.push(
      `${read.reason} -- the installed-packs ledger was ignored`,
    );
    return { names: [], entries: [], undetermined };
  }
  const ledger = read.value;
  if (schemaVersionOf(ledger) !== LEDGER_SCHEMA_VERSION || !isRecord(ledger)) {
    undetermined.push(
      `${rel} is not a schemaVersion ${String(LEDGER_SCHEMA_VERSION)} ledger object -- ignored`,
    );
    return { names: [], entries: [], undetermined };
  }
  const packs: unknown = Object.hasOwn(ledger, "packs")
    ? ledger["packs"]
    : undefined;
  if (!Array.isArray(packs)) {
    undetermined.push(`${rel} has no packs array -- ignored`);
    return { names: [], entries: [], undetermined };
  }

  const names: string[] = [];
  const entries: LedgerEntry[] = [];
  let skipped = 0;
  for (const entry of packs as unknown[]) {
    const name: unknown =
      isRecord(entry) && Object.hasOwn(entry, "name")
        ? entry["name"]
        : undefined;
    if (
      !isRecord(entry) ||
      typeof name !== "string" ||
      isPrototypeSensitiveKey(name)
    ) {
      skipped++;
      continue;
    }
    if (names.includes(name)) continue;
    names.push(name);
    entries.push({
      name,
      ...optionalString(entry, "cliVersion"),
      ...optionalString(entry, "manifestSha256"),
    });
  }
  if (skipped > 0) {
    undetermined.push(
      `${rel}: ${String(skipped)} entr${skipped === 1 ? "y" : "ies"} without a usable pack name skipped`,
    );
  }
  return { names, entries, undetermined };
}

/**
 * The hashes of a pack as the running CLI ships it: `manifestSha256` of the
 * `pack.json` bytes staging writes (`JSON.stringify(manifest, null, 2)` plus
 * a newline), and each template file's raw bytes by project path.
 *
 * @example
 * ```ts
 * const current: CurrentPackHashes = { manifestSha256: "ab12...", files: { "REUSE.toml": "cd34..." } };
 * ```
 */
export interface CurrentPackHashes {
  readonly manifestSha256: string;
  readonly files: Readonly<Record<string, string>>;
}

const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** `a` minus `b` as plain `x.y.z` versions, or `undefined` when either is not one. */
function compareVersions(a: string, b: string): number | undefined {
  const left = PLAIN_VERSION.exec(a);
  const right = PLAIN_VERSION.exec(b);
  if (left === null || right === null) return undefined;
  for (let index = 1; index <= 3; index++) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The hash a history manifest compares by. The history hashes the raw
 * `pack.json` blob, while staging (and so the ledger and
 * {@link CurrentPackHashes}) hashes the re-serialized manifest; the
 * shipped `pack.json` files are not byte-identical to that form. So when the
 * history holds the blob's text, its canonical form is hashed instead. A
 * missing blob gives no verdict (`missing`): the raw-blob hash never equals
 * the canonical one, so comparing it would call every pack outdated. An
 * unparseable blob gives no verdict either, with a `reason` for the caller.
 */
function comparableManifestHash(
  history: TemplateHistory,
  recorded: string,
):
  | { readonly kind: "hash"; readonly hash: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unparsable"; readonly reason: string } {
  const blob = Object.hasOwn(history.blobs, recorded)
    ? history.blobs[recorded]
    : undefined;
  if (blob === undefined) return { kind: "missing" };
  try {
    const parsed: unknown = JSON.parse(blob);
    return {
      kind: "hash",
      hash: sha256Hex(`${JSON.stringify(parsed, null, 2)}\n`),
    };
  } catch (error) {
    // A damaged blob is missing data: it must never make a pack outdated.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "unparsable",
      reason: `its recorded pack.json is not valid JSON (${detail})`,
    };
  }
}

function sameHashes(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

/**
 * Whether a ledger-listed pack was installed from an older CLI whose copy of
 * the pack differs from the running one's (`current`). Never true without an
 * `entry`, or unless both its `cliVersion` and `runningVersion` are plain
 * `x.y.z` with the ledger's numerically older. Then true when the ledger's
 * `manifestSha256` differs from the current one, or when `history` records
 * the pack at the ledger's version and its manifest hash, file set or any
 * file hash differs from `current`. Missing data (no hash, no history, a
 * version or pack the history lacks) never makes it true. Pure.
 *
 * @example
 * ```ts
 * const outdated = isPackOutdated(entry, current, history, resolveCliVersion());
 * ```
 */
export function isPackOutdated(
  entry: LedgerEntry | undefined,
  current: CurrentPackHashes,
  history: TemplateHistory | undefined,
  runningVersion: string,
): boolean {
  if (entry?.cliVersion === undefined) return false;
  const order = compareVersions(entry.cliVersion, runningVersion);
  if (order === undefined || order >= 0) return false;
  if (
    entry.manifestSha256 !== undefined &&
    entry.manifestSha256 !== current.manifestSha256
  ) {
    return true;
  }
  if (history === undefined) return false;
  const recorded = packHashesAt(history, entry.cliVersion, entry.name);
  if (recorded === undefined) return false;
  const manifest = comparableManifestHash(history, recorded.manifest);
  if (manifest.kind === "hash" && manifest.hash !== current.manifestSha256) {
    return true;
  }
  return !sameHashes(recorded.files, current.files);
}

/** Every template file under `root`, keyed by the project path it emits to. */
function templateSources(
  root: string,
  tokens: TokenTable,
): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const sourcePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath);
      } else {
        sources.set(templateRelPath(root, sourcePath, tokens), sourcePath);
      }
    }
  };
  walk(root);
  return sources;
}

/**
 * A regular project file's text, or `undefined` -- with a note naming the
 * relative path (and the errno, for a failed check or read) -- for a
 * symlink, a file behind a symlinked directory, anything that is not a
 * regular file, or a file that cannot be read. The caller reads `undefined`
 * as "modified": such a file cannot be shown to match.
 */
function readProjectText(
  targetDir: string,
  rel: string,
  undetermined: string[],
): string | undefined {
  const read = readProjectFile(targetDir, rel);
  if (read.ok) return read.text;
  recordOnce(undetermined, `${read.reason} -- compared as modified`);
  return undefined;
}

/** A platform-separated relative path as the `/`-separated form notes use. */
function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

/**
 * A `planConflicts` note with the absolute `targetDir` prefix removed, so it
 * names its path relative to the project like every other note here.
 */
function relativeNote(targetDir: string, note: string): string {
  return note.split(`${targetDir}${sep}`).join("").split(targetDir).join(".");
}

function collectFiles(
  targetDir: string,
  pack: Pack,
  tokens: TokenTable,
  undetermined: string[],
): PackInstallFacts["files"] {
  const present: string[] = [];
  const absent: string[] = [];
  const modified: string[] = [];
  let sources: Map<string, string> | undefined;
  const tokenKeys = Object.keys(tokens);

  const conflictNotes: string[] = [];
  const conflicts = planConflicts(
    pack.filesDir,
    targetDir,
    tokens,
    conflictNotes,
  );
  for (const note of conflictNotes) {
    recordOnce(undetermined, relativeNote(targetDir, note));
  }
  for (const conflict of conflicts) {
    switch (conflict.status) {
      case "identical":
        present.push(conflict.relPath);
        break;
      case "absent":
        absent.push(conflict.relPath);
        break;
      case "divergent": {
        // A key-level JSON comparison keeps planConflicts' verdict.
        if (conflict.keyDiffs !== undefined) {
          modified.push(conflict.relPath);
          break;
        }
        sources ??= templateSources(pack.filesDir, tokens);
        const source = sources.get(conflict.relPath);
        const actual = readProjectText(
          targetDir,
          toPosix(conflict.relPath),
          undetermined,
        );
        const matches =
          source !== undefined &&
          actual !== undefined &&
          matchesTokenizedTemplate(
            readFileSync(source, "utf8"),
            actual,
            tokenKeys,
          );
        (matches ? present : modified).push(conflict.relPath);
        break;
      }
      default: {
        const exhaustive: never = conflict.status;
        throw new Error(`unhandled conflict status ${String(exhaustive)}`);
      }
    }
  }
  return { present, absent, modified };
}

/** One wiring item's state in the project. */
type ItemVerdict = "present" | "absent" | "unreadable";

/**
 * Re-applies one wiring item's merge to `existing`: `present` when that
 * changes nothing, `absent` when it would change something or collides (a
 * {@link MergeCollisionError}: the project holds its own, different entry),
 * and `unreadable` for any other throw -- existing data of a shape the merge
 * cannot read, which says nothing about whether the item is there.
 */
function judgeItem(existing: unknown, merge: () => unknown): ItemVerdict {
  let merged: unknown;
  try {
    merged = merge();
  } catch (error) {
    return error instanceof MergeCollisionError ? "absent" : "unreadable";
  }
  return jsonEqual(merged, existing) ? "present" : "absent";
}

/**
 * Whether the `hooks` block of `settings` has the shape `mergeSettingsHooks`
 * reads for each of `events`: an object whose entry per event is an array of
 * objects, each with a `hooks` array of objects. A merge over any other shape
 * can quietly replace or misread it rather than throw, so it is checked first.
 */
function hasReadableHooks(
  settings: Record<string, unknown>,
  events: readonly string[],
): boolean {
  if (!Object.hasOwn(settings, "hooks")) return true;
  const hooks: unknown = settings["hooks"];
  if (!isRecord(hooks)) return false;
  return events.every((event) => {
    if (!Object.hasOwn(hooks, event)) return true;
    const entries: unknown = hooks[event];
    return (
      Array.isArray(entries) &&
      (entries as unknown[]).every((entry) => {
        if (!isRecord(entry) || !Object.hasOwn(entry, "hooks")) return false;
        const commands: unknown = entry["hooks"];
        return (
          Array.isArray(commands) && (commands as unknown[]).every(isRecord)
        );
      })
    );
  });
}

/**
 * Whether every entry of a `verify-steps.packs.json` array has the shape
 * `mergeVerifySteps` keys on: an object with an own string `id`.
 */
function hasReadableSteps(steps: readonly unknown[]): boolean {
  return steps.every((step) => {
    if (!isRecord(step) || !Object.hasOwn(step, "id")) return false;
    const id: unknown = step["id"];
    return typeof id === "string";
  });
}

/** One single-command fragment per hook command the pack registers. */
function hookItems(hooks: SettingsHooksFragment): SettingsHooksFragment[] {
  return Object.entries(hooks).flatMap(([event, entries]) =>
    entries.flatMap((entry) =>
      entry.hooks.map((command) => ({
        [event]: [{ ...entry, hooks: [command] }],
      })),
    ),
  );
}

/**
 * A `package.json`'s `scripts`: `undefined` when there is no own `scripts`
 * key (nothing merged yet), `null` when it is there but not a record of
 * strings -- a shape no merge can be judged against.
 */
function scriptsOf(
  pkg: Record<string, unknown>,
): Record<string, string> | undefined | null {
  if (!Object.hasOwn(pkg, "scripts")) return undefined;
  const scripts: unknown = pkg["scripts"];
  if (!isRecord(scripts)) return null;
  const entries = Object.entries(scripts);
  const strings = entries.filter(
    (pair): pair is [string, string] => typeof pair[1] === "string",
  );
  // fromEntries defines own keys, so a "__proto__" script name stays a key.
  return strings.length === entries.length ? Object.fromEntries(strings) : null;
}

function collectWiring(
  targetDir: string,
  pack: Pack,
  undetermined: string[],
): PackInstallFacts["wiring"] {
  const { wiring } = pack.manifest;
  const hooks = wiring.settings;
  const topLevel = wiring.settingsTopLevel ?? {};
  const hasHooks = Object.keys(hooks).length > 0;
  const hasTopLevel = Object.keys(topLevel).length > 0;
  const hasScripts = Object.keys(wiring.packageScripts).length > 0;
  const hasSteps = wiring.verifySteps.length > 0;
  if (!hasHooks && !hasTopLevel && !hasScripts && !hasSteps) {
    return "not-applicable";
  }

  const verdicts: ItemVerdict[] = [];
  let unknown = false;
  const readPart = (
    rel: string,
    accept: (value: unknown) => boolean,
    shape: string,
  ): unknown => {
    const read = readJsonFile(targetDir, rel);
    if (!read.ok) {
      recordOnce(
        undetermined,
        `${read.reason} -- pack wiring left undetermined`,
      );
      unknown = true;
      return undefined;
    }
    if (!accept(read.value)) {
      recordOnce(
        undetermined,
        `${rel} is not ${shape} -- pack wiring left undetermined`,
      );
      unknown = true;
      return undefined;
    }
    return read.value;
  };
  // A wiring file whose existing entries are of a shape the merges cannot
  // read: noted by path only, never its content or a parser message.
  const markUnreadable = (rel: string): void => {
    recordOnce(
      undetermined,
      `${rel} holds entries of an unexpected shape -- pack wiring left undetermined`,
    );
    unknown = true;
  };
  const judgeAll = (
    rel: string,
    existing: unknown,
    merges: readonly (() => unknown)[],
  ): void => {
    for (const merge of merges) {
      const verdict = judgeItem(existing, merge);
      if (verdict === "unreadable") markUnreadable(rel);
      verdicts.push(verdict);
    }
  };

  if (hasHooks || hasTopLevel) {
    const rel = ".claude/settings.json";
    const settings = readPart(rel, isRecord, "a JSON object");
    if (isRecord(settings)) {
      if (hasReadableHooks(settings, Object.keys(hooks))) {
        // mergeSettingsHooks matches only the first entry with the same
        // matcher (as installPack does), so a pack command in a later
        // same-matcher entry reads as not there.
        judgeAll(
          rel,
          settings,
          hookItems(hooks).map(
            (item) => () => mergeSettingsHooks(settings, item),
          ),
        );
      } else {
        markUnreadable(rel);
      }
      judgeAll(
        rel,
        settings,
        Object.entries(topLevel).map(
          ([key, value]) =>
            () =>
              mergeSettingsTopLevel(settings, { [key]: value }),
        ),
      );
    }
  }
  if (hasScripts) {
    const rel = "package.json";
    const pkg = readPart(rel, isRecord, "a JSON object");
    if (isRecord(pkg)) {
      const existing = scriptsOf(pkg);
      if (existing === null) {
        markUnreadable(rel);
      } else {
        judgeAll(
          rel,
          existing ?? {},
          Object.entries(wiring.packageScripts).map(([name, command]) => () => {
            const result = mergePackageScripts(existing, { [name]: command });
            // A collision: the project runs its own command under that name.
            return result.collisions.length > 0 ? undefined : result.scripts;
          }),
        );
      }
    }
  }
  if (hasSteps) {
    const rel = "bin/lib/verify-steps.packs.json";
    const steps = readPart(rel, Array.isArray, "a JSON array");
    if (Array.isArray(steps)) {
      if (hasReadableSteps(steps as unknown[])) {
        judgeAll(
          rel,
          steps,
          wiring.verifySteps.map(
            (step) => () => mergeVerifySteps(steps, [step]),
          ),
        );
      } else {
        markUnreadable(rel);
      }
    }
  }

  if (unknown) return "unknown";
  if (verdicts.every((verdict) => verdict === "present")) return "complete";
  return verdicts.includes("present") ? "partial" : "absent";
}

/**
 * Collects what `targetDir` shows about `pack`. Files: each file the pack
 * would emit is `present` (identical, or identical up to token values via
 * {@link matchesTokenizedTemplate}), `absent`, or `modified`; a key-level
 * JSON file keeps `planConflicts`' verdict. Wiring is judged only for a
 * `bootstrapped` origin (otherwise, or for a pack with no wiring,
 * `not-applicable`), item by item -- each hook command (per event and
 * matcher), top-level settings key, package script and verify step. An item
 * is there when re-applying just that item's pure merge changes nothing; a
 * collision (the project's own, different entry) counts as not there.
 * `complete` is every item there, `absent` none, `partial` some. A wiring
 * file (`.claude/settings.json`, `package.json`,
 * `bin/lib/verify-steps.packs.json`) that is missing, a symlink, behind a
 * symlinked directory, unreadable, not valid JSON or of the wrong top-level
 * type makes it `unknown`, never `absent`; so does one holding entries of a
 * shape the merges cannot judge -- a `hooks` block not shaped as
 * `mergeSettingsHooks` reads it, a `scripts` that is not a record of
 * strings, or a verify step that is not an object with a string `id`. Each
 * comes with a note in `undetermined` naming only the relative path. A
 * `package.json` with no `scripts` key at all is plain `absent`. A pack
 * file that is a symlink, behind a symlinked directory, or cannot be read
 * is `modified`, with a note naming the relative path (and errno). Reads
 * only.
 *
 * @throws The `SurveyReadError` {@link planConflicts} raises for an errno on
 * the project tree that is not a property of the project (`EIO`, `EMFILE`,
 * ...), and the raw `fs` error of a failed read of the pack's own template
 * files. Every other failure on the project's files is a note, never a throw.
 *
 * @example
 * ```ts
 * const undetermined: string[] = [];
 * const facts = collectPackInstallFacts(dir, loadPack("quality"), tokens, origin, undetermined);
 * ```
 */
export function collectPackInstallFacts(
  targetDir: string,
  pack: Pack,
  tokens: TokenTable,
  origin: ProjectOrigin,
  undetermined: string[],
): PackInstallFacts {
  const files = collectFiles(targetDir, pack, tokens, undetermined);
  const wiring =
    origin.kind === "bootstrapped"
      ? collectWiring(targetDir, pack, undetermined)
      : "not-applicable";
  return { files, wiring };
}

/**
 * The verdict for one pack, from its facts. A pack the ledger lists is
 * `installed` from the `ledger` -- or `outdated` when `outdated` is set
 * (see {@link isPackOutdated}); the flag means nothing for a pack the ledger
 * does not list. Otherwise, `detected`: wiring `unknown` is
 * always `undetermined`, and so is a pack with no files and no applicable
 * wiring, which cannot be detected at all. Every file absent and wiring
 * absent or not applicable is `not-installed` -- or `undetermined` while
 * `undetermined` holds any note. No file absent, wiring complete or not
 * applicable, and some positive evidence (at least one `present` file, or
 * complete wiring) is `installed`; a `modified` file still counts towards
 * it, but files that merely sit at the pack's paths without matching are
 * not evidence on their own. Anything else is `partial`. Pure; independent
 * of the order of the file arrays.
 *
 * @example
 * ```ts
 * const status = classifyPackInstallation(facts, ledger.names, "quality", undetermined);
 * ```
 */
export function classifyPackInstallation(
  facts: PackInstallFacts,
  ledgerNames: readonly string[],
  packName: string,
  undetermined: readonly string[],
  outdated = false,
): PackInstallStatus {
  const { files, wiring } = facts;
  if (ledgerNames.includes(packName)) {
    return {
      status: outdated ? "outdated" : "installed",
      source: "ledger",
      files,
      wiring,
    };
  }
  const fileCount =
    files.present.length + files.absent.length + files.modified.length;
  const noFileThere = files.present.length === 0 && files.modified.length === 0;
  let status: PackInstallStatus["status"];
  if (
    wiring === "unknown" ||
    (fileCount === 0 && wiring === "not-applicable")
  ) {
    status = "undetermined";
  } else if (
    noFileThere &&
    (wiring === "absent" || wiring === "not-applicable")
  ) {
    status = undetermined.length > 0 ? "undetermined" : "not-installed";
  } else if (
    files.absent.length === 0 &&
    (wiring === "complete" || wiring === "not-applicable") &&
    // Files merely at the pack's paths, none matching, are no evidence.
    (files.present.length > 0 || wiring === "complete")
  ) {
    status = "installed";
  } else {
    status = "partial";
  }
  return { status, source: "detected", files, wiring };
}

/**
 * The `__PROJECT_NAME__` value a project was most likely emitted with: its
 * `package.json` `name` when that is a regular file (never read through a
 * symlink) holding a valid package name ({@link isNpmPackageName}), else the
 * basename of `targetDir`. Never throws on the project's files.
 *
 * @example
 * ```ts
 * const tokens = buildTokens(projectNameOf("/work/app")); // package.json's name, or "app"
 * ```
 */
export function projectNameOf(targetDir: string): string {
  const read = readJsonFile(targetDir, "package.json");
  if (read.ok && isRecord(read.value) && Object.hasOwn(read.value, "name")) {
    const name: unknown = read.value["name"];
    if (typeof name === "string" && isNpmPackageName(name)) return name;
  }
  return basename(targetDir);
}

/**
 * The word each {@link PackInstallStatus} `status` prints as, shared by
 * `--list-packs <dir>` and `--add-pack` so both say the same thing.
 *
 * @example
 * ```ts
 * console.log(`[${PACK_STATUS_LABELS["not-installed"]}]`); // "[not installed]"
 * ```
 */
export const PACK_STATUS_LABELS: Readonly<
  Record<PackInstallStatus["status"], string>
> = {
  installed: "installed",
  partial: "partial",
  "not-installed": "not installed",
  undetermined: "undetermined",
  outdated: "outdated",
};

/**
 * One pack's entry in a {@link PackInstallationReport}.
 *
 * @example
 * ```ts
 * const line = `${entry.name} (modes: ${entry.modes.join(", ")}) [${entry.status.status}]`;
 * ```
 */
interface PackInstallationEntry {
  readonly name: string;
  readonly modes: readonly string[];
  readonly description: string;
  readonly status: PackInstallStatus;
  /** The ledger's `cliVersion` for the pack, set only when `status` is `outdated`. */
  readonly ledgerVersion?: string;
}

/**
 * The result of {@link inspectPackInstallations}.
 *
 * @example
 * ```ts
 * const report: PackInstallationReport = inspectPackInstallations(dir);
 * for (const note of report.undetermined) console.log(`note: ${note}`);
 * ```
 */
export interface PackInstallationReport {
  readonly origin: ProjectOrigin;
  readonly packs: readonly PackInstallationEntry[];
  readonly undetermined: readonly string[];
}

/**
 * `pack` as the running CLI ships it, hashed the way the ledger and the
 * history are: the manifest as staging serializes it, and each template
 * file's raw bytes keyed by its untokenized project path. Throws the raw
 * `fs` error of a failed read of the CLI's own templates.
 */
function currentPackHashes(pack: Pack): CurrentPackHashes {
  const files = [...templateSources(pack.filesDir, {})].map(
    ([path, source]) =>
      [toPosix(path), sha256Hex(readFileSync(source))] as const,
  );
  return {
    manifestSha256: sha256Hex(`${JSON.stringify(pack.manifest, null, 2)}\n`),
    files: Object.fromEntries(files),
  };
}

/**
 * Optional overrides for {@link inspectPackInstallations}'s outdated check:
 * the loaded template history (default: {@link loadTemplateHistory}) and the
 * running CLI version (default: {@link resolveCliVersion}).
 *
 * @example
 * ```ts
 * const deps: OutdatedCheckDeps = { history: { note: "history unavailable" }, runningVersion: "1.5.0" };
 * ```
 */
export interface OutdatedCheckDeps {
  readonly history?: { history: TemplateHistory } | { note: string };
  readonly runningVersion?: string;
}

const LEDGER_PATH = `${GROUNDWORK}/installed-packs.json`;

/**
 * Which ledger-listed packs in `collected` are outdated, and the notes for
 * each ledger pack the check could not decide: a ledger `cliVersion` or a
 * running version that is not a plain `x.y.z` (the latter once), a ledger
 * version the history does not record, an unparsable recorded manifest, or
 * a history that could not be loaded. The history is loaded only when an
 * entry's `cliVersion` is a plain version older than the running CLI's, so a
 * project with a current ledger never depends on it.
 */
function findOutdated(
  entries: readonly LedgerEntry[],
  collected: readonly { readonly name: string; readonly pack: Pack }[],
  deps: OutdatedCheckDeps,
): { outdated: Map<string, string>; notes: string[] } {
  const running = deps.runningVersion ?? resolveCliVersion();
  const outdated = new Map<string, string>();
  const notes: string[] = [];
  const listed = collected.flatMap(({ name, pack }) => {
    const entry = entries.find((candidate) => candidate.name === name);
    return entry?.cliVersion === undefined
      ? []
      : [{ name, pack, entry, cliVersion: entry.cliVersion }];
  });
  if (listed.length === 0) return { outdated, notes };
  if (!PLAIN_VERSION.test(running)) {
    notes.push(
      `the running CLI version ${JSON.stringify(running)} is not a plain x.y.z version -- outdated packs in ${LEDGER_PATH} cannot be detected`,
    );
    return { outdated, notes };
  }
  const stale = listed.filter(({ name, cliVersion }) => {
    const order = compareVersions(cliVersion, running);
    if (order === undefined) {
      notes.push(
        `${LEDGER_PATH}: pack "${name}" has cliVersion ${JSON.stringify(cliVersion)}, not a plain x.y.z version -- whether it is outdated is unknown`,
      );
    }
    return order !== undefined && order < 0;
  });
  if (stale.length === 0) return { outdated, notes };
  const loaded = deps.history ?? loadTemplateHistory();
  if ("note" in loaded) {
    notes.push(loaded.note);
    return { outdated, notes };
  }
  const { history } = loaded;
  for (const { name, pack, entry, cliVersion } of stale) {
    if (!Object.hasOwn(history.versions, cliVersion)) {
      notes.push(
        `${LEDGER_PATH}: pack "${name}" was installed by CLI ${cliVersion}, which the template history does not record -- whether it is outdated is unknown`,
      );
    } else {
      const recorded = packHashesAt(history, cliVersion, name);
      const manifest =
        recorded === undefined
          ? undefined
          : comparableManifestHash(history, recorded.manifest);
      if (manifest?.kind === "unparsable") {
        notes.push(
          `${LEDGER_PATH}: pack "${name}" at CLI ${cliVersion}: ${manifest.reason} -- its manifest was not compared`,
        );
      }
    }
    if (isPackOutdated(entry, currentPackHashes(pack), history, running)) {
      outdated.set(name, cliVersion);
    }
  }
  return { outdated, notes };
}

/**
 * Reports every pack's installation status in `targetDir` (or only the
 * packs named in `packNames`), read-only: the project's origin, then each
 * pack's verdict from the ledger or from its files and wiring. Tokens are
 * `PROJECT_NAME` (the project's `package.json` `name` when it is a valid
 * package name, else the directory's basename) and the current `YEAR`;
 * token-bearing files match whatever values they were emitted with anyway.
 * Every pack's facts are collected before any verdict, and every verdict
 * sees every note -- the origin's (a bootstrap marker, `.groundwork/` or
 * its `inventory.json` that is a symlink, behind a symlinked directory or
 * cannot be checked, or a `.groundwork/` that cannot be listed: each could
 * hide how the project came to be), the ledger's and each pack's -- so while
 * anything in the project could not be read, no pack is reported
 * `not-installed`. Nothing is read through a symlink or a symlinked
 * directory below `targetDir`. `undetermined` is every note, each naming a
 * path relative to `targetDir` and at most an errno code, never file
 * content. An origin evidence line a note restates is replaced in the
 * report's `origin.evidence` by a short pointer to that note, so no sentence
 * appears twice; {@link classifyProjectOrigin} keeps the full line.
 *
 * `deps` overrides the template history and the running CLI version the
 * outdated check uses ({@link OutdatedCheckDeps}). When that check cannot
 * decide for a ledger-listed pack (a ledger or running version that is not
 * a plain `x.y.z`, a ledger version the history does not record, an
 * unparsable recorded manifest, or a history that cannot be loaded), a note
 * says so; such a note never turns a pack `undetermined`.
 *
 * @throws The `Error` `loadPack` raises for an unknown or malformed pack
 * name -- a caller error, not project data -- whatever
 * {@link collectPackInstallFacts} throws, and the raw `fs` error of a failed
 * read of the CLI's own pack templates while hashing a ledger pack for the
 * outdated check.
 *
 * @example
 * ```ts
 * const report = inspectPackInstallations("/path/to/project");
 * console.log(report.origin.kind, report.packs.map((p) => p.status.status));
 * ```
 */
export function inspectPackInstallations(
  targetDir: string,
  packNames?: readonly string[],
  deps: OutdatedCheckDeps = {},
): PackInstallationReport {
  const survey = surveyProjectOrigin(targetDir);
  const ledger = readInstalledPacksLedger(targetDir);
  const tokens = buildTokens(projectNameOf(targetDir));
  const undetermined: string[] = [...survey.notes, ...ledger.undetermined];

  // Two passes: every pack's facts first, so each verdict sees every note.
  const collected = (packNames ?? listPackNames()).map((name) => {
    const pack = loadPack(name);
    const facts = collectPackInstallFacts(
      targetDir,
      pack,
      tokens,
      survey.origin,
      undetermined,
    );
    return { name, pack, facts };
  });
  const { outdated, notes } = findOutdated(ledger.entries, collected, deps);
  const packs = collected.map(
    ({ name, pack, facts }): PackInstallationEntry => {
      const ledgerVersion = outdated.get(name);
      return {
        name,
        modes: pack.manifest.modes,
        description: pack.manifest.description,
        status: classifyPackInstallation(
          facts,
          ledger.names,
          name,
          undetermined,
          ledgerVersion !== undefined,
        ),
        ...(ledgerVersion !== undefined && { ledgerVersion }),
      };
    },
  );
  // After the verdicts: an undecided outdated check hides no installation,
  // only whether a ledger pack is outdated, so it must not turn a pack
  // undetermined.
  for (const note of notes) recordOnce(undetermined, note);
  const origin: ProjectOrigin = {
    ...survey.origin,
    evidence: survey.origin.evidence.map(
      (line) => survey.restated.get(line) ?? line,
    ),
  };
  return { origin, packs, undetermined };
}
