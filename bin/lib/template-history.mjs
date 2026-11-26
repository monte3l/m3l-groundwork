// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pure helpers behind `bin/build-template-history.mjs`: build the
 * template history (`packages/cli/data/template-history.json`, schema 1)
 * from a repository's stable release tags, serialize it deterministically,
 * and check a committed copy. The CLI reads the file through
 * `packages/cli/src/template-history.ts`; this module never runs on import.
 *
 * Shape: `{ schemaVersion: 1, versions: { "<x.y.z>": { core: { path: sha256 },
 * packs: { name: { manifest: sha256, files: { path: sha256 } } } } },
 * blobs: { sha256: text } }`. Every hash is the sha256 of the raw git blob
 * bytes; every path is the project path the file installs to (relative to
 * `templates/core/`, or to a pack's `files/`), with an escaped dotfile name
 * restored. `blobs` keeps full text only for the files a three-way merge
 * needs: any file carrying a `__TOKEN__`, every `pack.json`, and the
 * `package.json`, `tsconfig*.json`, `.claude/settings.json` and
 * `bin/lib/verify-steps.packs.json` templates.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_TAG_PREFIX = "@monte3l/groundwork@";
const SCHEMA_VERSION = 1;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const CORE_DIR = "templates/core/";
const PACKS_DIR = "templates/packs/";
const TOKEN = /__[A-Z_]+__/;

// Mirrors ESCAPED_NAMES in packages/cli/src/assets.ts (the source of truth):
// escaped (vendored) name -> real name. Keep the two in step.
const RESTORED_NAMES = new Map([
  ["_gitignore", ".gitignore"],
  ["_npmrc", ".npmrc"],
  ["_npmignore", ".npmignore"],
  ["_package-lock.json", "package-lock.json"],
]);

/**
 * Restores an escaped dotfile name in the final segment of a `/`- or
 * `\\`-separated relative path, as `restoreDotfilePath` in
 * `packages/cli/src/assets.ts` does.
 *
 * @example
 * restoreDotfilePath("tools/release/_package-lock.json"); // "tools/release/package-lock.json"
 */
export function restoreDotfilePath(relPath) {
  const cut = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const name = relPath.slice(cut + 1);
  return relPath.slice(0, cut + 1) + (RESTORED_NAMES.get(name) ?? name);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The stable `x.y.z` versions among `tags` that carry `tagPrefix`, stripped
 * of it; prereleases and foreign tags are dropped.
 *
 * @example
 * stableVersionsFromTags(["@monte3l/groundwork@1.0.0", "@monte3l/groundwork@1.1.0-rc.1"]); // ["1.0.0"]
 */
export function stableVersionsFromTags(tags, tagPrefix = DEFAULT_TAG_PREFIX) {
  return tags
    .filter((tag) => tag.startsWith(tagPrefix))
    .map((tag) => tag.slice(tagPrefix.length))
    .filter((version) => STABLE_VERSION.test(version));
}

function git(repoDir, args, input) {
  return execFileSync("git", args, {
    cwd: repoDir,
    input,
    maxBuffer: 1024 * 1024 * 1024,
  });
}

/** Every regular-file blob under the template dirs at `rev`: `{ path, oid }`. */
function listTemplateBlobs(repoDir, rev) {
  const out = git(repoDir, [
    "ls-tree",
    "-r",
    "-z",
    rev,
    "--",
    "templates/core",
    "templates/packs",
  ]).toString("utf8");
  const blobs = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    // Regular files only: a symlink or submodule is never a template file.
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    blobs.push({ path: record.slice(tab + 1), oid });
  }
  return blobs;
}

/** Reads every object in `oids` in one `git cat-file --batch`: oid -> Buffer. */
function readBlobs(repoDir, oids) {
  const contents = new Map();
  if (oids.length === 0) return contents;
  const out = git(repoDir, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  let cursor = 0;
  while (cursor < out.length) {
    const headerEnd = out.indexOf(0x0a, cursor);
    const [oid, type, size] = out
      .subarray(cursor, headerEnd)
      .toString("utf8")
      .split(" ");
    if (type !== "blob") {
      throw new Error(`git cat-file: ${oid} is not a blob (${type})`);
    }
    const start = headerEnd + 1;
    const end = start + Number(size);
    contents.set(oid, out.subarray(start, end));
    cursor = end + 1;
  }
  return contents;
}

/** Whether a template file's full text belongs in `blobs`. */
function keepsText(projectPath, text, isManifest) {
  if (isManifest || TOKEN.test(text)) return true;
  const name = projectPath.slice(projectPath.lastIndexOf("/") + 1);
  return (
    projectPath === "package.json" ||
    /^tsconfig.*\.json$/.test(name) ||
    projectPath === ".claude/settings.json" ||
    projectPath === "bin/lib/verify-steps.packs.json"
  );
}

/** Sorts `value`'s object keys at every level, with the default string sort. */
function sortDeep(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortDeep(value[key])]),
  );
}

