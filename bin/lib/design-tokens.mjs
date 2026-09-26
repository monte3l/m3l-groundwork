// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A small, zero-dependency DTCG (Design Tokens Community Group, 2025.10)
 * resolver for m3l-design's `design/source/dtcg/*.tokens.json` files, plus
 * flatteners that turn a resolved token tree into the flat, dashed-name
 * token lists `bin/build-design-tokens.mjs` writes into `design/tokens.css`.
 *
 * This module only understands the token shapes m3l-design's resolver
 * actually uses (`design/source/dtcg/m3l.resolver.json`): color, dimension,
 * duration, number, cubicBezier, shadow (an array of layers), fontFamily
 * (an array of strings), fontWeight and typography (a composite whose
 * fields are themselves aliases or literals). It is not a general DTCG
 * implementation -- there is no fallback for a token shape m3l-design does
 * not emit; every formatter validates its input's shape and throws
 * `DesignTokenError` rather than interpolating `undefined` into CSS.
 *
 * Alias resolution walks a MERGED tree (primitives + semantic + one theme +
 * one motion context + components, in the resolver's own resolutionOrder),
 * so an alias like `{color.accent.default}` finds whichever source last
 * defined `color.accent.default` in that order. `loadDesignSystem` checks
 * `m3l.resolver.json` itself still declares that same order (and the same
 * set/modifier names) before `resolveTheme` ever hard-codes it -- an
 * upstream re-sync that reorders or renames one of them fails loudly here,
 * rather than silently merging in the wrong precedence.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Thrown for anything wrong with the token data itself: a broken alias
 * chain (a cycle, or a path with no token at it), a value that doesn't
 * match the shape its formatter expects, or a resolver manifest that no
 * longer matches what this module hard-codes. */
export class DesignTokenError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DesignTokenError";
  }
}

const ALIAS_RE = /^\{([^{}]+)\}$/;

/** True when `node` is a DTCG token leaf (has its own `$value`). */
function isLeaf(node) {
  return (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    Object.hasOwn(node, "$value")
  );
}

/**
 * Deep-merges two DTCG trees. A leaf in `b` fully replaces whatever was at
 * the same path in `a` (a theme or motion context overriding a default); a
 * group present in BOTH extends key by key, and a `$`-prefixed key at group
 * level (`$schema`, `$description`, a group's own `$type` marker) is dropped
 * during that walk -- it is file metadata, not part of the token tree. A
 * subtree that exists in only one of the two trees is carried over
 * untouched (including any `$` keys of its own): there is nothing to merge
 * it against, and every reader below already skips `$` keys on its own walk.
 */
function mergeTwo(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (isLeaf(a) || isLeaf(b)) return b;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) ||
    Array.isArray(b)
  ) {
    return b;
  }
  const out = { ...a };
  for (const key of Object.keys(b)) {
    if (key.startsWith("$")) continue;
    out[key] = mergeTwo(a[key], b[key]);
  }
  return out;
}

/** Deep-merges any number of DTCG trees, left to right (last one wins). */
export function mergeTokenTrees(...trees) {
  return trees.reduce((acc, tree) => mergeTwo(acc, tree), {});
}

