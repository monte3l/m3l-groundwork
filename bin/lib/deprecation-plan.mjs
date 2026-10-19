// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A pure planner for deprecating superseded npm versions, for
 * `bin/deprecate-superseded.mjs`: given an already-fetched packument, it
 * decides which versions older than `latest` still need a
 * `Superseded by <latest>. Use <name>@latest.` message -- the exact wording
 * the versions deprecated by hand before this script already carry. `<name>`
 * is the packument's `name`, or `@monte3l/groundwork` when it has none.
 *
 * No filesystem, no network -- the packument arrives as an argument and the
 * result is a plain data plan, so the I/O wrapper can dry-run it and the
 * logic is tested in isolation. The plan is deterministic (sorted ascending by
 * SemVer precedence) and never mutates its input.
 *
 * Every version older than `latest` that carries no `deprecated` field is
 * planned, prereleases included. A version that already has a message keeps
 * it. The planner refuses (an empty plan plus a reason) when `latest` is
 * missing, is a prerelease, is itself deprecated, or when any version string
 * is not valid SemVer -- a plan built over a packument it cannot fully order
 * would be a guess.
 *
 * SemVer precedence is hand-rolled because the repo adds no `semver`
 * dependency for this.
 */

// The package the wrapper deprecates; the message falls back to it when a
// packument carries no `name`.
const DEFAULT_NAME = "@monte3l/groundwork";

// SemVer 2.0's own grammar (semver.org): no leading zeros in numeric parts or
// numeric prerelease identifiers, optional prerelease and build metadata.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * @typedef {object} ParsedVersion
 * @property {[bigint, bigint, bigint]} core
 * @property {string[]} prerelease
 */

/**
 * @param {string} version
 * @returns {ParsedVersion | null}
 */
function parse(version) {
  const m = typeof version === "string" ? SEMVER.exec(version) : null;
  if (m === null) return null;
  return {
    core: [BigInt(m[1] ?? "0"), BigInt(m[2] ?? "0"), BigInt(m[3] ?? "0")],
    prerelease: m[4] === undefined ? [] : m[4].split("."),
  };
}

/**
 * @param {bigint | string} a
 * @param {bigint | string} b
 * @returns {-1 | 0 | 1}
 */
function sign(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return sign(BigInt(a), BigInt(b));
  // A numeric identifier always has lower precedence than an alphanumeric one.
  if (aNum) return -1;
  if (bNum) return 1;
  return sign(a, b);
}

/**
 * Compares two versions by SemVer 2.0 precedence. Build metadata is ignored.
 *
 * @example
 * compareSemver("1.0.0-rc.2", "1.0.0-rc.10"); // -1
 * compareSemver("1.0.0", "1.0.0-rc.8"); // 1
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 * @throws {TypeError} when either argument is not a valid SemVer version
 *   (`"1.0"`, `"v1.0.0"` and `"01.0.0"` are all invalid).
 */
export function compareSemver(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null) throw new TypeError(`invalid version: ${JSON.stringify(a)}`);
  if (pb === null) throw new TypeError(`invalid version: ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i++) {
    const c = sign(pa.core[i] ?? 0n, pb.core[i] ?? 0n);
    if (c !== 0) return c;
  }
  // A release outranks any prerelease of the same core version.
  const aRelease = pa.prerelease.length === 0;
  const bRelease = pb.prerelease.length === 0;
  if (aRelease && bRelease) return 0;
  if (aRelease) return 1;
  if (bRelease) return -1;
  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdentifier(pa.prerelease[i] ?? "", pb.prerelease[i] ?? "");
    if (c !== 0) return c;
  }
  // A longer set of prerelease fields outranks a shorter equal prefix.
  return sign(BigInt(pa.prerelease.length), BigInt(pb.prerelease.length));
}

/**
 * @typedef {object} Packument
 * @property {string} [name]
 * @property {{ latest?: string }} "dist-tags"
 * @property {Record<string, { deprecated?: string }>} versions
 */

/**
 * @typedef {object} DeprecationPlan
 * @property {string | null} target The `latest` version every planned
 *   version is superseded by, or `null` when there is none.
 * @property {{ version: string, message: string }[]} deprecate Versions to
 *   deprecate, ascending by SemVer precedence.
 * @property {string[]} alreadyDeprecated Versions older than `latest` that
 *   already carry a message (left untouched).
 * @property {string} [refused] Why no plan could be made; `deprecate` is
 *   then empty.
 */

/**
 * @param {string | null} target
 * @param {string} reason
 * @returns {DeprecationPlan}
 */
function refuse(target, reason) {
  return { target, deprecate: [], alreadyDeprecated: [], refused: reason };
}

/**
 * Plans which versions to deprecate as superseded by `latest`.
 *
 * @example
 * const plan = planDeprecations({
 *   name: "@monte3l/groundwork",
 *   "dist-tags": { latest: "1.0.4" },
 *   versions: { "1.0.3": {}, "1.0.4": {} },
 * });
 * // plan.deprecate: [{ version: "1.0.3",
 * //   message: "Superseded by 1.0.4. Use @monte3l/groundwork@latest." }]
 *
 * @param {Packument} packument
 * @returns {DeprecationPlan}
 */
export function planDeprecations(packument) {
  const latest = packument?.["dist-tags"]?.latest;
  const versions = packument?.versions ?? {};
  if (typeof latest !== "string" || latest === "") {
    return refuse(null, "the packument has no `latest` dist-tag");
  }
  const parsedLatest = parse(latest);
  if (parsedLatest === null) {
    return refuse(latest, `\`latest\` (${latest}) is not a valid version`);
  }
  if (parsedLatest.prerelease.length > 0) {
    return refuse(latest, `\`latest\` (${latest}) is a prerelease`);
  }
  const invalid = Object.keys(versions).filter((v) => parse(v) === null);
  if (invalid.length > 0) {
    return refuse(
      latest,
      `invalid version string(s) in the packument: ${invalid.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }
  if (versions[latest]?.deprecated !== undefined) {
    return refuse(latest, `\`latest\` (${latest}) is itself deprecated`);
  }

  const older = Object.keys(versions)
    .filter((v) => compareSemver(v, latest) < 0)
    .sort(compareSemver);
  const name =
    typeof packument?.name === "string" && packument.name !== ""
      ? packument.name
      : DEFAULT_NAME;
  const message = `Superseded by ${latest}. Use ${name}@latest.`;
  return {
    target: latest,
    deprecate: older
      .filter((v) => versions[v]?.deprecated === undefined)
      .map((version) => ({ version, message })),
    alreadyDeprecated: older.filter(
      (v) => versions[v]?.deprecated !== undefined,
    ),
  };
}

/**
 * Builds the single `npm deprecate` spec for a list of exact versions: the
 * package name on the first, the rest joined with `||`. Exact versions, never
 * an operator range, so a version that already has its own message is never
 * matched.
 *
 * @example
 * buildDeprecateRange("@monte3l/groundwork", ["1.0.3", "1.0.2"]);
 * // "@monte3l/groundwork@1.0.3 || 1.0.2"
 *
 * @param {string} name
 * @param {string[]} versions
 * @returns {string}
 */
export function buildDeprecateRange(name, versions) {
  return `${name}@${versions.join(" || ")}`;
}