/**
 * Builds the template history from `repoDir`'s stable release tags
 * (`<tagPrefix><x.y.z>`), reading each tag's `templates/core/` and
 * `templates/packs/<name>/` (`pack.json` and `files/`) from git objects --
 * never the working tree. A version with no packs records `packs: {}`.
 *
 * @example
 * const history = buildTemplateHistory({ repoDir: process.cwd() });
 * Object.keys(history.versions); // ["1.0.0", "1.0.1", ...]
 */
export function buildTemplateHistory({
  repoDir,
  tagPrefix = DEFAULT_TAG_PREFIX,
}) {
  const tags = git(repoDir, ["tag", "-l"])
    .toString("utf8")
    .split("\n")
    .filter((tag) => tag !== "");
  const versions = {};
  const blobs = {};
  for (const version of stableVersionsFromTags(tags, tagPrefix).sort()) {
    const entries = listTemplateBlobs(
      repoDir,
      `refs/tags/${tagPrefix}${version}`,
    );
    const contents = readBlobs(repoDir, [
      ...new Set(entries.map(({ oid }) => oid)),
    ]);
    const core = {};
    const packs = {};
    const packOf = (name) =>
      (packs[name] ??= { manifest: undefined, files: {} });
    for (const { path, oid } of entries) {
      const bytes = contents.get(oid);
      let projectPath;
      let isManifest = false;
      if (path.startsWith(CORE_DIR)) {
        projectPath = restoreDotfilePath(path.slice(CORE_DIR.length));
        core[projectPath] = sha256(bytes);
      } else {
        const [name, ...rest] = path.slice(PACKS_DIR.length).split("/");
        if (rest.length === 1 && rest[0] === "pack.json") {
          isManifest = true;
          projectPath = "pack.json";
          packOf(name).manifest = sha256(bytes);
        } else if (rest.length > 1 && rest[0] === "files") {
          projectPath = restoreDotfilePath(rest.slice(1).join("/"));
          packOf(name).files[projectPath] = sha256(bytes);
        } else {
          continue;
        }
      }
      const text = bytes.toString("utf8");
      if (keepsText(projectPath, text, isManifest)) {
        blobs[sha256(bytes)] = text;
      }
    }
    // A directory under templates/packs/ without a pack.json is not a pack.
    for (const [name, pack] of Object.entries(packs)) {
      if (pack.manifest === undefined) delete packs[name];
    }
    versions[version] = { core, packs };
  }
  return { schemaVersion: SCHEMA_VERSION, versions, blobs };
}

/**
 * The history as the committed file holds it: every object's keys sorted
 * with the default string sort, 2-space JSON, a trailing newline.
 *
 * @example
 * writeFileSync(path, serializeTemplateHistory(history));
 */
export function serializeTemplateHistory(history) {
  return `${JSON.stringify(sortDeep(history), null, 2)}\n`;
}