/** Walks a dotted alias path (`color.accent.default`) through a tree. */
function getPath(tree, dottedPath) {
  let node = tree;
  for (const part of dottedPath.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Reads one leaf's resolved `$value` off `tree` by dotted path, for the
 * handful of single, well-known leaves the build script reads directly
 * (`line-height.base`, `font-weight.bold`, `font-family.sans`, ...) rather
 * than through `flattenFamily`. Throws `DesignTokenError` naming the exact
 * path when it's missing, instead of a bare `Cannot read properties of
 * undefined` a few frames further down.
 */
export function requireLeafValue(tree, dottedPath) {
  const node = getPath(tree, dottedPath);
  if (!isLeaf(node)) {
    throw new DesignTokenError(
      `design/source/dtcg: no token at "${dottedPath}"`,
    );
  }
  return node.$value;
}

/**
 * Resolves one `$value` (recursively: a composite's fields, or an array's
 * items, may themselves be aliases). `stack` is the chain of alias paths
 * resolved so far, purely for cycle detection and error messages.
 */
function resolveValue(tree, value, stack) {
  if (typeof value === "string") {
    const match = ALIAS_RE.exec(value);
    if (!match) return value;
    const aliasPath = match[1];
    if (stack.includes(aliasPath)) {
      throw new DesignTokenError(
        `alias cycle: ${[...stack, aliasPath].join(" -> ")}`,
      );
    }
    const target = getPath(tree, aliasPath);
    if (!isLeaf(target)) {
      throw new DesignTokenError(
        `missing alias target {${aliasPath}}` +
          (stack.length > 0 ? ` (via ${stack.join(" -> ")})` : ""),
      );
    }
    return resolveValue(tree, target.$value, [...stack, aliasPath]);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(tree, item, stack));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveValue(tree, item, stack);
    }
    return out;
  }
  return value;
}

/**
 * Returns a copy of `tree` with every leaf's `$value` fully resolved (no
 * alias strings left anywhere in it). Throws `DesignTokenError` on the
 * first cycle or missing alias found, rather than resolving everything
 * else and reporting partial results -- a design system with one broken
 * alias should fail the build, not ship a silently-wrong token.
 */
export function resolveTree(tree) {
  function walk(node) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return node;
    }
    if (isLeaf(node)) {
      return { ...node, $value: resolveValue(tree, node.$value, []) };
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("$")) {
        out[key] = value;
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  }
  return walk(tree);
}

/** Reads and JSON-parses one DTCG file under `dtcgDir`, naming the file in
 * both a missing-file and a malformed-JSON error. */
async function readTokenFile(dtcgDir, filename) {
  const file = path.join(dtcgDir, filename);
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new DesignTokenError(`${file}: invalid JSON`, { cause });
  }
}

// The merge order `resolveTheme` hard-codes below, expressed the same way
// m3l.resolver.json's own `resolutionOrder` does (a `$ref` per entry) --
// `assertResolverShape` checks the manifest still agrees with this before
// any theme is resolved, so a re-sync that reorders or renames a set or
// modifier fails at load time rather than silently merging in the wrong
// precedence.
const EXPECTED_RESOLUTION_ORDER = [
  "#/sets/primitives",
  "#/sets/semantic",
  "#/modifiers/theme",
  "#/modifiers/motion",
  "#/sets/components",
];

// The exact file `loadDesignSystem` reads for each set and each
// theme/motion context, cross-checked against the resolver manifest's own
// `sources`/context `$ref`s by `assertResolverShape` -- a re-sync that
// points a set or context at a different file, or adds a second source to
// one, fails at load time instead of silently merging the STALE hard-coded
// file in that set's place.
const EXPECTED_SET_FILES = {
  primitives: "primitives.tokens.json",
  semantic: "semantic.tokens.json",
  components: "components.tokens.json",
};
const EXPECTED_THEME_FILES = {
  light: "theme-light.tokens.json",
  dark: "theme-dark.tokens.json",
};
const EXPECTED_MOTION_FILES = {
  default: "motion-default.tokens.json",
  reduced: "motion-reduced.tokens.json",
};

/** Throws unless `refs` (a resolver `sources` or context array) is exactly one `{$ref: expectedFile}`. */
function assertSingleRef(refs, expectedFile, label) {
  const actual = (Array.isArray(refs) ? refs : []).map((entry) => entry?.$ref);
  if (actual.length !== 1 || actual[0] !== expectedFile) {
    throw new DesignTokenError(
      `m3l.resolver.json: ${label} is ${JSON.stringify(actual)}, expected exactly ["${expectedFile}"] -- update loadDesignSystem()'s hard-coded filenames to match before regenerating`,
    );
  }
}

/**
 * Validates that `resolver` (the parsed `m3l.resolver.json`) still declares
 * the exact sets, modifiers, theme/motion contexts, resolution order and
 * per-set/per-context source file `loadDesignSystem`/`resolveTheme`
 * hard-code. Throws `DesignTokenError` naming what changed.
 */