/** The first `/`-joined key path in `value` whose object keys are unsorted. */
function firstUnsorted(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) return path;
  for (const key of keys) {
    const found = firstUnsorted(value[key], `${path}/${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Problems with the history's pack manifests: each needs its text in `blobs`. */
function manifestBlobProblems(versions, blobs) {
  const problems = [];
  for (const [version, entry] of Object.entries(versions)) {
    const packs =
      isPlainObject(entry) && isPlainObject(entry.packs) ? entry.packs : {};
    for (const [name, pack] of Object.entries(packs)) {
      const manifest = isPlainObject(pack) ? pack.manifest : undefined;
      if (typeof manifest === "string" && !Object.hasOwn(blobs, manifest)) {
        problems.push(
          `versions/${version}/packs/${name}: manifest ${manifest} has no entry in blobs -- regenerate with node bin/build-template-history.mjs`,
        );
      }
    }
  }
  return problems;
}

/**
 * Checks a committed template history's `text`: it must be non-empty JSON of
 * `schemaVersion` 1 with `versions` and `blobs` objects, every key sorted
 * (in the serializer's exact format), every blob keyed by the sha256 of its
 * text, every pack manifest's text present in `blobs`, and every `## [x.y.z]` release heading of `changelogText` present
 * in `versions` -- except `currentVersion`, the release being cut, whose tag
 * does not exist yet. A `text` of `null` means the file at `path` is
 * missing: one problem naming it and the regeneration command. Needs no git.
 * Returns the problems found.
 *
 * @example
 * const problems = checkTemplateHistory({ text, changelogText, currentVersion: "1.5.0" });
 * if (problems.length > 0) process.exitCode = 1;
 */
export function checkTemplateHistory({
  text,
  path = "the template history",
  changelogText,
  currentVersion,
}) {
  if (text === null) {
    return [
      `${path} is missing -- generate it with node bin/build-template-history.mjs`,
    ];
  }
  if (text.trim() === "") return ["the template history is empty"];
  let history;
  try {
    history = JSON.parse(text);
  } catch (cause) {
    return [`the template history is not valid JSON (${cause.message})`];
  }
  if (!isPlainObject(history)) {
    return ["the template history is not a JSON object"];
  }
  const problems = [];
  if (history.schemaVersion !== SCHEMA_VERSION) {
    problems.push(
      `schemaVersion is ${JSON.stringify(history.schemaVersion)}, expected ${String(SCHEMA_VERSION)}`,
    );
  }
  const versions = isPlainObject(history.versions) ? history.versions : {};
  if (!isPlainObject(history.versions)) {
    problems.push("versions is not an object");
  }
  const blobs = isPlainObject(history.blobs) ? history.blobs : {};
  if (!isPlainObject(history.blobs)) problems.push("blobs is not an object");

  const unsorted = firstUnsorted(history, "");
  if (unsorted !== undefined) {
    problems.push(
      `keys are not sorted at ${unsorted === "" ? "the top level" : unsorted} -- regenerate with node bin/build-template-history.mjs`,
    );
  } else if (text !== serializeTemplateHistory(history)) {
    problems.push(
      "the file is not formatted as the generator writes it -- regenerate with node bin/build-template-history.mjs",
    );
  }

  for (const [key, blob] of Object.entries(blobs)) {
    if (typeof blob !== "string" || sha256(blob) !== key) {
      problems.push(`blob ${key} is not keyed by the sha256 of its text`);
    }
  }

  problems.push(...manifestBlobProblems(versions, blobs));

  for (const match of changelogText.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) {
    const version = match[1];
    if (version !== currentVersion && !Object.hasOwn(versions, version)) {
      problems.push(
        `released version ${version} (CHANGELOG.md) is missing from versions -- regenerate with node bin/build-template-history.mjs`,
      );
    }
  }
  return problems;
}

/**
 * Throws an `Error` unless `history` (as {@link buildTemplateHistory}
 * returns it) is fit to write: it must record at least one version, and its
 * serialized form must pass {@link checkTemplateHistory} (without the
 * changelog check). The generator calls it before writing, so a clone
 * without release tags never replaces the committed file.
 *
 * @example
 * const history = buildTemplateHistory({ repoDir });
 * assertBuildable(history); // throws on a tag-less clone
 * writeFileSync(path, serializeTemplateHistory(history));
 */
export function assertBuildable(history) {
  if (Object.keys(history.versions).length === 0) {
    throw new Error(
      "no stable release tags found, so the template history would record no versions -- fetch the tags first (git fetch --tags) and re-run",
    );
  }
  const problems = checkTemplateHistory({
    text: serializeTemplateHistory(history),
    changelogText: "",
    currentVersion: "",
  });
  if (problems.length > 0) {
    throw new Error(
      `the built template history is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
}