function assertResolverShape(resolver) {
  if (
    resolver === null ||
    typeof resolver !== "object" ||
    Array.isArray(resolver)
  ) {
    throw new DesignTokenError(
      `m3l.resolver.json: expected a JSON object, got ${JSON.stringify(resolver)}`,
    );
  }
  const setNames = Object.keys(resolver.sets ?? {});
  if (setNames.join(",") !== "primitives,semantic,components") {
    throw new DesignTokenError(
      `m3l.resolver.json: unexpected sets ${JSON.stringify(setNames)} (resolveTheme expects primitives, semantic, components)`,
    );
  }
  for (const [set, file] of Object.entries(EXPECTED_SET_FILES)) {
    assertSingleRef(resolver.sets[set]?.sources, file, `sets.${set}.sources`);
  }
  const modifierNames = Object.keys(resolver.modifiers ?? {});
  if (modifierNames.join(",") !== "theme,motion") {
    throw new DesignTokenError(
      `m3l.resolver.json: unexpected modifiers ${JSON.stringify(modifierNames)} (resolveTheme expects theme, motion)`,
    );
  }
  const themeContexts = Object.keys(
    resolver.modifiers.theme?.contexts ?? {},
  ).sort();
  if (themeContexts.join(",") !== "dark,light") {
    throw new DesignTokenError(
      `m3l.resolver.json: unexpected theme contexts ${JSON.stringify(themeContexts)} (resolveTheme expects light, dark)`,
    );
  }
  for (const [theme, file] of Object.entries(EXPECTED_THEME_FILES)) {
    assertSingleRef(
      resolver.modifiers.theme.contexts[theme],
      file,
      `modifiers.theme.contexts.${theme}`,
    );
  }
  const motionContexts = Object.keys(
    resolver.modifiers.motion?.contexts ?? {},
  ).sort();
  if (motionContexts.join(",") !== "default,reduced") {
    throw new DesignTokenError(
      `m3l.resolver.json: unexpected motion contexts ${JSON.stringify(motionContexts)} (resolveTheme expects default, reduced)`,
    );
  }
  for (const [motion, file] of Object.entries(EXPECTED_MOTION_FILES)) {
    assertSingleRef(
      resolver.modifiers.motion.contexts[motion],
      file,
      `modifiers.motion.contexts.${motion}`,
    );
  }
  const actualOrder = (resolver.resolutionOrder ?? []).map(
    (entry) => entry?.$ref,
  );
  const sameOrder =
    actualOrder.length === EXPECTED_RESOLUTION_ORDER.length &&
    actualOrder.every((ref, i) => ref === EXPECTED_RESOLUTION_ORDER[i]);
  if (!sameOrder) {
    throw new DesignTokenError(
      `m3l.resolver.json: resolutionOrder is ${JSON.stringify(actualOrder)}, expected ${JSON.stringify(EXPECTED_RESOLUTION_ORDER)} -- update resolveTheme() to match before regenerating`,
    );
  }
}

/**
 * Loads every `design/source/dtcg/*.tokens.json` file and the resolver
 * manifest itself, unmerged -- callers combine them per `resolveTheme`.
 * Validates the manifest's own shape (`assertResolverShape`) before
 * returning, so a mismatch is caught once, at load time, rather than once
 * per `resolveTheme` call.
 */
export async function loadDesignSystem(dtcgDir) {
  const [
    resolver,
    primitives,
    semantic,
    components,
    themeLight,
    themeDark,
    motionDefault,
    motionReduced,
  ] = await Promise.all([
    readTokenFile(dtcgDir, "m3l.resolver.json"),
    readTokenFile(dtcgDir, "primitives.tokens.json"),
    readTokenFile(dtcgDir, "semantic.tokens.json"),
    readTokenFile(dtcgDir, "components.tokens.json"),
    readTokenFile(dtcgDir, "theme-light.tokens.json"),
    readTokenFile(dtcgDir, "theme-dark.tokens.json"),
    readTokenFile(dtcgDir, "motion-default.tokens.json"),
    readTokenFile(dtcgDir, "motion-reduced.tokens.json"),
  ]);
  assertResolverShape(resolver);
  return {
    resolver,
    primitives,
    semantic,
    components,
    themes: { light: themeLight, dark: themeDark },
    motion: { default: motionDefault, reduced: motionReduced },
  };
}

/**
 * Merges and resolves the tree for one theme/motion combination, following
 * `m3l.resolver.json`'s own `resolutionOrder` (`assertResolverShape`, above,
 * is what keeps this hard-coded order honest): primitives, then semantic,
 * then the theme context, then the motion context, then components.
 */
export function resolveTheme(system, themeId, motionId) {
  if (!Object.hasOwn(system.themes, themeId)) {
    throw new DesignTokenError(`unknown theme "${themeId}"`);
  }
  if (!Object.hasOwn(system.motion, motionId)) {
    throw new DesignTokenError(`unknown motion context "${motionId}"`);
  }
  const merged = mergeTokenTrees(
    system.primitives,
    system.semantic,
    system.themes[themeId],
    system.motion[motionId],
    system.components,
  );
  return resolveTree(merged);
}

/** True when a resolved value is a DTCG color literal (`{colorSpace, components, hex}`). */
export function isColorValue(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.hex === "string" &&
    Array.isArray(value.components) &&
    value.components.length === 3 &&
    value.components.every((c) => typeof c === "number")
  );
}

/**
 * Formats a resolved DTCG color value (`{colorSpace, components, hex,
 * alpha?}`) as CSS: plain hex, or `rgba()` with the alpha fixed to 2
 * decimal places (matching m3l-design's own flattened `tokens.json`, e.g.
 * `rgba(0, 0, 0, 0.40)` rather than `0.4`). Throws `DesignTokenError` for
 * anything not color-shaped, rather than interpolating `undefined`.
 */
export function formatColor(value) {
  if (!isColorValue(value)) {
    throw new DesignTokenError(
      `not a DTCG color value: ${JSON.stringify(value)}`,
    );
  }
  if (typeof value.alpha === "number" && value.alpha < 1) {
    const [r, g, b] = value.components.map((c) => Math.round(c * 255));
    return `rgba(${r}, ${g}, ${b}, ${value.alpha.toFixed(2)})`;
  }
  return value.hex;
}

// Units that name a moment/interval rather than a length -- kept on a zero
// value (`0ms`, `0s`) because `transition-duration: 0;` is not the same
// unambiguous shorthand `margin: 0;` is, and m3l-design's own flattened
// `tokens.json` keeps `ms` on `duration-instant` for the same reason. Every
// length unit m3l-design uses (`px`, `rem`, `em`, `%`) drops it instead.
const DURATION_UNITS = new Set(["ms", "s"]);

/**
 * Formats a resolved DTCG dimension/duration value (`{value, unit}`) as
 * CSS. A zero LENGTH is unitless (`0`, not `0rem`); a zero DURATION keeps
 * its unit (`0ms`, not `0`) -- see `DURATION_UNITS`. Throws
 * `DesignTokenError` for anything not dimension-shaped.
 */
export function formatDimension(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.value !== "number" ||
    typeof value.unit !== "string"
  ) {
    throw new DesignTokenError(
      `not a DTCG dimension/duration value: ${JSON.stringify(value)}`,
    );
  }
  if (value.value === 0 && !DURATION_UNITS.has(value.unit)) return "0";
  return `${value.value}${value.unit}`;
}

/** Formats a resolved DTCG cubicBezier value (`[x1, y1, x2, y2]`) as CSS. */
export function formatEasing(value) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new DesignTokenError(
      `not a DTCG cubicBezier value: ${JSON.stringify(value)}`,
    );
  }
  return `cubic-bezier(${value.join(", ")})`;
}

/**
 * Formats one resolved DTCG shadow layer as a CSS `box-shadow` segment.
 * `spread` is always written, including a zero one (`0 1px 2px 0 …`) --
 * matching m3l-design's own flattened `tokens.json`, which never omits it.
 */
function formatShadowLayer(layer) {
  return [
    formatDimension(layer.offsetX),
    formatDimension(layer.offsetY),
    formatDimension(layer.blur),
    formatDimension(layer.spread),
    formatColor(layer.color),
  ].join(" ");
}

/** Formats a resolved DTCG shadow value (an array of layers) as CSS. */
export function formatShadow(value) {
  if (!Array.isArray(value)) {
    throw new DesignTokenError(
      `not a DTCG shadow value: ${JSON.stringify(value)}`,
    );
  }
  return value.map(formatShadowLayer).join(", ");
}

/**
 * Walks every leaf under `node` (a subtree of a resolved tree, e.g.
 * `tree.color`), yielding `{ path, value }` pairs where `path` is the
 * dotted alias path from `node`'s own root (`amber.50`, `surface.default`).
 * Used by every flattener below so the dashed CSS/token name is always
 * built the same way: `prefix + '-' + path.replace(/\./g, '-')`.
 */
function* walkLeaves(node, prefix = []) {
  if (node === null || typeof node !== "object") return;
  if (isLeaf(node)) {
    yield { path: prefix.join("."), value: node.$value };
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    yield* walkLeaves(value, [...prefix, key]);
  }
}

/**
 * Dashes a dotted alias path into the flat token-name convention (`a.b` ->
 * `a-b`), prefixed by `prefix` (`"space"` + `"0-5"` -> `"space-0-5"`). An
 * empty `prefix` is used when the path already carries its own leading
 * group name (`flattenColors`'s whole-tree scan), and is dropped rather
 * than left as a leading dash.
 */
function dashName(prefix, dottedPath) {
  const dashed = dottedPath.replaceAll(".", "-");
  if (prefix.length === 0) return dashed;
  return dottedPath.length > 0 ? `${prefix}-${dashed}` : prefix;
}

/** Sorts `[{name, value}]` by name in a fixed, machine-locale-independent order. */
function sortByName(tokens) {
  return tokens.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** Throws `DesignTokenError` if `tokens` (already name-sorted) has two entries sharing a name. */
function assertUniqueNames(tokens, context) {
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].name === tokens[i - 1].name) {
      throw new DesignTokenError(
        `${context}: two different paths both flatten to the name "${tokens[i].name}"`,
      );
    }
  }
}

/**
 * Flattens one family (`space`, `radius`, `duration`, `easing`,
 * `breakpoint`, `z-index`, `border-width`, `focus-ring`, `measure`,
 * `shape`, `inset`, ...) into `[{ name, value }]` with a formatted CSS
 * string value, using `format` to turn each leaf's resolved `$value` into
 * that string. `format` throwing (a value the family isn't actually
 * shaped like `format` expects) is re-thrown as a `DesignTokenError` naming
 * the family and the exact leaf path, not just the bare formatter error.
 */
export function flattenFamily(tree, familyKey, cssPrefix, format) {
  const root = tree[familyKey];
  if (root === undefined) {
    throw new DesignTokenError(`no such token family: ${familyKey}`);
  }
  const tokens = sortByName(
    [...walkLeaves(root)].map(({ path: leafPath, value }) => {
      let formatted;
      try {
        formatted = format(value);
      } catch (cause) {
        throw new DesignTokenError(
          `${familyKey}.${leafPath}: cannot format ${JSON.stringify(value)}`,
          { cause },
        );
      }
      return { name: dashName(cssPrefix, leafPath), value: formatted };
    }),
  );
  assertUniqueNames(tokens, `family "${familyKey}"`);
  return tokens;
}

/**
 * Flattens every color leaf anywhere in a resolved tree -- `tree.color`
 * itself (`color-neutral-50`, `color-surface-default`, ...) and every
 * component group's color aliases (`button-primary-bg`, `badge-neutral-fg`,
 * ...) -- into one `[{ name, value }]` list. Scans every top-level group (a
 * newly added component family needs no update here) and keeps only leaves
 * `isColorValue` accepts; there is no separate non-color skip-list to keep
 * in sync; `formatColor` doing the real shape check makes one redundant.
 */
export function flattenColors(tree) {
  const out = [];
  for (const [group, node] of Object.entries(tree)) {
    if (group.startsWith("$")) continue;
    for (const { path: leafPath, value } of walkLeaves(node, [group])) {
      if (isColorValue(value)) {
        out.push({ name: dashName("", leafPath), value: formatColor(value) });
      }
    }
  }
  const tokens = sortByName(out);
  assertUniqueNames(tokens, "color scan");
  return tokens;
}

// The typography styles m3l-design's brand book documents as a fixed v1
// set (design/source/brand-book.md's "Typography -- Built"); `deriveTypeTreatment`
// throws if the DTCG source is missing any of them, or their own
// `org.monte3l.m3l-design` extension, rather than deriving from however
// many happen to be present.
const STYLE_NAMES = [
  "display",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "body-lg",
  "body",
  "body-strong",
  "label",
  "caption",
  "code",
  "code-strong",
];
const MONO_STYLES = new Set(["code", "code-strong"]);
const EXT_KEY = "org.monte3l.m3l-design";

/** Reads one typography style's resolved node and its `org.monte3l.m3l-design`
 * extension, throwing if either is missing. */
function readStyle(tree, name) {
  const node = tree.typography?.[name];
  if (!isLeaf(node)) {
    throw new DesignTokenError(
      `design/source/dtcg: missing typography style "${name}"`,
    );
  }
  const ext = node.$extensions?.[EXT_KEY];
  if (!ext) {
    throw new DesignTokenError(
      `design/source/dtcg: typography style "${name}" has no ${EXT_KEY} extension`,
    );
  }
  if (typeof node.$value.fontWeight !== "number") {
    throw new DesignTokenError(
      `design/source/dtcg: typography style "${name}" has no resolved fontWeight`,
    );
  }
  return { value: node.$value, ext };
}

/** Reads one required scalar field off a style's extension, throwing if absent. */
function requireExtField(name, ext, key) {
  const value = ext[key];
  if (value === undefined) {
    throw new DesignTokenError(
      `design/source/dtcg: typography style "${name}" ${EXT_KEY}.${key} is missing`,
    );
  }
  return value;
}

/**
 * Distils the per-weight text-treatment scalars m3l-design's brand book
 * documents (letter-spacing grouped by font weight, one shared
 * word-spacing value at weight 400, and the flags every style shares) from
 * the typography styles' own `$extensions`, rather than copying them from
 * the vendored `design/source/tokens.json` -- the DTCG source is
 * canonical per `design/README.md`; `tokens.json` is kept only as a parity
 * oracle.
 *
 * Every style in a (weight, or mono-weight) group must agree on
 * letter-spacing, and every style must share the same style-invariant
 * flags (`fontStyle`, `fontVariantNumeric`, `fontVariantLigatures`,
 * `textAlign`) and the weight-400 sans styles must agree on word-spacing
 * -- if any of that ever stops holding after an upstream token change,
 * this throws `DesignTokenError` naming exactly which field and which
 * styles disagree, rather than silently picking one style's value over
 * another's (word-spacing's `wordSpacingEm` is grouped and validated the
 * same way letter-spacing is, not read from a single style or reduced
 * with `Math.max`).
 */
export function deriveTypeTreatment(tree) {
  const styles = new Map(
    STYLE_NAMES.map((name) => [name, readStyle(tree, name)]),
  );

  function weightKey(name, style) {
    return `${MONO_STYLES.has(name) ? "mono-" : ""}${style.value.fontWeight}`;
  }

  /** Groups every style's `ext[key]` by its weight bucket, throwing if any bucket disagrees. */
  function groupByWeight(key) {
    const groups = new Map();
    for (const [name, style] of styles) {
      const groupKey = weightKey(name, style);
      const value = requireExtField(name, style.ext, key);
      if (!groups.has(groupKey)) groups.set(groupKey, new Map());
      groups.get(groupKey).set(name, value);
    }
    const resolved = new Map();
    for (const [groupKey, byStyle] of groups) {
      const values = new Set(byStyle.values());
      if (values.size > 1) {
        throw new DesignTokenError(
          `design/source/dtcg: typography styles at weight "${groupKey}" disagree on ${key}: ${JSON.stringify(Object.fromEntries(byStyle))}`,
        );
      }
      resolved.set(groupKey, [...values][0]);
    }
    return resolved;
  }

  /** Reads one flag every style must share, throwing if any disagrees. */
  function sharedFlag(key) {
    const byStyle = new Map(
      [...styles].map(([name, style]) => [
        name,
        requireExtField(name, style.ext, key),
      ]),
    );
    const values = new Set(byStyle.values());
    if (values.size > 1) {
      throw new DesignTokenError(
        `design/source/dtcg: typography styles disagree on ${key}: ${JSON.stringify(Object.fromEntries(byStyle))}`,
      );
    }
    return [...values][0];
  }

  const letterSpacing = groupByWeight("letterSpacingEm");
  const wordSpacingByWeight = groupByWeight("wordSpacingEm");
  const wordSpacing = wordSpacingByWeight.get("400");
  if (wordSpacing === undefined) {
    throw new DesignTokenError(
      "design/source/dtcg: no weight-400 sans typography style to read text-word-spacing from",
    );
  }

  // Attached directly to each style so a caller (bin/build-design-tokens.mjs's
  // per-style CSS class renderer) never has to recompute the weight-bucket
  // key itself -- it just reads `styles.get(name).letterSpacingEm`.
  for (const [name, style] of styles) {
    style.letterSpacingEm = letterSpacing.get(weightKey(name, style));
  }

  return {
    styles,
    letterSpacing,
    wordSpacing,
    fontStyle: sharedFlag("fontStyle"),
    fontVariantNumeric: sharedFlag("fontVariantNumeric"),
    fontVariantLigatures: sharedFlag("fontVariantLigatures"),
    textAlign: sharedFlag("textAlign"),
    lineHeight: requireLeafValue(tree, "line-height.base"),
    emphasisWeight: requireLeafValue(tree, "font-weight.bold"),
  };
}

export { STYLE_NAMES, MONO_STYLES };
